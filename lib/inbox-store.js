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
// ts-ordered secondary index (see the block comment above listInboxMessages).
const TS_INDEX_PREFIX = 'inbox-ts/';
// Per-namespace "reindex complete" markers live OUTSIDE the index prefix so they
// never appear in an index listing.
const TS_STATE_PREFIX = 'inbox-ts-state/';
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

// ---------------------------------------------------------------------------
// ts-ordered secondary index
//
// Blob `list` returns lexicographic pathname order, so the index encodes the
// listing's TOTAL order — (ts DESC, id DESC), exactly the order the ts-cursor
// pages by — into the pathname itself:
//
//   inbox-ts/{namespace}/{invTs}_{invId}_{expMs}_{toB64}.json
//
//   invTs  — fixed-width zero-padded INVERTED epoch-ms (MAX_TS_MS - ms), so
//            ascending lexicographic order == newest-first.
//   invId  — the message UUID with every hex digit value-inverted (0<->f).
//            Within a same-millisecond tie the cursor predicate compares id
//            DESCENDING; a plain id would sort ASCENDING in blob order and
//            break strict no-dup/no-skip paging across the tie. Hex inversion
//            is an involution, so the real id is recovered by re-applying it.
//   expMs  — expiry epoch-ms, 0 when the message never expires.
//   toB64  — base64url of the case-PRESERVED `to`. Reversible (unlike
//            safeSegment, which collapses '%'/'~'), so the reader can both
//            match recipients case-insensitively AND recompute the exact
//            message pathname. base64url may contain '_', which is why it is
//            the LAST underscore-delimited field.
//
// Everything a listing filters on (ts order, recipient, broadcast, expiry) is
// therefore available from list() METADATA alone — zero index-blob reads on
// the hot path; only CANDIDATE message blobs are fetched (for `status`, which
// mutates and cannot live in an immutable index entry, and for the envelope
// itself). The index blob's CONTENT ({id,to,ts,expires_at,pathname}) exists
// for debuggability and manual repair, not for the read path.
// ---------------------------------------------------------------------------

// 15 digits of epoch-ms covers timestamps to year ~33658 at fixed width.
const MAX_TS_MS = 999999999999999;

// Value-invert lowercase hex digits; fixed-position dashes pass through. An
// involution: applying it twice returns the original id.
function invertHex(value) {
  let out = '';
  for (const ch of String(value)) {
    const v = parseInt(ch, 16);
    out += Number.isNaN(v) || ch === '-' ? ch : (15 - v).toString(16);
  }
  return out;
}

function tsIndexPathFor({ namespace, ts, id, to, expires_at }) {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TS_MS) {
    const error = new Error(`unindexable ts ${JSON.stringify(ts)} for inbox message ${id}`);
    error.code = 'unindexable_ts';
    throw error;
  }
  const invTs = String(MAX_TS_MS - ms).padStart(15, '0');
  const expMs = expires_at ? Date.parse(expires_at) : 0;
  const toB64 = Buffer.from(String(to), 'utf8').toString('base64url');
  return `${TS_INDEX_PREFIX}${namespace}/${invTs}_${invertHex(id)}_${Number.isFinite(expMs) ? expMs : 0}_${toB64}.json`;
}

