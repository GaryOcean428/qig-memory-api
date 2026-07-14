---
name: qig-agent-comms
description: Use the QIG Memory API safely from an agent through MCP or CLI/REST. Trigger for persistent memory, session recall, memory search or updates, QIG API keys, MCP connection setup, kernel agent registration/heartbeats, namespace selection, basin/Fisher-Rao retrieval, or coordination with other agents. Also trigger when planning inbox or artifact operations, but never claim those deferred tools exist.
compatibility: Requires access to the QIG Memory server and either an OAuth-capable MCP client or QIG_API_KEY bearer credential.
---

# QIG Agent Communications

Use QIG Memory as durable shared state. Prefer MCP because it handles authentication, schemas, and scopes; use CLI/REST for setup, diagnostics, automation, or when MCP is unavailable.

## Start every session

1. Identify the work lane before reading: `qig_`, `bsuite_`, `vex_`, `pantheon_`, `_dev_`, or `_user_`.
2. Never cross lanes merely because a record is discoverable. Ask before accessing another product/user lane.
3. Prefer `memory_list({ keysOnly: true, prefix })` to discover keys without downloading the corpus.
4. Read only the small set of relevant records with `memory_get` or narrow `memory_search`.
5. Use memory silently as context. Do not announce “I see in memory” unless provenance matters.
6. Check `kernel_status` when work depends on other agents. Use `kernel_sync({ agent_id })` only to inspect the peer mesh and optional Fisher–Rao distances from a registered agent; it does not register or heartbeat agents.

## Choose a surface

### MCP (preferred)

Connect to `/api/mcp` using OAuth when supported. Request only the scopes needed:

- `memory:read`: get, list, search, and kernel status.
- `memory:write`: put, patch, and kernel sync.
- `memory:admin`: delete and administrative operations.

Current tools: `memory_get`, `memory_list`, `memory_put`, `memory_post`, `memory_delete`, `memory_search`, `kernel_status`, and `kernel_sync`.

Read [references/mcp.md](references/mcp.md) before configuring or invoking MCP.

### CLI / REST (fallback)

Keep credentials in environment variables; never paste, print, log, commit, or place them in command history where avoidable.

```sh
export QIG_MEMORY_URL="https://<memory-server>"
export QIG_API_KEY="<secret>"
```

Send `Authorization: Bearer $QIG_API_KEY`. Do not use Blob tokens: agents access the API, not storage. Read [references/cli-rest.md](references/cli-rest.md) for commands, status handling, and pagination.

## Namespace discipline

Select exactly one lane for a task:

| Prefix | Use |
| --- | --- |
| `qig_` | QIG research, geometry, kernels, and memory-server work |
| `bsuite_` | BSuite product and operating context |
| `vex_` | VEX-specific context |
| `pantheon_` | Pantheon-specific context |
| `_dev_` | Shared development mechanics that are intentionally cross-project |
| `_user_` | User-owned preferences or context |

Do not invent an unprefixed shared key when a lane applies. Use stable, descriptive keys; update an existing canonical key rather than creating timestamped duplicates for the same concept. Per-agent mutable state must use its own key (for example `kernel_agent_<id>`), avoiding shared read-modify-write blobs.

## Read and recall

- Enumerate with `keysOnly: true`; it auto-paginates the complete key index.
- Full-content listing is paginated. Follow `cursor` while `has_more` is true, or deliberately set `all: true` for a bounded corpus.
- Narrow by `prefix`, `category`, or a specific key before broad text search.
- Treat `not_found` as absence, not an empty record.
- Use `GET /api/memory/<key>?bump=1` only when retrieval telemetry should be updated.
- Use `verify=1` on REST reads/searches for high-stakes freshness when supported by the endpoint.

## Write continuously, not noisily

Persist durable outcomes after they become true:

- decisions and reversals;
- merged commits/deployments and migration state;
- validated hypotheses, kill/verdict outcomes, and important failures;
- stable conventions another session must follow.

Do not persist scratch reasoning, secrets, credentials, transient logs, speculative claims, or content already captured canonically elsewhere.

Use `memory_put` to create or replace content. It preserves scoring fields when omitted. Use `memory_post` only for metadata/scoring (`usefulness_delta`, `usefulness_set`, `source`, `promoted`, or `basin`) and never expect it to replace content. Keep content under 1 MiB. Delete only with explicit authority and `memory:admin`.

After a high-stakes write, read it back and compare the key/content or other expected fields. Resolve concurrent updates by rereading and merging intentionally; never blindly overwrite shared state.

## Geometry hygiene

Basin vectors are probability-simplex coordinates: finite, non-negative, positive sum, and normalized by the server. Compare/rank them with Fisher–Rao geodesic distance through `memory_search({ basin })`. Never substitute cosine similarity for basin retrieval. Do not attach arbitrary embeddings as basins.

## Errors and recovery

- `401 invalid_token`: credential missing/invalid; reconnect MCP or replace the API key.
- `403 insufficient_scope`: request approval for the specific scope; do not retry with the same grant.
- `404 not_found`: verify key and namespace.
- `409`: resolve a conflict/rate condition; reread before retrying writes.
- `413`: content or request is too large; do not split a binary artifact into memory records.
- `429`: honor `Retry-After` and use bounded exponential backoff with jitter.
- `5xx`/network failure: retry idempotent reads; retry writes only after checking whether they committed.

Never fall back to direct Blob access. The private Blob is an implementation detail; only the migration utility is allowed to see source and destination stores.

## Deferred capabilities

The inter-agent inbox (`inbox_*`) and versioned binary artifact store (`artifact_*`) are designed but not shipped. Do not call, document as available, or emulate them with shared read-modify-write records. Until inbox ships, coordinate through explicitly owned per-agent memory keys. Large `[N,64]` float32 artifacts require the future artifact route and must not enter the 1 MiB record store.

## Completion checklist

- Correct namespace and least-privilege scope used.
- Relevant session-start memories read without bulk corpus download.
- Durable outcomes written once to canonical keys.
- Important writes read back and verified.
- No secrets, Blob credentials/URLs, or unsupported tools exposed.
- Any basin operation used Fisher–Rao semantics.
