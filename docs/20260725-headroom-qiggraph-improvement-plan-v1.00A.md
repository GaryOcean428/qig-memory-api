# qig-memory Improvement Plan — Headroom × QIGGraph Integration

**Date:** 2026-07-25
**Session:** Qwen Code CLI session (braden@braden-u, /home/braden)
**Status:** PLAN READY — awaiting implementation in qig-memory project context
**Priority:** P0 is a single-function change; P2/P3 are <50 lines each

---

## Context: What Was Done

A full headroom-ai (v0.32.1) installation was restored, configured across all agents, and extended with a custom QIGGeo pipeline extension implementing Fisher-Rao geometric scoring (4 phases). The patterns proven in headroom are now ready to be applied back to qig-memory (the upstream MCP server that headroom's `protect_tool_results: "qig-memory"` setting protects).

### Headroom State (for reference)
- Proxy: systemd service, port 8787, healthy, memory enabled, TOIN 601 patterns
- Extension: `~/Desktop/Dev/headroom-qig-geo/` (Phase 1-4 live)
- Agents configured: Claude Code, Qwen Code, Grok, Codex, Hermes, Devin, Cline, agy (MCP)
- Dashboard: `http://127.0.0.1:8787/dashboard` + `~/.headroom/qig-dashboard.html`
- Lifetime savings: $578.89 (cache optimization), 75.2M tokens compressed, 23K requests

### QIG Research Applied
- **WormholeCache (EXP-A022):** 69.2x speedup, ξ*=0.362 screening length, zero false transports
- **P7 Principle:** 2-4KB basin packet > 100KB message log
- **MESH-001:** Coupling J=0.5 sufficient for task coordination
- **SleepPacket:** 4KB hard limit, 64D basin coords + Phi + kappa

---

## The Core Gap

**qig-memory stores the right data but never uses it at query time.**

Every record has: `usefulness`, `retrieval_count`, `updated`, `last_retrieved`, `basin` (optional 64D simplex vector). But `searchMemory()` in `lib/memory-store.js` only does:
1. Binary substring matching (AND semantics across terms)
2. Pure Fisher-Rao distance ranking (only when `basin` param provided)

No composite scoring. No recency weighting. No importance ranking. No dedup. No mode awareness.

---

## Implementation Plan

### P0: Multi-Factor Relevance Scoring (HIGH impact, LOW effort)

**File:** `lib/memory-store.js` → `searchMemory()`

**Change:** Add a `scoreRecord()` function between filtering and sorting:

```javascript
function scoreRecord(record, { queryBasin, agentId, now = Date.now() }) {
  const RECENCY_LAMBDA = 0.1; // exponential decay rate
  const updatedAge = (now - new Date(record.updated).getTime()) / 3600000; // hours
  const recencyScore = Math.exp(-RECENCY_LAMBDA * updatedAge);

  const usefulnessScore = Math.min(1, (record.usefulness || 0) / 10);

  const retrievalScore = Math.log1p(record.retrieval_count || 0) / Math.log1p(100);

  let basinScore = 0.5; // neutral if no basin
  if (queryBasin && record.basin) {
    const d = fisherRaoDistanceSimplex(queryBasin, record.basin);
    if (d !== null) basinScore = 1 - d / (Math.PI / 2);
  }

  const lastRetrievedAge = record.last_retrieved
    ? (now - new Date(record.last_retrieved).getTime()) / 3600000
    : 9999;
  const lastRetrievedScore = Math.exp(-RECENCY_LAMBDA * lastRetrievedAge);

  const sourceAffinity = (record.source && agentId && record.source.includes(agentId)) ? 1.0 : 0.3;

  return (
    0.25 * recencyScore +
    0.20 * usefulnessScore +
    0.20 * retrievalScore +
    0.15 * basinScore +
    0.10 * lastRetrievedScore +
    0.10 * sourceAffinity
  );
}
```

**Integration:** After filtering matches, sort by `scoreRecord()` descending instead of insertion order or pure distance.

**Tool schema change:** `memory_search` in `lib/qig-tools.js` — add optional `agent_id` param for source affinity.

---

### P1: Hierarchical Memory Scoping (MED-HIGH impact, MED effort)

**Files:** `lib/memory-store.js`, `lib/qig-tools.js`, `app/api/mcp/route.js`

**Change:** Add `scope` field to records: `"user" | "session" | "agent" | "shared"`

- `putMemory()` accepts `scope` (default: `"shared"`)
- `searchMemory()` ranks same-scope records higher (boost +0.15)
- MCP principal identity (from auth) drives default scope
- Key prefix convention: `memory/{scope}/{key}.json`

**Migration:** Existing records get `scope: "shared"` by default (backward compatible).

---

### P2: Geometric Dedup / Screening Length (MEDIUM impact, LOW effort)

**File:** `lib/memory-store.js` → `putMemory()`

**Change:** Before writing, check same-category records for geometric redundancy:

```javascript
const DEDUP_XI = 0.3; // Conservative (EXP-A022 validated: 0% false transport at ξ≤0.362)

async function checkGeometricDedup(key, content, category, basin) {
  if (!basin) return null;
  const siblings = await listMemory({ prefix: `memory/`, category, all: true });
  for (const sib of siblings) {
    if (sib.key === key) continue;
    const sibBasin = sib.basin || extractBasin(sib.content);
    if (!sibBasin) continue;
    const d = fisherRaoDistanceSimplex(basin, sibBasin);
    if (d !== null && d < DEDUP_XI) return sib.key; // duplicate found
  }
  return null;
}
```

**Behavior:** If duplicate found, merge (update existing record's `updated`, `usefulness`, `content`) instead of creating new. Return `{ merged: true, existing_key }` in response.

---

### P3: Prefix Stabilization / Cache Alignment (MEDIUM impact, LOW effort)

**File:** `lib/qig-tools.js` → `projectRecord()`

**Change:** Deterministic field ordering:

```javascript
const FIELD_ORDER = ['key', 'category', 'preview', 'usefulness', 'retrieval_count', 'updated', 'source'];

function projectRecord(record, opts) {
  const projected = {};
  for (const field of FIELD_ORDER) {
    if (record[field] !== undefined) projected[field] = record[field];
  }
  // ... existing preview logic
  return projected;
}
```

**Also:** Ensure `JSON.stringify()` in MCP route uses sorted keys or the canonical order. This makes Anthropic's `cache_control` hit on repeated similar queries (90% discount on cached tokens).

---

### P4: Basin Attractors / Mode-Aware Search (MED-HIGH impact, HIGH effort)

**Files:** `lib/memory-store.js`, new `lib/mode-classifier.js`

**Change:** Port the 5 attractors from `headroom-qig-geo/geometry.py`:
- reasoning, tool_use, creativity, recovery, output
- Classify incoming query by character-frequency basin → nearest attractor
- Boost records whose category/content matches the active mode
- `memory_search` accepts optional `mode` param (auto-detected if not provided)

**Dependency:** Requires a lightweight content→basin classifier (the Modal coordizer is retired). The character-frequency approach from headroom-qig-geo works without ML models.

---

### P5: Compressed Cross-Agent Handoffs (MEDIUM impact, MED effort)

**File:** `lib/inbox-store.js`, `lib/qig-tools.js`

**Change:** Add `handoff` mode to `inbox_send`:

```javascript
// Structured handoff schema
{
  type: "handoff",
  summary: "200-char max summary of what was done",
  remaining: ["task1", "task2"],
  key_findings: ["finding1", "finding2"],
  relevant_keys: ["memory_key_1", "memory_key_2"],
  basin: [/* 64D */],  // geometric state for wormhole retrieval
}
```

Receiving agent gets compressed context instead of raw payload. Token-budget-aware: summarize to fit 500 tokens.

---

### P6: Failure Pattern Extraction (MEDIUM impact, MED-HIGH effort)

**Files:** `lib/daily-reviewer.js` (add Phase 5), new `lib/learn.js`

**Change:**
- Phase 5 in daily reviewer: scan `task_run_*` records for failures, extract patterns
- Write `category: "learned_pattern"` records with schema: `{ trigger, failure, fix, confidence, occurrences }`
- `searchMemory()` boosts `learned_pattern` records when query matches a known trigger
- Optional: write to agent CLAUDE.md/MEMORY.md via headroom learn integration

---

## What's Already Good (don't touch)

- 160-char preview projection (token budget fix) ✅
- ts-ordered inbox secondary index (O(page) listing) ✅
- Per-agent kernel records (no cross-agent contention) ✅
- Filtered pagination across physical blob pages ✅
- Single source of truth for tool defs (MCP + helper never drift) ✅
- Fisher-Rao distance (correct geometry, P1-compliant) ✅
- OAuth 2.1 server with PKCE + DCR ✅
- Concurrent blob reads (Promise.all batches) ✅
- Content size caps (1 MiB record, 256 KiB inbox) ✅

---

## Verification

After implementing P0:
```bash
# Test scoring improvement
curl -X POST https://quauntum.dev/api/memory/search \
  -H "Authorization: Bearer $QIG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"terms": ["basin"], "limit": 5}'
# Results should be ranked by composite score, not insertion order
```

After P2:
```bash
# Test dedup
curl -X PUT https://quauntum.dev/api/memory/test_dedup_1 \
  -H "Authorization: Bearer $QIG_KEY" \
  -d '{"content": "test", "category": "dedup_test", "basin": [0.1, 0.2, ...]}'
# Second write with d_FR < 0.3 should merge, not create new
```

---

## Files Reference

| File | Changes |
|------|---------|
| `lib/memory-store.js` | P0 (scoreRecord), P1 (scope), P2 (dedup) |
| `lib/qig-tools.js` | P0 (agent_id param), P1 (scope param), P3 (field order) |
| `app/api/mcp/route.js` | P1 (principal→scope), P3 (serialization) |
| `lib/inbox-store.js` | P5 (handoff schema) |
| `lib/daily-reviewer.js` | P6 (Phase 5) |
| NEW `lib/mode-classifier.js` | P4 (attractor classification) |
| NEW `lib/learn.js` | P6 (failure extraction) |

---

## Handover Prompt (for next session)

```
You are working in /home/braden/Desktop/Dev/qig-memory — a Next.js MCP memory server.

Read docs/20260725-headroom-qiggraph-improvement-plan-v1.00A.md for full context.

The plan has 7 prioritized improvements (P0-P6) derived from headroom-ai's
IntelligentContext scoring, QIGGraph basin attractors, and WormholeCache
screening length patterns.

Start with P0: Add scoreRecord() to searchMemory() in lib/memory-store.js.
The data (usefulness, retrieval_count, updated, last_retrieved, basin) already
exists in every record but is never consumed at query time.

Key constraints:
- Fisher-Rao distance (fisherRaoDistanceSimplex) is the ONLY valid geometric metric
- Preview projection (160 chars) must be preserved
- Backward compatible (no schema migrations, scope defaults to "shared")
- Vercel Blob is the only persistence layer (no database)
- All tool defs live in lib/qig-tools.js (single source of truth)
```
