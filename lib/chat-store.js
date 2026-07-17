import { createHash } from 'node:crypto';
import { deletePrivate, listPrivate, readPrivateJson, writePrivateJson } from './private-blob';

// Server-side chat threads, so a conversation started on a phone is there on a
// laptop. History previously lived only in localStorage, which is per-browser
// per-device by definition — nothing was lost, it simply had no way to travel.
//
// Deliberately its OWN store, not memory records: chat threads in the `memory/`
// namespace would pollute the corpus that agents and the daily reviewer read.
// When something in a chat is worth remembering, the operator asks the agent to
// save it and it becomes a real memory record with a real key.
//
// ONE BLOB PER THREAD (`chat/<user>/<threadId>.json`). A single whole-history
// blob would make two devices last-write-wins over each other: chat on a phone,
// then save on a laptop holding a stale list, and the phone's thread is gone.
// Per-thread records mean concurrent devices only ever collide on the SAME
// thread, and never silently delete a different one.

const PREFIX = 'chat/';
const MAX_THREADS = 100;
const MAX_MESSAGE_BYTES = 512 * 1024;

// Thread ids come from the client (`c_<base36>_<rand>`). Anything outside this
// shape is rejected rather than interpolated into a blob path.
const THREAD_ID = /^[A-Za-z0-9_-]{3,64}$/;

// The user id is a Vercel OAuth `sub` (or email/username fallback) — hashed so
// it is path-safe and stable, and so no identifier is written into a path.
function userScope(userId) {
  if (!userId) throw new Error('a user is required for chat history');
  return createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);
}

function threadPath(userId, threadId) {
  if (!THREAD_ID.test(String(threadId || ''))) {
    const error = new Error('invalid thread id');
    error.code = 'invalid_input';
    throw error;
  }
  return `${PREFIX}${userScope(userId)}/${threadId}.json`;
}

function sanitize(thread) {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const serialized = JSON.stringify(messages);
  if (serialized.length > MAX_MESSAGE_BYTES) {
    const error = new Error('conversation too large');
    error.code = 'payload_too_large';
    throw error;
  }
  return {
    id: thread.id,
    title: typeof thread.title === 'string' ? thread.title.slice(0, 200) : null,
    messages,
    createdAt: Number(thread.createdAt) || Date.now(),
    updatedAt: Number(thread.updatedAt) || Date.now(),
  };
}

/** Every thread for a user, newest first. */
export async function listThreads(userId) {
  const { blobs } = await listPrivate({ prefix: `${PREFIX}${userScope(userId)}/`, limit: MAX_THREADS });
  const threads = await Promise.all(
    blobs.map(async (b) => {
      try {
        const result = await readPrivateJson(b.pathname);
        return result?.data || null;
      } catch {
        // One unreadable thread must not blank the whole sidebar.
        return null;
      }
    }),
  );
  return threads.filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getThread(userId, threadId) {
  const result = await readPrivateJson(threadPath(userId, threadId)).catch(() => null);
  return result?.data || null;
}

export async function saveThread(userId, thread) {
  const record = sanitize(thread);
  await writePrivateJson(threadPath(userId, record.id), record, { allowOverwrite: true });
  return record;
}

export async function deleteThread(userId, threadId) {
  await deletePrivate([threadPath(userId, threadId)]).catch(() => {});
  return { deleted: true, id: threadId };
}

/**
 * One-time migration of a browser's localStorage threads.
 * Merges by id and keeps whichever copy is newer, so running it on a second
 * device cannot roll back work done on the first. Threads already on the server
 * with a newer updatedAt are left untouched.
 */
export async function mergeLocalThreads(userId, localThreads = []) {
  const existing = await listThreads(userId);
  const byId = new Map(existing.map((t) => [t.id, t]));
  const migrated = [];
  for (const raw of localThreads.slice(0, MAX_THREADS)) {
    if (!raw?.id || !THREAD_ID.test(String(raw.id))) continue;
    // An empty scratch thread is not worth migrating.
    if (!Array.isArray(raw.messages) || raw.messages.length === 0) continue;
    const server = byId.get(raw.id);
    if (server && (server.updatedAt || 0) >= (Number(raw.updatedAt) || 0)) continue;
    try {
      migrated.push(await saveThread(userId, raw));
    } catch {
      // Skip a single oversized/corrupt local thread rather than fail the merge.
    }
  }
  return { migrated: migrated.length, threads: await listThreads(userId) };
}
