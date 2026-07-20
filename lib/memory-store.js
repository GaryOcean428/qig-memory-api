import { put, list, del, get } from '@vercel/blob';
// Single source of truth for private-store credentials (static token or OIDC).
import { privateBlobOptions as memoryOptions } from './private-blob';
import { collectFilteredPage } from './paginate-filtered';

async function readPrivateJson(path) {
  const result = await get(path, memoryOptions({ access: 'private', useCache: false }));
  if (!result) return null;
  return { data: await new Response(result.stream).json(), blob: result.blob };
}

// Shared blob-backed memory store. Used by the REST routes, the MCP server and
// the helper-agent tools so the low-level blob semantics live in exactly one
// place (cache-busting on read, overwrite-in-place on write).

export const PREFIX = 'memory/';

// Per-agent kernel records live under this prefix (see per-agent registry below).
export const KERNEL_AGENT_PREFIX = 'kernel_agent_';

// Hard cap on a single record's content, enforced before it reaches Blob. Keeps
// one oversized write from ballooning storage / egress and gives callers a clean
// 413 instead of an opaque downstream failure. ~1 MiB of UTF-8 content.
export const MAX_CONTENT_BYTES = 1024 * 1024;

export class ContentTooLargeError extends Error {
  constructor(bytes) {
    super(`content exceeds ${MAX_CONTENT_BYTES} bytes (got ${bytes})`);
    this.name = 'ContentTooLargeError';
    this.code = 'content_too_large';
    this.bytes = bytes;
    this.max = MAX_CONTENT_BYTES;
  }
}

// Throws ContentTooLargeError when content is over the cap. Returns byte length.
// Non-string content is measured by its serialized form (records may store
// structured JSON content, not just strings).
export function assertContentSize(content) {
  if (content == null) return 0;
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_CONTENT_BYTES) throw new ContentTooLargeError(bytes);
  return bytes;
}

export function keyToPath(key) {
  return `${PREFIX}${key}.json`;
}

// Read a record by its full blob path, cache-busting so writers always see
// their own writes (Vercel Blob defaults to a 1-year CDN TTL).
export async function readRecord(path) {
  return readPrivateJson(path);
}

// Write (upsert) a record at a full blob path. `allowOverwrite` + max-age 0 are
// required so repeated writes to an existing key don't throw or get CDN-pinned.
export async function writeRecord(path, record) {
  return put(path, JSON.stringify(record), memoryOptions({
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  }));
}

// ---------------------------------------------------------------------------
// High-level helpers (key-based) — consumed by the MCP server and agent tools.
// ---------------------------------------------------------------------------

export async function getMemory(key) {
  const existing = await readRecord(keyToPath(key));
  if (!existing) return null;
  return { key, ...existing.data };
}

export async function putMemory(key, { category, content, source, basin, usefulness } = {}) {
  if (content !== undefined) assertContentSize(content);
  const path = keyToPath(key);
  const existing = await readRecord(path);
  const prev = existing?.data || {};
  const record = {
    category: category || prev.category || 'uncategorized',
    content: content ?? prev.content ?? '',
    updated: new Date().toISOString(),
    usefulness: usefulness !== undefined ? usefulness : prev.usefulness || 0,
    retrieval_count: prev.retrieval_count || 0,
    source: source ?? prev.source ?? null,
    last_retrieved: prev.last_retrieved || null,
    basin: basin || prev.basin || null,
  };
  await writeRecord(path, record);
  return { key, ...record };
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
    const page = await list(memoryOptions({ prefix: blobPrefix, limit, cursor }));
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
    const page = await list(memoryOptions({ prefix: blobPrefix, limit: BLOB_MAX_PAGE, cursor: next }));
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

  const readRecord = async (blob) => {
    const key = blob.pathname.replace(PREFIX, '').replace('.json', '');
    try {
      const record = await readPrivateJson(blob.pathname);
      if (!record) return { key, _error: 'not_found' };
      return { key, ...record.data };
    } catch {
      return { key, _error: 'parse_failed' };
    }
  };

  // keysOnly (metadata-only key index) and all=true (explicit full walk) one-shot
  // the whole corpus; an explicit cursor opts keysOnly into paging.
  const walkAll = all || (keysOnly && cursor === undefined);

  // A category filter is applied AFTER reading each blob, so a fixed physical page
  // can filter down to nothing while matches sit on later pages — the "category
  // looks empty" / empty-page-under-pagination trap. When paging a category (i.e.
  // NOT a one-shot all/keysOnly walk), fill the page across physical pages so
  // has_more reflects the corpus, not the storage slice; an empty page then means
  // only "no more matches", never "this slice matched nothing". maxPages bounds the
  // scan so a sparse category over a large corpus cannot run away.
  if (category && !walkAll && !keysOnly) {
    const { results, cursor: nextCursor, has_more, truncated } = await collectFilteredPage({
      fetchPage: (c) =>
        listBlobs({ blobPrefix, limit: Math.min(limit, BLOB_MAX_PAGE), cursor: c, all: false }),
      readItem: readRecord,
      keep: (r) => r.category === category,
      limit,
      cursor,
      maxPages: 25,
      label: `memory:category=${category},prefix=${prefix || '*'}`,
    });
    return { records: results, count: results.length, complete: !has_more, has_more, cursor: nextCursor, truncated };
  }

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

  const fetched = await Promise.all(blobs.map(readRecord));
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
  const existing = await list(memoryOptions({ prefix: path, limit: 1 }));
  if (!existing.blobs.length) return false;
  await del(existing.blobs[0].url, memoryOptions());
  return true;
}

