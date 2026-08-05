import { del, get, list, put } from '@vercel/blob';
// Single source of truth for private-store credentials (static token or OIDC).
import { categoryModeBoost, classifyMode } from './mode-classifier';
import { collectFilteredPage } from './paginate-filtered';
import { privateBlobOptions as memoryOptions } from './private-blob';

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

// Fire-and-forget retrieval tracking. Increments retrieval_count and stamps
// last_retrieved so the composite score's 30% retrieval weight operates on
// live data. Kernel agent records are exempt — heartbeats would inflate their
// counts meaninglessly. No etag guard: last-writer-wins is fine for counters.
export async function trackRetrieval(key) {
  try {
    const existing = await readRecord(keyToPath(key));
    if (!existing) return;
    if (existing.data.category === 'kernel_agent') return;
    const updated = {
      ...existing.data,
      retrieval_count: (existing.data.retrieval_count || 0) + 1,
      last_retrieved: new Date().toISOString(),
    };
    await writeRecord(keyToPath(key), updated);
  } catch {
    // Tracking is best-effort; never fail the read path.
  }
}

// ---------------------------------------------------------------------------
// Geometric dedup — screening length from EXP-A022 (WormholeCache). Records
// within ξ < 0.3 Fisher-Rao distance in the same category are considered
// duplicates; the write merges into the existing record instead of creating a
// new one. Conservative threshold: 0% false transport validated at ξ ≤ 0.362.
// ---------------------------------------------------------------------------
const DEDUP_XI = 0.3;

async function checkGeometricDedup(key, category, basin) {
  if (!basin || !Array.isArray(basin) || !basin.length) return null;
  const { records } = await listMemory({ category, all: true });
  for (const sib of records) {
    if (sib.key === key || sib._error) continue;
    const sibBasin = extractBasin(sib);
    if (!sibBasin) continue;
    const d = fisherRaoDistanceSimplex(basin, sibBasin);
    if (d !== null && d < DEDUP_XI) return sib.key;
  }
  return null;
}

export async function putMemory(key, { category, content, source, basin, usefulness, scope, expires_at } = {}) {
  if (content !== undefined) assertContentSize(content);
  const path = keyToPath(key);
  const existing = await readRecord(path);
  const prev = existing?.data || {};
  const effectiveCategory = category || prev.category || 'uncategorized';
  const effectiveBasin = basin || prev.basin || null;

  // Geometric dedup: if a same-category record is within screening length,
  // merge into it instead of creating a new key.
  const dedupTarget = await checkGeometricDedup(key, effectiveCategory, effectiveBasin);
  if (dedupTarget) {
    const targetPath = keyToPath(dedupTarget);
    const targetExisting = await readRecord(targetPath);
    const targetPrev = targetExisting?.data || {};
    const merged = {
      ...targetPrev,
      content: content ?? targetPrev.content ?? '',
      updated: new Date().toISOString(),
      usefulness: usefulness !== undefined
        ? Math.max(usefulness, targetPrev.usefulness || 0)
        : targetPrev.usefulness || 0,
      source: source ?? targetPrev.source ?? null,
      basin: effectiveBasin || targetPrev.basin || null,
      scope: scope || targetPrev.scope || 'shared',
      expires_at: expires_at ?? targetPrev.expires_at ?? null,
    };
    await writeRecord(targetPath, merged);
    return { key: dedupTarget, merged: true, existing_key: dedupTarget, ...merged };
  }

  const record = {
    category: effectiveCategory,
    content: content ?? prev.content ?? '',
    updated: new Date().toISOString(),
    usefulness: usefulness !== undefined ? usefulness : prev.usefulness || 0,
    retrieval_count: prev.retrieval_count || 0,
    source: source ?? prev.source ?? null,
    last_retrieved: prev.last_retrieved || null,
    basin: effectiveBasin,
    scope: scope || prev.scope || 'shared',
    expires_at: expires_at ?? prev.expires_at ?? null,
  };
  await writeRecord(path, record);
  return { key, ...record };
}

const BLOB_MAX_PAGE = 1000;
// Safety bound so auto-pagination can never loop unboundedly on a huge corpus.
const AUTO_PAGE_CAP = 5000;
// Max simultaneous blob reads. An UNBOUNDED Promise.all over the whole corpus
// (~2200+ records) fires thousands of concurrent GETs; the store sheds load and
// >50% return errors, which the readers below turn into _error records and every
// broad search/scan then SILENTLY drops — the corpus goes half-visible (this is
// the root cause of precedent records being unfindable). Bound it.
const READ_CONCURRENCY = 48;

