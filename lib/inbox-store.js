import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  deletePrivate,
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
      await writePrivateJson(current.pathname, updated, {
        allowOverwrite: true,
        ifMatch: current.blob.etag,
      });
      return updated;
    } catch (error) {
      if (error?.name !== 'BlobPreconditionFailedError' || attempt === 3) throw error;
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
  const prefix = namespace
    ? `${MESSAGE_PREFIX}${namespace}/${recipient ? `${safeSegment(recipient)}/` : ''}`
    : MESSAGE_PREFIX;
  const page = await listPrivate({ prefix, limit: Math.min(safeLimit * 4, 1000), cursor });
  const now = Date.now();
  const messages = [];
  for (const blob of page.blobs) {
    if (messages.length >= safeLimit) break;
    const item = await readPrivateJson(blob.pathname);
    if (!item) continue;
    const message = item.data;
    if (recipient && message.to !== recipient && !(include_broadcast && message.to === 'broadcast')) continue;
    if (!include_broadcast && message.to === 'broadcast') continue;
    if (status && message.status !== status) continue;
    if (message.expires_at && Date.parse(message.expires_at) <= now) continue;
    messages.push(message);
  }
  messages.sort((a, b) => b.ts.localeCompare(a.ts));
  return {
    messages,
    cursor: page.cursor ?? null,
    has_more: page.hasMore,
  };
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
