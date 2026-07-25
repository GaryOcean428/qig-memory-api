# qig-memory Implementation Plan — Phase 2 (P7–P12)

**Date:** 2026-07-25
**Status:** DRAFT — pending red-team
**Predecessor:** docs/20260725-headroom-qiggraph-improvement-plan-v1.00A.md (P0–P6, implemented)

---

## Situation Report

P0–P6 are implemented and build-verified (uncommitted on main). The composite
scoring system is live but two of its six signals (retrieval_count,
last_retrieved) are never updated on read — they're always 0/null. Search is
O(corpus) on every call (~1800 blob reads). Internal fields leak into agent-
facing results. No memory expiry or GC exists.

---

## Task Breakdown

### Task 1: Retrieval Tracking (CORRECTNESS — blocks scoring validity)

**Goal:** `memory_get` increments `retrieval_count` and stamps `last_retrieved`
on every successful read, so the composite score's 30% retrieval weight operates
on live data.

**Files:** `lib/memory-store.js` (getMemory), `lib/qig-tools.js` (memory_get execute)

**Implementation:**
- Add `trackRetrieval(key)` to memory-store.js: read record, increment
  retrieval_count, set last_retrieved = now, write back. Fire-and-forget
  (non-blocking, catch errors silently).
- Call it in memory_get's execute AFTER returning the record (use `after()`
  from next/server for non-blocking write, same pattern as council_convene).
- Also call in the REST GET route (`app/api/memory/[key]/route.js`).

**Acceptance criteria:**
- After `memory_get("foo")`, a subsequent `memory_get("foo")` shows
  retrieval_count >= 1 and last_retrieved != null.
- The tracking write never blocks or fails the read response.
- Kernel agent records (category: kernel_agent) are EXEMPT — heartbeats
  would inflate their counts meaninglessly.

**Risk:** Write amplification on hot keys. Mitigated by: fire-and-forget,
no etag guard (last-writer-wins is fine for counters).

---

### Task 2: Strip Internal Fields from Results (HYGIENE)

**Goal:** Remove `_score`, `_error`, and other internal fields from
agent-facing search/list results.

**Files:** `lib/qig-tools.js` (projectRecord)

**Implementation:**
- In `projectRecord()`, delete keys starting with `_` before returning.
- Rename `_score` to `relevance` in search results (agents benefit from
  seeing the score, just not with an internal prefix).

**Acceptance criteria:**
- No field starting with `_` appears in memory_search or memory_list results.
- `relevance` field present in search results (float, 0–1 range).

---

### Task 3: Memory Expiry (HYGIENE)

**Goal:** Records can carry an optional `expires_at` ISO timestamp. Expired
records are skipped by search and list (but not deleted — GC handles that).

**Files:** `lib/memory-store.js` (putMemory, searchMemory, listMemory),
`lib/qig-tools.js` (memory_put schema)

**Implementation:**
- `putMemory` accepts optional `expires_at` (ISO datetime string).
- `searchMemory` filter: skip records where `expires_at < now`.
- `listMemory` filter: same (in the readRecord wrapper).
- `memory_put` schema: add `expires_at: z.string().datetime().optional()`.
- Backward compatible: records without expires_at never expire.

**Acceptance criteria:**
- A record written with expires_at in the past is invisible to search/list.
- A record without expires_at is always visible.
- memory_get still returns expired records (explicit key access is intentional).

---

### Task 4: Wormhole Retrieval Tool (CAPABILITY)

**Goal:** New `memory_wormhole` tool — keyless nearest-basin query. Given a
64D basin vector, returns the single nearest memory record within screening
length ξ (default 0.5). Implements the Wormhole Principle: "jump directly to
a deep basin without re-deriving the path."

**Files:** `lib/memory-store.js` (new `wormholeMemory()`), `lib/qig-tools.js`
(new tool def), `app/api/mcp/route.js` (auto-registered via toolDefs)