// Bounded-concurrency map preserving input order. Runs at most `limit` of `fn`
// at a time. Use for any read over an unbounded set of blobs.
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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
    // One retry: even under bounded concurrency a read can transiently fail, and
    // a swallowed failure here is an invisible record. Retry before giving up.
    let lastErr = 'not_found';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const record = await readPrivateJson(blob.pathname);
        if (record) return { key, ...record.data };
        lastErr = 'not_found';
      } catch {
        lastErr = 'parse_failed';
      }
    }
    return { key, _error: lastErr };
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

  const fetched = await mapWithConcurrency(blobs, READ_CONCURRENCY, readRecord);
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

// ---------------------------------------------------------------------------
// Multi-factor relevance scoring. Every record carries usefulness,
// retrieval_count, updated, last_retrieved, and (optionally) a basin vector,
// but search used to rank by insertion order or pure distance. This composite
// score consumes all of those signals at query time.
// ---------------------------------------------------------------------------
const RECENCY_LAMBDA = 0.1; // exponential decay rate (per hour)

export function scoreRecord(record, { queryBasin, agentId, scope, mode, query, now = Date.now() } = {}) {
  const updatedAge = (now - new Date(record.updated || 0).getTime()) / 3600000;
  const recencyScore = Math.exp(-RECENCY_LAMBDA * Math.max(0, updatedAge));

  const usefulnessScore = Math.min(1, (record.usefulness || 0) / 10);

  const retrievalScore = Math.log1p(record.retrieval_count || 0) / Math.log1p(100);

  let basinScore = 0.5; // neutral when no basin on either side
  if (queryBasin && record.basin) {
    const d = fisherRaoDistanceSimplex(queryBasin, record.basin);
    if (d !== null) basinScore = 1 - d / (Math.PI / 2);
  }

  const lastRetrievedAge = record.last_retrieved
    ? (now - new Date(record.last_retrieved).getTime()) / 3600000
    : 9999;
  const lastRetrievedScore = Math.exp(-RECENCY_LAMBDA * Math.max(0, lastRetrievedAge));

  const sourceAffinity = (record.source && agentId && record.source.includes(agentId)) ? 1.0 : 0.3;

  const scopeBoost = (scope && record.scope && record.scope === scope) ? 0.15 : 0;

  const modeBoost = categoryModeBoost(record.category, mode);

  // Learned pattern boost: when a learned_pattern record's trigger matches the
  // query, surface it prominently — past solutions at the moment they're needed.
  let patternBoost = 0;
  if (record.category === 'learned_pattern' && query) {
    try {
      const pattern = typeof record.content === 'string' ? JSON.parse(record.content) : record.content;
      const trigger = String(pattern?.trigger || '').toLowerCase();
      const normalizedQuery = String(query).toLowerCase();
      if (trigger && (normalizedQuery.includes(trigger) || trigger.includes(normalizedQuery))) {
        patternBoost = 0.15 + (pattern.confidence || 0.5) * 0.1;
      }
    } catch { /* content not JSON — skip pattern boost */ }
  }

  return (
    0.25 * recencyScore +
    0.20 * usefulnessScore +
    0.20 * retrievalScore +
    0.15 * basinScore +
    0.10 * lastRetrievedScore +
    0.10 * sourceAffinity +
    scopeBoost +
    modeBoost +
    patternBoost
  );
}