// Recover { ms, ts, id, to, expMs } from an index pathname. Returns null for
// anything malformed (a foreign blob under the prefix must never crash a poll).
function parseTsIndexPathname(pathname, namespace) {
  const dir = `${TS_INDEX_PREFIX}${namespace}/`;
  if (!pathname.startsWith(dir) || !pathname.endsWith('.json')) return null;
  const parts = pathname.slice(dir.length, -'.json'.length).split('_');
  if (parts.length < 4) return null;
  const [invTs, invId, expStr] = parts;
  if (!/^\d{15}$/.test(invTs)) return null;
  const ms = MAX_TS_MS - Number(invTs);
  let to;
  try {
    to = Buffer.from(parts.slice(3).join('_'), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  return {
    namespace,
    ms,
    ts: new Date(ms).toISOString(),
    id: invertHex(invId),
    to,
    expMs: Number(expStr) || 0,
  };
}

function tsStatePath(namespace) {
  return `${TS_STATE_PREFIX}${namespace}.json`;
}

// Namespaces whose backfill marker has been confirmed. Markers only ever go
// absent -> present, so a positive is cacheable for the life of the process.
const tsIndexReadyCache = new Set();

async function tsIndexMarkersPresent(namespaces) {
  const pending = namespaces.filter((ns) => !tsIndexReadyCache.has(ns));
  if (pending.length === 0) return true;
  const found = await Promise.all(
    pending.map(async (ns) => {
      const marker = await readPrivateJson(tsStatePath(ns)).catch(() => null);
      if (marker?.data?.complete) {
        tsIndexReadyCache.add(ns);
        return true;
      }
      return false;
    }),
  );
  return found.every(Boolean);
}

// Kill switch: set INBOX_TS_INDEX_DISABLED=1 to force every listing back onto
// the full-scan path without a redeploy (the index keeps being WRITTEN so it
// stays complete and reads can be re-enabled at any time).
function tsIndexReadDisabled() {
  const flag = String(process.env.INBOX_TS_INDEX_DISABLED || '').toLowerCase();
  return flag === '1' || flag === 'true';
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
  // The ts-index write is FATAL, and it goes FIRST. A dangling index entry
  // whose message never landed is harmless (the reader skips entries whose
  // message blob is gone), but a message without its index entry is INVISIBLE
  // mail once listings run off the index — the worst failure class for a
  // message bus, and silent. Ordering index -> message -> locator means every
  // partial-failure state is either "nothing visible" or fully consistent,
  // and the sender always learns about a failed send.
  const tsPath = tsIndexPathFor({ namespace: parsed.namespace, ts, id, to: parsed.to, expires_at: envelope.expires_at });
  await writePrivateJson(tsPath, { id, to: parsed.to, ts, expires_at: envelope.expires_at, pathname });
  try {
    await writePrivateJson(pathname, envelope);
  } catch (error) {
    await deletePrivate(tsPath).catch(() => {});
    throw error;
  }
  try {
    await writePrivateJson(indexPath(id), { id, pathname, ts });
  } catch (error) {
    await deletePrivate([pathname, tsPath]).catch(() => {});
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

// Safety bound on a full-namespace scan (the FALLBACK path, used only until a
// namespace's ts-index backfill marker exists). Blob `list` returns folder+uuid
// order, NOT ts, so a GLOBALLY newest-first listing on this path must see every
// match before it can order them — i.e. walk the whole namespace, then sort.
// The newest CAP messages are still correctly ordered and only the oldest tail
// is dropped (and the drop is logged).
const INBOX_SCAN_CAP = 5000;

// Safety bound on the ts-index path: the number of INDEX ENTRIES (pathnames,
// not blob reads) examined per call. Only a status filter that rejects nearly
// everything can push a single page anywhere near this.
const INBOX_INDEX_SCAN_CAP = 20000;

// Message blobs are fetched for candidates in concurrent batches of this size.
const CANDIDATE_READ_BATCH = 32;

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

// The ts-index read path. Streams `inbox-ts/{ns}/` per namespace (blob order ==
// (ts DESC, id DESC), the listing's total order), k-way-merges the namespaces,
// filters recipient/broadcast/expiry from pathname metadata alone, and reads
// ONLY candidate message blobs — O(page), not O(namespace). Preserves every
// full-scan guarantee: global newest-first, strict ts-cursor paging, and a page
// is never empty while matches remain (the fill loop runs until limit+1 matches
// or the index is exhausted — same lesson as lib/paginate-filtered.js).
async function listViaTsIndex({ namespaces, wantRecipient, include_broadcast, status, safeLimit, cursorObj, now }) {
  const cursorMs = cursorObj ? Date.parse(cursorObj.ts) : null;
  const streams = namespaces.map((ns) => ({
    ns,
    prefix: `${TS_INDEX_PREFIX}${ns}/`,
    buffer: [],
    cursor: undefined,
    done: false,
  }));
  const matches = [];
  let scanned = 0;
  let truncated = false;
  let lastExamined = null;

  // Top a stream's buffer back up (skipping unparseable blobs) so the k-way
  // merge can always compare a real head for every non-exhausted stream.
  const refill = async (stream) => {
    while (!stream.done && stream.buffer.length === 0) {
      const page = await listPrivate({ prefix: stream.prefix, limit: 1000, cursor: stream.cursor });
      stream.cursor = page.hasMore ? page.cursor : undefined;
      if (!page.hasMore) stream.done = true;
      for (const blob of page.blobs || []) {
        const entry = parseTsIndexPathname(blob.pathname, stream.ns);
        if (entry) stream.buffer.push(entry);
      }
    }
  };

  while (!truncated && matches.length <= safeLimit) {
    await Promise.all(streams.map(refill));
    if (streams.every((s) => s.done && s.buffer.length === 0)) break;

    // Pull the next batch of CANDIDATE entries in global order. Stop when any
    // stream needs a refill — merging past an empty-but-not-done stream could
    // emit out of order.
    const batch = [];
    const wanted = Math.min(Math.max(safeLimit + 1 - matches.length, 1), CANDIDATE_READ_BATCH);
    while (batch.length < wanted && !truncated) {
      let best = null;
      let starved = false;
      for (const s of streams) {
        if (s.buffer.length === 0) {
          if (!s.done) { starved = true; break; }
          continue;
        }
        // Entry keys ({invTs}_{invId}) are globally unique; comparing (ms asc
        // inverted => ms desc, id desc) picks the newest head.
        const head = s.buffer[0];
        if (!best) { best = s; continue; }
        const b = best.buffer[0];
        if (head.ms > b.ms || (head.ms === b.ms && String(head.id) > String(b.id))) best = s;
      }
      if (starved || !best) break;
      // Cap check BEFORE consuming: every entry that counts as examined must be
      // fully evaluated, or the resume cursor (strictly-older-than
      // lastExamined) would skip the entry that tripped the cap forever.
      if (scanned >= INBOX_INDEX_SCAN_CAP) { truncated = true; break; }
      const entry = best.buffer.shift();
      scanned += 1;
      lastExamined = entry;
      // Cursor: everything STRICTLY older than the (ts,id) position.
      if (cursorObj) {
        const older = entry.ms < cursorMs
          || (entry.ms === cursorMs && String(entry.id) < String(cursorObj.id));
        if (!older) continue;
      }
      const toLower = entry.to.toLowerCase();
      if (wantRecipient && toLower !== wantRecipient && !(include_broadcast && toLower === 'broadcast')) continue;
      if (!include_broadcast && toLower === 'broadcast') continue;
      if (entry.expMs && entry.expMs <= now) continue;
      batch.push(entry);
    }

    if (batch.length > 0) {
      // Only now touch message blobs — and only for candidates. A null read is
      // a stale index entry (message swept/rolled back): skip it.
      const bodies = await Promise.all(
        batch.map((entry) => readPrivateJson(messagePath(entry.namespace, entry.to, entry.id))
          .then((r) => r?.data ?? null)
          .catch(() => null)),
      );
      for (const message of bodies) {
        if (!message) continue;
        if (status && message.status !== status) continue;
        if (message.expires_at && Date.parse(message.expires_at) <= now) continue;
        matches.push(message);
      }
    }
  }

  const messages = matches.slice(0, safeLimit);
  let has_more = matches.length > safeLimit;
  const last = messages[messages.length - 1];
  let nextCursor = has_more && last ? encodeInboxCursor(last.ts, String(last.id)) : null;
  if (truncated && !has_more) {
    // The cap stopped the scan with unexamined entries remaining, so more
    // matches MAY exist. Resume from the last EXAMINED position — the cursor is
    // purely positional, so pointing it past already-rejected entries is safe
    // and strictly better than the full-scan cap (which drops the tail).
    has_more = true;
    const at = lastExamined ?? last;
    nextCursor = at ? encodeInboxCursor(at.ts, String(at.id)) : null;
  }
  if (truncated) {
    console.warn(`[inbox-index-scan-truncated] ${JSON.stringify({ namespaces, scanned, cap: INBOX_INDEX_SCAN_CAP })}`);
  }
  return { messages, cursor: nextCursor, has_more, truncated };
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

  // MIGRATION GATE. The ts-index path serves a namespace only after its
  // backfill marker exists (written by sweepInbox at the end of a provably
  // COMPLETE walk — see the marker logic there). Until then, every listing
  // takes the original full-scan path below, so pre-index mail is never
  // invisible for even one call. Both paths share the same (ts,id) cursor
  // encoding, so a pager can cross the flip mid-walk without dup or skip.
  const wantNamespaces = namespace ? [namespace] : INBOX_NAMESPACES;
  if (!tsIndexReadDisabled()
    && wantNamespaces.every((ns) => INBOX_NAMESPACES.includes(ns))
    && await tsIndexMarkersPresent(wantNamespaces)) {
    const cursorObj = cursor ? decodeInboxCursor(cursor) : null;
    return listViaTsIndex({
      namespaces: wantNamespaces,
      wantRecipient,
      include_broadcast,
      status,
      safeLimit,
      cursorObj,
      now,
    });
  }

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

// Sweep cursors are composite so a multi-call walk can PROVE it can mint the
// backfill markers: { v: 1, c: <blob cursor>, full: <chain started cursor-less
// AND has recorded zero failures AND zero deletions> }. Only a full, clean walk
// may write the markers. Deletions poison the proof because blob-list cursor
// semantics under concurrent deletion are not contractually pathname-anchored:
// if a delete shifted pagination mid-walk, a live message could go unscanned
// while the chain still LOOKED clean — and an unscanned live message would be
// invisible once listings flip to the index. A walk that deleted expired mail
// therefore backfills but does not mint; the NEXT clean walk (hourly cron, or
// an immediate manual inbox_sweep) mints. A legacy raw blob cursor decodes as
// full:false — it cannot prove where its walk started, so it can never mint.
function encodeSweepCursor(blobCursor, full) {
  return Buffer.from(JSON.stringify({ v: 1, c: blobCursor ?? null, full: !!full }), 'utf8').toString('base64url');
}
function decodeSweepCursor(cursor) {
  if (!cursor) return { blobCursor: undefined, full: true };
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (parsed && parsed.v === 1 && typeof parsed.full === 'boolean') {
      return { blobCursor: parsed.c ?? undefined, full: parsed.full };
    }
  } catch { /* not a composite cursor */ }
  return { blobCursor: cursor, full: false };
}

// Mutating ops (deletes, backfill index writes) run in bounded concurrent
// chunks — wide enough that a full migration page (up to 1000 writes) clears
// the route budget, bounded so a mass-expiry page does not fire a thousand
// concurrent deletes at the store.
const SWEEP_WRITE_CHUNK = 32;

// Expiry sweep + ts-index BACKFILL + marker minting, in one walk.
//
// Phase 1 reads the WHOLE page's blobs in a single Promise.all — each read is
// a network round trip (~0.3s), and a sequential scan of a 1000-blob page blew
// the cron route's maxDuration (Vercel Runtime Timeout on
// /api/cron/inbox-sweep, count=22 since 2026-03-15; same class ec484a1 fixed
// in listInboxMessages). Do not re-serialize these reads.
//
// Phase 2 executes the mutations: expired messages are deleted (message +
// locator + ts-index entry); while reindexing is incomplete (or reindex:true),
// every live message gets its ts-index entry (re)written idempotently —
// piggybacked here because the sweep already reads every message blob. When a
// chain that (a) started with NO cursor, (b) reached has_more=false, and
// (c) recorded zero failures AND zero deletions completes, every message that
// existed at walk time is indexed — and every message sent since deploy
// indexed itself in sendInboxMessage — so the per-namespace "reindex complete"
// markers are written and listings flip to the O(page) index path. Until that
// moment listings use the original full scan, so there is NO window of
// invisibility. Pass reindex:true to force a repair pass after the markers
// exist.
export async function sweepInbox({ limit = 250, cursor, reindex = false } = {}) {
  const { blobCursor, full } = decodeSweepCursor(cursor);
  const page = await listPrivate({ prefix: MESSAGE_PREFIX, limit: Math.min(Math.max(limit, 1), 1000), cursor: blobCursor });
  const now = Date.now();
  const markersDone = await tsIndexMarkersPresent(INBOX_NAMESPACES).catch(() => false);
  const backfill = reindex || !markersDone;
  let deleted = 0;
  let indexed = 0;
  const failures = [];
  const blobs = page.blobs || [];

  // Phase 1: concurrent full-page read (see header comment — timeout fix #77).
  const reads = await Promise.all(
    blobs.map((blob) =>
      readPrivateJson(blob.pathname)
        .then((item) => ({ blob, item, error: null }))
        .catch((error) => ({ blob, item: null, error })),
    ),
  );

  // Phase 2: plan the mutations, then run them in bounded concurrent chunks.
  const ops = [];
  for (const { blob, item, error } of reads) {
    if (error) {
      failures.push({ pathname: blob.pathname, error: error?.message || String(error) });
      continue;
    }
    if (!item?.data) continue;
    const message = item.data;
    if (message.expires_at && Date.parse(message.expires_at) <= now) {
      ops.push({
        pathname: blob.pathname,
        run: async () => {
          const paths = [blob.pathname, indexPath(message.id)];
          try {
            paths.push(tsIndexPathFor(message));
          } catch { /* unindexable ts — nothing to clean up */ }
          await deletePrivate(paths);
          deleted += 1;
        },
      });
    } else if (backfill) {
      ops.push({
        pathname: blob.pathname,
        run: async () => {
          // Recompute the message pathname from envelope fields — the SAME
          // derivation the index read path uses. If it does not round-trip to
          // the actual blob, indexing it would make the message unreadable via
          // the index, so record a failure (which also poisons marker minting).
          const derived = messagePath(message.namespace, message.to, message.id);
          if (derived !== blob.pathname) {
            throw new Error(`index derivation mismatch: ${derived} != ${blob.pathname}`);
          }
          await writePrivateJson(
            tsIndexPathFor(message),
            { id: message.id, to: message.to, ts: message.ts, expires_at: message.expires_at ?? null, pathname: blob.pathname },
            { allowOverwrite: true },
          );
          indexed += 1;
        },
      });
    }
  }
  for (let i = 0; i < ops.length; i += SWEEP_WRITE_CHUNK) {
    await Promise.all(ops.slice(i, i + SWEEP_WRITE_CHUNK).map((op) =>
      op.run().catch((error) => {
        failures.push({ pathname: op.pathname, error: error?.message || String(error) });
      })));
  }

  // A clean (zero failures, zero deletions), complete, from-the-start chain
  // proves the index covers everything: mint the markers (idempotent; every
  // namespace at once, since the walk spans the whole `inbox/` prefix).
  const walkClean = full && failures.length === 0 && deleted === 0;
  let reindexComplete = false;
  if (walkClean && !page.hasMore) {
    try {
      await Promise.all(INBOX_NAMESPACES.map((ns) => writePrivateJson(
        tsStatePath(ns),
        { namespace: ns, complete: true, completed_at: new Date().toISOString() },
        { allowOverwrite: true },
      )));
      INBOX_NAMESPACES.forEach((ns) => tsIndexReadyCache.add(ns));
      reindexComplete = true;
    } catch (error) {
      failures.push({ pathname: TS_STATE_PREFIX, error: error?.message || String(error) });
    }
  }

  return {
    scanned: blobs.length,
    deleted,
    indexed,
    failures,
    cursor: page.hasMore ? encodeSweepCursor(page.cursor, walkClean) : null,
    has_more: page.hasMore,
    reindex_complete: reindexComplete,
  };
}
