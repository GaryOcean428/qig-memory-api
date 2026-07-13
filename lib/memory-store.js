import { put, list, del } from '@vercel/blob';

// Shared blob-backed memory store. Used by the REST routes, the MCP server and
// the helper-agent tools so the low-level blob semantics live in exactly one
// place (cache-busting on read, overwrite-in-place on write).

export const PREFIX = 'memory/';

export function keyToPath(key) {
  return `${PREFIX}${key}.json`;
}

// Read a record by its full blob path, cache-busting so writers always see
// their own writes (Vercel Blob defaults to a 1-year CDN TTL).
export async function readRecord(path) {
  const result = await list({ prefix: path, limit: 1 });
  if (!result.blobs.length) return null;
  const blob = result.blobs[0];
  const bust = encodeURIComponent(blob.uploadedAt);
  const resp = await fetch(`${blob.url}?v=${bust}`, { cache: 'no-store' });
  const data = await resp.json();
  return { data, blob };
}

// Write (upsert) a record at a full blob path. `allowOverwrite` + max-age 0 are
// required so repeated writes to an existing key don't throw or get CDN-pinned.
export async function writeRecord(path, record) {
  return put(path, JSON.stringify(record), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
}

// ---------------------------------------------------------------------------
// High-level helpers (key-based) — consumed by the MCP server and agent tools.
// ---------------------------------------------------------------------------

export async function getMemory(key) {
  const existing = await readRecord(keyToPath(key));
  if (!existing) return null;
  return { key, ...existing.data, _blob_url: existing.blob.url };
}

export async function putMemory(key, { category, content, source, basin, usefulness } = {}) {
  const path = keyToPath(key);
  const existing = await readRecord(path);
  const prev = existing?.data || {};
  const record = {
    category: category || prev.category || 'uncategorized',
    content: content ?? prev.content ?? '',
    updated: new Date().toISOString(),
    usefulness: usefulness !== undefined ? usefulness : prev.usefulness || 0,
    retrieval_count: prev.retrieval_count || 0,
    source: source || prev.source || null,
    last_retrieved: prev.last_retrieved || null,
    basin: basin || prev.basin || null,
  };
  const blob = await writeRecord(path, record);
  return { key, url: blob.url, ...record };
}

const BLOB_MAX_PAGE = 1000;
// Safety bound so auto-pagination can never loop unboundedly on a huge corpus.
const AUTO_PAGE_CAP = 5000;

function toKeyMeta(b) {
  return {
    key: b.pathname.replace(PREFIX, '').replace('.json', ''),
    uploaded_at: b.uploadedAt instanceof Date ? b.uploadedAt.toISOString() : b.uploadedAt,
    size: b.size,
  };
}

// Fetch a single page, or (when `all`) walk every page via the blob cursor.
// Returns normalized { blobs, hasMore, cursor, complete } regardless of mode so
// callers get consistent pagination metadata.
async function listBlobs({ blobPrefix, limit, cursor, all }) {
  if (!all) {
    const page = await list({ prefix: blobPrefix, limit, cursor });
    return {
      blobs: page.blobs,
      hasMore: page.hasMore,
      cursor: page.cursor || null,
      complete: !page.hasMore,
    };
  }
  const blobs = [];
  let next = cursor;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await list({ prefix: blobPrefix, limit: BLOB_MAX_PAGE, cursor: next });
    blobs.push(...page.blobs);
    next = page.cursor || null;
    if (!page.hasMore) return { blobs, hasMore: false, cursor: null, complete: true };
    if (blobs.length >= AUTO_PAGE_CAP) return { blobs, hasMore: true, cursor: next, complete: false };
  }
}

// List memory records.
//   keysOnly  → returns the COMPLETE key index (auto-paginated) unless the
//               caller is explicitly paging with a cursor. Metadata-only, so
//               walking every page is cheap and avoids the classic
//               "stopped at page 1" trap that breaks agent polling loops.
//   all       → for full-content listing, walk every page in one call.
//   otherwise → a single page; follow the returned `cursor` to continue.
export async function listMemory({
  category,
  prefix = '',
  limit = 100,
  keysOnly = false,
  cursor,
  all = false,
} = {}) {
  const blobPrefix = `${PREFIX}${prefix}`;
  // Key index defaults to fetching everything; explicit cursor opts into paging.
  const walkAll = all || (keysOnly && cursor === undefined);

  const { blobs, hasMore, cursor: nextCursor, complete } = await listBlobs({
    blobPrefix,
    limit: Math.min(limit, BLOB_MAX_PAGE),
    cursor,
    all: walkAll,
  });

  if (keysOnly) {
    return {
      records: blobs.map(toKeyMeta),
      key_count: blobs.length,
      complete,
      has_more: hasMore,
      cursor: nextCursor,
    };
  }

  const fetched = await Promise.all(
    blobs.map(async (blob) => {
      const key = blob.pathname.replace(PREFIX, '').replace('.json', '');
      try {
        const bust = encodeURIComponent(blob.uploadedAt);
        const resp = await fetch(`${blob.url}?v=${bust}`, { cache: 'no-store' });
        const data = await resp.json();
        return { key, ...data };
      } catch {
        return { key, _error: 'parse_failed' };
      }
    }),
  );

  const records = category ? fetched.filter((r) => r.category === category) : fetched;
  return {
    records,
    count: records.length,
    complete,
    has_more: hasMore,
    cursor: nextCursor,
  };
}

export async function deleteMemory(key) {
  const path = keyToPath(key);
  const existing = await list({ prefix: path, limit: 1 });
  if (!existing.blobs.length) return false;
  await del(existing.blobs[0].url);
  return true;
}

// Kernel mesh registry lives in a single memory record (`kernel_registry`).
export async function getKernelRegistry() {
  const data = await getMemory('kernel_registry');
  if (!data || !data.content) return { agents: {}, updated: null };
  try {
    return JSON.parse(data.content);
  } catch {
    return { agents: {}, updated: null };
  }
}