// Search across the corpus. Filters by category / key-prefix / content terms,
// then ranks matches by a composite relevance score (recency, usefulness,
// retrieval frequency, basin proximity, source affinity, scope, mode). When
// `basin` is provided the geometric component is active and fisher_rao_distance
// is reported per result for backward compatibility. Mode is auto-detected from
// the query text when not explicitly provided. When terms are present and no
// basin/prefix filter, uses the inverted index for O(matches) reads instead of
// O(corpus). Falls back to full scan if the index is unavailable.
export async function searchMemory({
  query,
  category,
  prefix = '',
  basin,
  agent_id,
  scope,
  mode,
  limit = 20,
} = {}) {
  const terms = parseSearchTerms(query);
  const queryBasin = Array.isArray(basin) && basin.length ? basin : null;

  // Try the inverted index for term-only queries (no basin, no prefix filter).
  let records;
  let indexUsed = false;
  if (terms.length && !queryBasin && !prefix) {
    const { indexSearch, readCandidateRecords } = await import('./search-index');
    const { fresh, candidates } = await indexSearch(terms);
    // Trust the index ONLY when it provably still covers the live corpus (fresh)
    // AND it produced candidates. A stale index (corpus changed since the build)
    // or an empty candidate set (e.g. a dropped-stopword term) falls through to
    // the full scan — so the index can no longer cause a MISS, only acceleration.
    // This is the fix for precedent records being invisible to search: they were
    // written after the last rebuild and a non-empty stale index was trusted.
    if (fresh && candidates && candidates.size > 0) {
      records = await readCandidateRecords(candidates);
      indexUsed = true;
    }
  }
  if (!records) {
    const full = await listMemory({ prefix, all: true });
    records = full.records;
  }

  // Auto-detect operational mode from query text when not provided.
  const detectedMode = mode || (query ? classifyMode(query).mode : null);

  const now = Date.now();
  const matched = records.filter((r) => {
    if (r._error) return false;
    if (r.expires_at && Date.parse(r.expires_at) <= now) return false;
    if (category && r.category !== category) return false;
    if (terms.length) {
      const hay = `${r.key} ${r.content || ''} ${r.source || ''}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });

  const scored = matched.map((r) => {
    const score = scoreRecord(r, { queryBasin, agentId: agent_id, scope, mode: detectedMode, query });
    const out = { ...r, _score: score };
    if (queryBasin) {
      const b = extractBasin(r);
      out.fisher_rao_distance = b ? fisherRaoDistanceSimplex(queryBasin, b) : null;
    }
    return out;
  });

  scored.sort((a, b) => b._score - a._score);

  return {
    mode: queryBasin ? 'basin_nearest' : 'scored',
    geometry: queryBasin ? 'fisher_rao_simplex' : null,
    scoring: 'composite',
    detected_mode: detectedMode,
    index_used: indexUsed,
    total_scanned: records.length,
    match_count: scored.length,
    results: scored.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// Wormhole retrieval — keyless nearest-basin query. Implements the Wormhole
// Principle (EXP-A022): "jump directly to a deep basin without re-deriving
// the path." Given a 64D basin vector, returns the single nearest record
// within screening length ξ. Geometrically pure: Fisher-Rao only.
// ---------------------------------------------------------------------------
export async function wormholeMemory({ basin, xi = 0.5, category }) {
  const { records } = await listMemory({ category, all: true });
  const now = Date.now();
  let best = null;
  let bestDist = xi;
  for (const r of records) {
    if (r._error) continue;
    if (r.expires_at && Date.parse(r.expires_at) <= now) continue;
    const b = extractBasin(r);
    if (!b) continue;
    const d = fisherRaoDistanceSimplex(basin, b);
    if (d !== null && d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  if (!best) return { found: false, xi, geometry: 'fisher_rao_simplex' };
  return { found: true, distance: bestDist, xi, geometry: 'fisher_rao_simplex', record: best };
}

// ---------------------------------------------------------------------------
// Memory GC — archive stale records. Candidates: low usefulness, never
// retrieved, older than maxAgeDays. Exempt categories (kernel agents, learned
// patterns, daily reviews) are never archived. Archived records move to
// memory/_archived/{key}.json (recoverable, not deleted).
// ---------------------------------------------------------------------------
const ARCHIVE_PREFIX = '_archived/';
const GC_EXEMPT_CATEGORIES = new Set(['kernel_agent', 'learned_pattern', 'daily_review', '_index']);

export async function archiveMemory({ maxAgeDays = 30, maxUsefulness = 2, dryRun = true } = {}) {
  const { records } = await listMemory({ all: true });
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const candidates = [];

  for (const r of records) {
    if (r._error) continue;
    if (GC_EXEMPT_CATEGORIES.has(r.category)) continue;
    if (r.key.startsWith(ARCHIVE_PREFIX)) continue;
    if ((r.usefulness || 0) > maxUsefulness) continue;
    if ((r.retrieval_count || 0) > 0) continue;
    const updatedMs = Date.parse(r.updated || 0);
    if (updatedMs > cutoff) continue;
    candidates.push(r.key);
  }

  if (dryRun) {
    return { dry_run: true, would_archive: candidates.length, candidates: candidates.slice(0, 50) };
  }

  let archived = 0;
  for (const key of candidates) {
    const existing = await readRecord(keyToPath(key));
    if (!existing) continue;
    // Write to archive location, then delete original.
    await writeRecord(keyToPath(`${ARCHIVE_PREFIX}${key}`), existing.data);
    const { list: listBlobs, del: delBlob } = await import('@vercel/blob');
    const found = await listBlobs(memoryOptions({ prefix: keyToPath(key), limit: 1 }));
    if (found.blobs.length) await delBlob(found.blobs[0].url, memoryOptions());
    archived++;
  }

  return { dry_run: false, archived, candidates: candidates.length };
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