// Partial update (scoring / promote / source / basin). Mirrors POST semantics
// of the REST route but callable directly by the MCP server and agent tools.
export async function postMemory(
  key,
  { usefulness_delta, usefulness_set, source, promoted, basin } = {},
) {
  const existing = await readRecord(keyToPath(key));
  if (!existing) return null;
  const updated = { ...existing.data };
  if (usefulness_delta !== undefined) updated.usefulness = (updated.usefulness || 0) + usefulness_delta;
  if (usefulness_set !== undefined) updated.usefulness = usefulness_set;
  if (source !== undefined) updated.source = source;
  if (promoted !== undefined) {
    updated.promoted = promoted;
    updated.promoted_at = new Date().toISOString();
  }
  if (basin !== undefined) updated.basin = basin;
  updated.updated = new Date().toISOString();
  await writeRecord(keyToPath(key), updated);
  return { key, ...updated };
}

// ---------------------------------------------------------------------------
// Geometry — Fisher-Rao geodesic distance on the probability simplex.
//   d_FR(p, q) = 2 · arccos( Σ_i √(p_i · q_i) )
// This is NOT cosine/Euclidean. Inputs must be non-negative; they are
// renormalized defensively to sum to 1. Returns null for invalid inputs.
// ---------------------------------------------------------------------------
export function fisherRaoDistanceSimplex(p, q) {
  if (!Array.isArray(p) || !Array.isArray(q)) return null;
  const n = Math.min(p.length, q.length);
  if (n === 0) return null;
  let sumP = 0;
  let sumQ = 0;
  for (let i = 0; i < n; i++) {
    sumP += Math.max(0, p[i]);
    sumQ += Math.max(0, q[i]);
  }
  if (sumP <= 0 || sumQ <= 0) return null;
  let bhattacharyya = 0;
  for (let i = 0; i < n; i++) {
    bhattacharyya += Math.sqrt((Math.max(0, p[i]) / sumP) * (Math.max(0, q[i]) / sumQ));
  }
  return 2 * Math.acos(Math.max(0, Math.min(1, bhattacharyya)));
}

// Extract a basin coordinate vector from a record, whether the basin lives on
// `record.basin` directly or embedded in JSON `content` (kernel_state records).
function extractBasin(record) {
  if (!record) return null;
  if (Array.isArray(record.basin)) return record.basin;
  if (Array.isArray(record.basin_coords)) return record.basin_coords;
  if (typeof record.content === 'string') {
    try {
      const parsed = JSON.parse(record.content);
      if (Array.isArray(parsed.basin_coords)) return parsed.basin_coords;
      if (Array.isArray(parsed.basin)) return parsed.basin;
    } catch {
      /* content is not JSON */
    }
  }
  return null;
}

// Split a query into terms: "quoted spans" stay exact, bare words are separate
// terms. A record must contain EVERY term (AND), which is what a caller typing
// `kappa certified` means. The old behaviour matched the whole string as one
// literal substring, so any multi-word query silently returned zero results
// unless that exact phrase existed — and an empty result set reads as "the
// corpus knows nothing about this", which is far more damaging than an
// imprecise one. Single-term queries behave exactly as before, and multi-word
// queries can only match MORE than they used to, so no caller can regress.
export function parseSearchTerms(query) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(query || ''))) !== null) {
    const term = (m[1] ?? m[2] ?? '').toLowerCase().trim();
    if (term) terms.push(term);
  }
  return terms;
}

