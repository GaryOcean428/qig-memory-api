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

// Safety bound on a full-namespace scan. Blob `list` returns folder+uuid order, NOT
// ts, so a GLOBALLY newest-first listing must see every match before it can order
// them — i.e. walk the whole namespace, then sort. A namespace that exceeds this cap
// is the signal that the ts-ordered index (the durable O(order) fix flagged in
// ec484a1's follow-up note) is overdue; until then the newest CAP messages are still
// correctly ordered and only the oldest tail is dropped (and the drop is logged).
const INBOX_SCAN_CAP = 5000;

// Newest-first cursor: the {ts,id} of the last message already returned. The next page
// is everything STRICTLY older, so new (newest) mail arriving between pages never
// shifts the cursor's position — no repeats, no skips — unlike an offset, which an
// insert slides. id is the tie-break so the (ts,id) order is total.
function encodeInboxCursor(ts, id) {
  return Buffer.from(JSON.stringify({ ts, id }), 'utf8').toString('base64url');
}
function decodeInboxCursor(cursor) {
  try {
    const { ts, id } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof ts === 'string' && typeof id === 'string') return { ts, id };
  } catch { /* malformed cursor → treat as first page */ }
  return null;
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
  // recipient. Messages are stored under a case-preserving `to` segment, so
  // `inbox/qig/CCAi/` and `inbox/qig/ccai/` are distinct folders; narrowing to one
  // exact-cased folder silently loses mail addressed to a different casing. Scan the
  // namespace and compare `to` lower-cased instead. (Reported by CCAi 2026-07-18:
  // recipient:"ccai" returned [] while three "CCAi" messages sat unread.)
  const wantRecipient = recipient ? String(recipient).toLowerCase() : null;
  const prefix = namespace ? `${MESSAGE_PREFIX}${namespace}/` : MESSAGE_PREFIX;
  const now = Date.now();

  // 1) Walk EVERY physical page so ordering is GLOBAL, not per-page: blob order is
  // folder+uuid, so sorting a single bounded page only orders WITHIN it and lets a
  // recent message sit past the window (the "message absent from my drain" class).
  // Each page's blobs are read CONCURRENTLY — a sequential scan blew the synapse's
  // poll (ec484a1). Bounded by INBOX_SCAN_CAP.
  const blobs = [];
  let next;
  let truncated = false;
  do {
    const page = await listPrivate({ prefix, limit: 1000, cursor: next });
    blobs.push(...(page.blobs || []));
    next = page.hasMore ? page.cursor : null;
    if (blobs.length >= INBOX_SCAN_CAP) { truncated = true; next = null; }
  } while (next);
  const items = await Promise.all(
    blobs.map((blob) => readPrivateJson(blob.pathname).then((r) => r?.data ?? null).catch(() => null)),
  );

  // 2) Filter (recipient / broadcast / status / expiry).
  const matches = [];
  for (const message of items) {
    if (!message) continue;
    const to = typeof message.to === 'string' ? message.to.toLowerCase() : '';
    if (wantRecipient && to !== wantRecipient && !(include_broadcast && to === 'broadcast')) continue;
    if (!include_broadcast && to === 'broadcast') continue;
    if (status && message.status !== status) continue;
    if (message.expires_at && Date.parse(message.expires_at) <= now) continue;
    matches.push(message);
  }

  // 3) GLOBAL newest-first. Tie-break by id so the (ts,id) cursor is a total order.
  matches.sort((a, b) => b.ts.localeCompare(a.ts) || String(b.id).localeCompare(String(a.id)));

  // 4) Page by ts-cursor: everything STRICTLY older than the cursor position.
  let start = 0;
  if (cursor) {
    const c = decodeInboxCursor(cursor);
    if (c) {
      start = matches.findIndex((m) => m.ts < c.ts || (m.ts === c.ts && String(m.id) < c.id));
      if (start < 0) start = matches.length;
    }
  }
  const messages = matches.slice(start, start + safeLimit);
  const has_more = start + safeLimit < matches.length;
  const last = messages[messages.length - 1];
  const nextCursor = has_more && last ? encodeInboxCursor(last.ts, String(last.id)) : null;

  if (truncated) {
    console.warn(`[inbox-scan-truncated] ${JSON.stringify({ namespace: namespace ?? '*', scanned: blobs.length, cap: INBOX_SCAN_CAP })}`);
  }

  return { messages, cursor: nextCursor, has_more, truncated };
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
