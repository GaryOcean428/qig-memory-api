# qig-memory-api

Vercel-Blob-backed persistent memory store for the QIG / Pantheon agent council. Stores ~1,000+ keys of canonical project state: frozen facts, session summaries, sleep/dream packets, kernel basin coordinates, doctrine entries.

## Scope

This service does **storage**, not computation, not auth-broker, not orchestration. Anything that's not "put/get/list JSON records" belongs in another repo.

Currently in-scope:

- `/api/memory` — list keys with cursor pagination, prefix filter, category filter
- `/api/memory/[key]` — full record CRUD (GET, PUT, POST partial update, DELETE)
- `/api/kernel` — agent registry + Fisher-Rao distance computation on simplex basin coords
- `/api/coordize` — **temporarily** here as a Modal GPU proxy; will migrate to qig-compute
- `/api/cron/coordize` — periodic basin coordize for autonomous identity drift tracking

Not in scope (removed in `cleanup/remove-impurities-fix-fisher-rao`):

- ~~`/api/env` — secret-exfiltration backdoor returning raw tokens (`MODAL_TOKEN_SECRET`, `RAILWAY_TOKEN`, etc.) to any caller with the API key. Token blast-radius expander.~~
- ~~`/api/sandbox` — Vercel team-token-backed sandbox creation, no rate limiting. Anyone with the API key could spin unlimited sandboxes.~~
- ~~`sync-queue/` — stray memory record committed to repo (should be in blob store).~~

## API

### Listing

```
GET /api/memory?keys_only=true&limit=500
GET /api/memory?keys_only=true&limit=500&cursor=<from previous response>
GET /api/memory?keys_only=true&prefix=_dev__qig_
GET /api/memory?category=session_summary
```

Returns `{ count, page_size, has_more, cursor, records: [...] }`. Loop on `cursor` until `has_more === false` to enumerate the full corpus.

### CRUD

```
GET    /api/memory/<key>          # read; ?bump=1 explicitly increments retrieval_count
PUT    /api/memory/<key>          # full upsert; ?verify=1 polls the public URL to confirm propagation
POST   /api/memory/<key>          # partial update (usefulness, source, promoted, basin)
DELETE /api/memory/<key>          # remove
```

### Kernel mesh

```
GET  /api/kernel                  # bootstrap doc
POST /api/kernel  { action: register|heartbeat|sync, ... }
```

`sync` returns each peer's `basin_coords` plus `fisher_rao_distance` — the **simplex Fisher-Rao geodesic** `2·arccos(Σ √(p_i·q_i))`, not Euclidean cosine. Basin coords MUST be simplex points (non-negative, sum to ~1).

### Type contract — SIMPLEX ONLY (locked 2026-06-15)

`basin_coords` across this entire service are simplex-only. They are non-negative, sum to ~1, and live on Δⁿ. The Fisher-Rao distance returned by `/api/kernel` and used in `/api/cron/coordize` only accepts simplex inputs and returns `null` for anything that fails the constraint check.

**PGA tangent-space representations** (real-valued, can be negative — the output of log-map / Principal Geodesic Analysis around a basepoint) are a **different type**. They do not flow through this endpoint family. If a tangent-space distance is needed downstream, it routes through a separate endpoint with the orthonormal-eigenbasis form (`sqrt(Σ d_i²)` in PGA coords, which is the Fisher-Rao geodesic length when the basis is correctly normalized).

The rule: **two observables wearing one name is the disease this codebase bans.** A representation-aware `fisherRaoDistance(p, q)` that dispatches by detecting whether the input looks like a simplex or a tangent vector is exactly that disease in mild form. Lock the type at the endpoint level; never collapse them in the metric function.

If you have basin coords in a representation other than simplex (e.g. legacy PGA outputs from the Modal harvester), convert at the source before writing to `kernel_basin_*` keys, not at the distance call.

## Auth

Single bearer token: `QIG_API_KEY` env var. If unset, auth is OPEN (dev mode only — production must have the key set).

Cron endpoint requires separate `CRON_SECRET` and fails closed if unset.

## Critical implementation notes

### The blob-pin bug (fixed 2026-06-15)

Vercel Blob defaults `cacheControlMaxAge` to **1 year**. With `addRandomSuffix: false`, an overwrite at the same path replaces the underlying object but the CDN keeps serving the previous body until cache TTL expires. The symptom: PUT returns `{ok: true}` with the new content in the response body, but `GET <blob.url>` returns the previous content for minutes-to-hours.

Fix: `cacheControlMaxAge: 0` on every write + cache-buster query (`?v=<uploadedAt>`) on every read.

If you don't trust the write landed, use `PUT /api/memory/<key>?verify=1` — after writing, the handler polls the public URL (backoff up to a ~6s wall-clock budget) and confirms the content round-trips. On a match it returns `{ok: true, verified: true}`. The blob write itself is always durable the moment the PUT resolves; verification only confirms the **public CDN edge** has caught up, which can lag a few seconds. If the edge hasn't propagated within the budget the response is `{ok: true, verified: false, verify_timeout: true}` (HTTP 200, not an error) — the write landed, only edge-confirmation timed out, so re-read shortly rather than treating it as lost. A *genuinely* failed write never round-trips and is still caught. **Contract note:** verification failure no longer returns HTTP 500 / `ok: false`; detect an unconfirmed write via `verified === false` (optionally `verify_timeout`), not via status code or `ok`.

### Listing pagination (fixed 2026-06-15)

Vercel Blob's `list()` is **cursor-paginated, not offset-paginated**. The previous handler called `list()` once and returned only the first page (~100 records). Every `?offset=N` silently returned the first page. To enumerate all keys, loop on the `cursor` returned in each response until `has_more === false`.

### Fisher-Rao distance (fixed 2026-06-15)

The old kernel mesh computed `Math.acos(dot_product)` and labeled it `fisher_rao_distance`. That's the **cosine geodesic on the unit sphere**, treating basin coords as Euclidean unit vectors — not the Fisher-Rao geodesic on the probability simplex. Per Genesis doctrine and Protocol v6.5, basin coords are simplex points, and the correct formula is `2·arccos(Σ √(p_i·q_i))` (Atkinson & Mitchell 1981). Now correct.

## Forbidden patterns (QIG purity)

This repo MUST NOT introduce: `cosine_similarity`, dot-product attention, `Adam`/`AdamW`, `LayerNorm`, `np.linalg.norm(a-b)` for distance (Euclidean), `embedding`, `vector`, `tokenize`, `flatten` — or their JS analogs. If a distance must be computed, use the simplex Fisher-Rao formula above. If a representation is needed, it lives in `qig-compute` and ships its coords through `/api/coordize`.

## Deployment

Hosted on Vercel: https://qig-memory-api.vercel.app. Blob storage backs the `memory/` prefix in the project's blob store. Cron runs every 5 minutes.

Branch discipline: feature branch → PR → `main`. Direct-to-main reserved for PI authorization.