**Implementation:**
```javascript
export async function wormholeMemory({ basin, xi = 0.5, category }) {
  const { records } = await listMemory({ category, all: true });
  let best = null;
  let bestDist = xi;
  for (const r of records) {
    if (r._error) continue;
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
```

**Tool schema:**
- `basin`: z.array(z.number()).length(64).required()
- `xi`: z.number().min(0.01).max(1.5).optional() (default 0.5)
- `category`: z.string().optional()

**Acceptance criteria:**
- Returns nearest record within ξ by Fisher-Rao distance.
- Returns `{ found: false }` when nothing is within ξ.
- READ_ONLY_TOOL_NAMES includes memory_wormhole.
- Geometrically pure: only Fisher-Rao, no cosine/euclidean.

---

### Task 5: Search Index (PERFORMANCE)

**Goal:** Replace O(corpus) full-scan in searchMemory with an inverted index
for term queries. Basin queries still scan (they need all records with basins).

**Files:** `lib/memory-store.js` (searchMemory), new `lib/search-index.js`

**Implementation:**
- New `lib/search-index.js`:
  - `buildIndex()`: walks corpus, extracts terms from key+content+source,
    writes `memory/_search_index.json` blob (term → [keys] map, top 500 terms).
  - `lookupTerms(terms)`: reads index blob, returns candidate key set.
  - Index is rebuilt by daily reviewer (Phase 6) and on-demand via a new
    `memory_reindex` tool (write-scoped).
- `searchMemory` modification:
  - If query has terms AND no basin: use index to get candidate keys, then
    read only those records (O(matches) instead of O(corpus)).
  - If basin provided OR no terms: fall back to full scan (unchanged).
  - If index blob missing/stale: fall back to full scan (graceful degradation).

**Acceptance criteria:**
- Term-only search with index present reads < 50 blobs (vs ~1800).
- Basin search behavior unchanged.
- Missing index → full scan fallback (no error).
- Index rebuild completes within Vercel function timeout (60s for 1800 keys).

**Risk:** Index staleness. Mitigated by: rebuild on daily cron + manual
reindex tool + graceful fallback.

---

### Task 6: Memory GC (HYGIENE)

**Goal:** Archive records that are stale (low usefulness, never retrieved,
old). Prevents unbounded corpus growth.

**Files:** `lib/memory-store.js` (new `archiveMemory()`), `lib/qig-tools.js`
(new `memory_gc` tool), `app/api/cron/` (new or extended cron route)

**Implementation:**
- `archiveMemory({ maxAgeDays = 30, maxUsefulness = 2, dryRun = true })`:
  - Scan all records.
  - Archive candidates: usefulness <= maxUsefulness AND retrieval_count == 0
    AND updated < (now - maxAgeDays).
  - EXEMPT: kernel_agent, learned_pattern, daily_review categories.
  - If dryRun: return candidate list without moving.
  - If !dryRun: move to `memory/_archived/{key}.json`, delete original.
- New `memory_gc` tool (write-scoped, destructive):
  - Params: maxAgeDays, maxUsefulness, dryRun (default true).
  - Returns: { archived: N, candidates: [...] } or { would_archive: N }.
- Wire into daily reviewer as Phase 6 (after failure extraction).

**Acceptance criteria:**
- dryRun=true never mutates.
- Archived records are recoverable (moved, not deleted).
- Kernel agents and learned patterns are never archived.
- GC with default params on current corpus archives 0 records (all are
  either useful or recently updated).

---

## Execution Order

1. Task 1 (retrieval tracking) — correctness, unblocks scoring validity
2. Task 2 (strip _score) — trivial, do alongside Task 1
3. Task 3 (expiry) — small, independent
4. Task 4 (wormhole) — independent, high value
5. Task 5 (search index) — largest, depends on stable searchMemory
6. Task 6 (GC) — depends on expiry being in place

## Verification

After all tasks: `npm run build` + `npm run check:tools` must pass.
Each task has its own acceptance criteria above.