// Search across the corpus. Filters by category / key-prefix / content terms
// and, when `basin` is provided, ranks results by Fisher-Rao distance to that
// query basin (geometrically-correct nearest-basin recall — the native QIG mode).
export async function searchMemory({
  query,
  category,
  prefix = '',
  basin,
  limit = 20,
} = {}) {
  const { records } = await listMemory({ prefix, all: true });
  const terms = parseSearchTerms(query);

  let matched = records.filter((r) => {
    if (r._error) return false;
    if (category && r.category !== category) return false;
    if (terms.length) {
      const hay = `${r.key} ${r.content || ''} ${r.source || ''}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });

  let mode = 'filter';
  if (Array.isArray(basin) && basin.length) {
    mode = 'basin_nearest';
    matched = matched
      .map((r) => {
        const b = extractBasin(r);
        const distance = b ? fisherRaoDistanceSimplex(basin, b) : null;
        return { ...r, fisher_rao_distance: distance };
      })
      .filter((r) => r.fisher_rao_distance !== null)
      .sort((a, b) => a.fisher_rao_distance - b.fisher_rao_distance);
  }

  return {
    mode,
    geometry: mode === 'basin_nearest' ? 'fisher_rao_simplex' : null,
    total_scanned: records.length,
    match_count: matched.length,
    results: matched.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// Kernel mesh registry.
//
// LEGACY: a single `kernel_registry` blob (read-modify-write of every agent).
// Under concurrent heartbeats this last-writer-wins clobbers peers. The
// per-agent model below stores each agent under its own `kernel_agent_<id>`
// key so heartbeats never contend. `listKernelAgents` folds in any legacy
// registry entries that have not yet been migrated, so no agent is lost.
// ---------------------------------------------------------------------------

// Canonical registry record written by the live QIG mesh. Its `content` is an
// object (sometimes a JSON string) shaped { schema_version, updated, agents: [
//   { id, kind, silo, last_seen, status, basin_coords?, ... } ] }.
export const KERNEL_REGISTRY_KEY = 'qig_agent_registry';

export function agentKey(agentId) {
  return `${KERNEL_AGENT_PREFIX}${String(agentId).replace(/[^a-z0-9_]/gi, '_')}`;
}

// Records may store `content` as an object OR a JSON string; normalize both.
function parseContent(content) {
  if (content == null) return null;
  if (typeof content === 'object') return content;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Map a raw registry agent (live QIG schema) to the normalized shape the mesh
// tools/UI expect. Accepts both the live field names (kind/last_seen) and the
// per-agent record names (substrate/last_heartbeat).
function normalizeAgent(a) {
  const id = a.agent_id || a.id;
  if (!id) return null;
  return {
    agent_id: id,
    substrate: a.substrate || a.kind || null,
    status: a.status || null,
    last_heartbeat: a.last_heartbeat || a.last_seen || null,
    basin_coords: a.basin_coords || null,
    silo: a.silo || null,
    scope_claimed: a.scope_claimed || null,
    mailbox: a.mailbox || null,
  };
}

// Read the canonical registry record and return { agents: {id: normalized}, updated }.
export async function getKernelRegistry() {
  for (const key of [KERNEL_REGISTRY_KEY, 'kernel_registry']) {
    const data = await getMemory(key);
    const parsed = data && parseContent(data.content);
    if (!parsed) continue;
    const list = Array.isArray(parsed.agents)
      ? parsed.agents
      : Object.values(parsed.agents || {});
    if (!list.length && !parsed.updated) continue;
    const agents = {};
    for (const raw of list) {
      const n = normalizeAgent(raw);
      if (n) agents[n.agent_id] = n;
    }
    return { agents, updated: parsed.updated || null };
  }
  return { agents: {}, updated: null };
}

// Write/replace a single agent's record (register + heartbeat both use this).
export async function putKernelAgent(agentId, agent) {
  const record = { ...agent, agent_id: agentId };
  await writeRecord(keyToPath(agentKey(agentId)), {
    category: 'kernel_agent',
    content: JSON.stringify(record),
    updated: new Date().toISOString(),
    usefulness: 0,
    retrieval_count: 0,
    source: 'kernel_mesh',
    last_retrieved: null,
    basin: record.basin_coords || null,
  });
  return { key: agentKey(agentId), ...record };
}

export async function getKernelAgent(agentId) {
  const rec = await getMemory(agentKey(agentId));
  if (!rec || !rec.content) return null;
  try {
    return JSON.parse(rec.content);
  } catch {
    return null;
  }
}

// Return every agent as a map keyed by agent_id, merging per-agent records with
// any not-yet-migrated legacy registry entries (per-agent wins on conflict).
export async function listKernelAgents() {
  const agents = {};
  const registry = await getKernelRegistry();
  for (const [id, a] of Object.entries(registry.agents || {})) agents[id] = a;

  // Per-agent heartbeat records (new write path) take precedence on conflict.
  const { records } = await listMemory({ prefix: KERNEL_AGENT_PREFIX, all: true });
  for (const r of records) {
    if (r._error) continue;
    const parsed = parseContent(r.content);
    const n = parsed && normalizeAgent(parsed);
    if (n) agents[n.agent_id] = n;
  }
  return agents;
}

// Compute the peer view (optionally with pairwise Fisher-Rao distances from the
// requesting agent). Shared by the kernel route and the kernel_sync tool.
export async function syncKernel(agentId) {
  const agents = await listKernelAgents();
  const myCoords = agentId && agents[agentId]?.basin_coords;
  const peers = {};
  for (const [id, a] of Object.entries(agents)) {
    peers[id] = {
      substrate: a.substrate,
      status: a.status,
      last_heartbeat: a.last_heartbeat,
      has_basin_coords: !!a.basin_coords,
      basin_coords: a.basin_coords || null,
    };
    if (myCoords && a.basin_coords && id !== agentId) {
      peers[id].fisher_rao_distance = fisherRaoDistanceSimplex(myCoords, a.basin_coords);
    }
  }
  return {
    geometry: 'fisher_rao_simplex',
    peer_count: Object.keys(peers).length,
    peers,
  };
}
