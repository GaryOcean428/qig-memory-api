import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalEtag,
  deletePrivate,
  isPreconditionFailed,
  listPrivate,
  readPrivateJson,
  writePrivateJson,
} from './private-blob';
import { collectFilteredPage } from './paginate-filtered';

export const INBOX_NAMESPACES = ['qig', 'bsuite', 'general'];
const MESSAGE_PREFIX = 'inbox/';
const INDEX_PREFIX = 'inbox-index/';
const MAX_PAYLOAD_BYTES = 256 * 1024;

export const inboxSendSchema = z.object({
  from: z.string().trim().min(1).max(128),
  to: z.string().trim().min(1).max(128),
  namespace: z.enum(INBOX_NAMESPACES).default('general'),
  type: z.string().trim().min(1).max(64),
  subject: z.string().trim().min(1).max(256),
  payload: z.unknown(),
  in_reply_to: z.string().uuid().optional(),
  expires_at: z.string().datetime().optional(),
});

function safeSegment(value) {
  return encodeURIComponent(value).replaceAll('%', '~');
}

function messagePath(namespace, recipient, id) {
  return `${MESSAGE_PREFIX}${namespace}/${safeSegment(recipient)}/${id}.json`;
}

function indexPath(id) {
  return `${INDEX_PREFIX}${id}.json`;
}

function assertPayloadSize(payload) {
  const bytes = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    const error = new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    error.code = 'payload_too_large';
    throw error;
  }
}

export async function sendInboxMessage(input) {
  const parsed = inboxSendSchema.parse(input);
  assertPayloadSize(parsed.payload);
  const id = randomUUID();
  const ts = new Date().toISOString();
  const envelope = {
    id,
    ts,
    ...parsed,
    expires_at: parsed.expires_at ?? null,
    in_reply_to: parsed.in_reply_to ?? null,
    status: 'unread',
    read_at: null,
    acked_at: null,
  };
  const pathname = messagePath(parsed.namespace, parsed.to, id);
  await writePrivateJson(pathname, envelope);
  try {
    await writePrivateJson(indexPath(id), { id, pathname, ts });
  } catch (error) {
    await deletePrivate(pathname).catch(() => {});
    throw error;
  }
  return envelope;
}

async function locateMessage(id) {
  const locator = await readPrivateJson(indexPath(id));
  if (!locator) return null;
  const message = await readPrivateJson(locator.data.pathname);
  return message ? { ...message, pathname: locator.data.pathname } : null;
}

async function transitionMessage(id, target) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await locateMessage(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const existing = current.data;
    if (target === 'read' && existing.status !== 'unread') return existing;
    if (target === 'acked' && existing.status === 'acked') return existing;
    const updated = {
      ...existing,
      status: target,
      read_at: existing.read_at || now,
      acked_at: target === 'acked' ? existing.acked_at || now : existing.acked_at,
    };
    try {
      // The etag comes from head(), not from the get() that loaded the body:
      // a body-bearing read reports an etag that a conditional write rejects
      // once the payload is more than ~1KB. Falling back to no ifMatch would
      // silently drop the concurrency guard, so a missing etag is surfaced.
      const etag = await canonicalEtag(current.pathname);
      if (!etag) throw new Error(`cannot read etag for ${current.pathname}`);
      await writePrivateJson(current.pathname, updated, { allowOverwrite: true, ifMatch: etag });
      return updated;
    } catch (error) {
      // Only a genuine precondition failure is retryable (someone else won the
      // race); everything else must surface.
      if (!isPreconditionFailed(error) || attempt === 3) throw error;
    }
  }
  return null;
}

export async function readInboxMessage(id, { markRead = true } = {}) {
  const found = await locateMessage(id);
  if (!found) return null;
  return markRead ? transitionMessage(id, 'read') : found.data;
}

export function acknowledgeInboxMessage(id) {
  return transitionMessage(id, 'acked');
}

export async function listInboxMessages({
  namespace,
  recipient,
  status,
  include_broadcast = true,
  limit = 50,
  cursor,
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  // Recipient matching is CASE-INSENSITIVE and does NOT narrow the blob prefix by
  // recipient. Messages are stored under a case-preserving `to` segment (safeSegment
  // uses encodeURIComponent), so `inbox/qig/CCAi/` and `inbox/qig/ccai/` are distinct
  // folders. Narrowing the scan to one exact-cased folder silently loses mail when a
  // sender addressed a different casing of the same handle. Scan the namespace and
  // compare `to` lower-cased instead — this also recovers already-stuck mixed-case
  // mail without a data migration. (Reported by CCAi 2026-07-18: recipient:"ccai"
  // returned [] while three messages to "CCAi" sat unread — a false-clean, silent
  // message-loss vector across the whole inbox coordination layer.)
  const wantRecipient = recipient ? String(recipient).toLowerCase() : null;
  const prefix = namespace ? `${MESSAGE_PREFIX}${namespace}/` : MESSAGE_PREFIX;
  const now = Date.now();
  // Recipient / status / expiry are not all encoded in the blob path, so filtering
  // happens AFTER reading each blob. Deriving has_more from a single physical page
  // makes a slice that matches nothing look like an empty page with more to come —
  // and a poller that reads "empty ⇒ nothing for me" silently loses mail (the CCAi
  // false-clean vector). collectFilteredPage walks physical pages until it has a
  // full logical page or the namespace is exhausted, so an empty page means ONLY
  // "no mail left", never "this slice matched nothing". Each page's blobs are read
  // CONCURRENTLY (a sequential scan of a full page took ~30s and blew the synapse's
  // 20s poll — ec484a1); maxPages bounds the scan so a sparse recipient filter over
  // a large namespace cannot run away.
  const { results, cursor: nextCursor, has_more } = await collectFilteredPage({
    fetchPage: (c) => listPrivate({ prefix, limit: safeLimit, cursor: c }),
    readItem: (blob) => readPrivateJson(blob.pathname).then((r) => r?.data ?? null),
    keep: (message) => {
      const to = typeof message.to === 'string' ? message.to.toLowerCase() : '';
      if (wantRecipient && to !== wantRecipient && !(include_broadcast && to === 'broadcast')) return false;
      if (!include_broadcast && to === 'broadcast') return false;
      if (status && message.status !== status) return false;
      if (message.expires_at && Date.parse(message.expires_at) <= now) return false;
      return true;
    },
    limit: safeLimit,
    cursor,
    maxPages: 8,
  });
  const messages = results.sort((a, b) => b.ts.localeCompare(a.ts));
  return { messages, cursor: nextCursor, has_more };
}

export async function sweepInbox({ limit = 250, cursor } = {}) {
  const page = await listPrivate({ prefix: MESSAGE_PREFIX, limit: Math.min(Math.max(limit, 1), 1000), cursor });
  const now = Date.now();
  let deleted = 0;
  const failures = [];
  for (const blob of page.blobs) {
    try {
      const item = await readPrivateJson(blob.pathname);
      if (!item?.data?.expires_at || Date.parse(item.data.expires_at) > now) continue;
      await deletePrivate([blob.pathname, indexPath(item.data.id)]);
      deleted += 1;
    } catch (error) {
      failures.push({ pathname: blob.pathname, error: error?.message || String(error) });
    }
  }
  return {
    scanned: page.blobs.length,
    deleted,
    failures,
    cursor: page.cursor ?? null,
    has_more: page.hasMore,
  };
}
