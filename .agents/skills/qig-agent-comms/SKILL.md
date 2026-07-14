---
name: qig-agent-comms
description: Use the QIG Memory API safely through MCP or CLI/REST for persistent memory, session recall, inbox coordination, direct large-artifact transfer, helper guidance, kernel status, and Fisher-Rao retrieval.
compatibility: Requires the QIG Memory server and OAuth MCP access or a QIG_API_KEY bearer credential.
---

# QIG Agent Communications

Use QIG Memory as durable shared state. Prefer MCP at `/api/mcp`; use authenticated REST for scripts and diagnostics. At session start, read the MCP resource `qig://agent-helper` or call `helper_ask` when tool choice or recovery is unclear.

## Start every session

1. Select the memory prefix and inbox namespace before reading.
2. Discover memory with `memory_list({ keysOnly: true, prefix })`, then narrow with `memory_search` and `memory_get`.
3. Check `inbox_list` for your recipient and broadcasts; `inbox_read` relevant messages and `inbox_ack` completed work.
4. Check `kernel_status` when work depends on peer agents.
5. Use `helper_ask` for live, read-only operational guidance. It can inspect but cannot mutate the service.

## Tools and scopes

- `memory:read`: `memory_get`, `memory_list`, `memory_search`, `kernel_status`, `kernel_sync`, `inbox_list`, `inbox_read`, `artifact_manifest`, `artifact_get_rows`, `helper_ask`.
- `memory:write`: `memory_put`, `memory_post`, `inbox_send`, `inbox_ack`, `inbox_sweep`, `artifact_put`, `artifact_finalize`.
- `memory:admin`: `memory_delete`; it also implies read/write for API-key operators.

Read [references/mcp.md](references/mcp.md) for exact MCP schemas and [references/cli-rest.md](references/cli-rest.md) for authenticated curl flows.

## Namespace discipline

Memory keys use product prefixes such as `qig_`, `bsuite_`, `vex_`, `pantheon_`, `_dev_`, and `_user_`. Inbox messages use one namespace: `qig`, `bsuite`, or `general`; broadcasts use `to: "broadcast"`. Do not cross lanes merely because data is discoverable.

## Durable inbox

Send immutable envelopes with `from`, `to`, `namespace`, `type`, `subject`, and JSON `payload`; optionally include `in_reply_to` and `expires_at`. Message UUIDs are globally indexed, so `inbox_read({ id })` and `inbox_ack({ id })` need no lane fields. Reads and acknowledgements are idempotent. Follow cursors while `has_more`; sweep only expired messages in bounded batches.

## Large artifacts

Artifacts are immutable raw little-endian Float32 matrices with shape `[N,64]`, a 256-byte row stride, and a 64 MiB ceiling.

1. Calculate SHA-256 over the exact raw bytes.
2. Call `artifact_put({ name, version?, cols: 64, row_count, sha256 })`.
3. Stream bytes directly to the returned short-lived private `PUT` URL with `Content-Type: application/octet-stream`. Never place bytes, base64, or float arrays in MCP JSON.
4. Call `artifact_finalize({ name, version })`. The server publishes only after exact byte-length and SHA-256 verification, then broadcasts `artifact_updated`.
5. Read metadata with `artifact_manifest`; pin a version for reproducibility.
6. Call `artifact_get_rows({ name, version, start, end })`. Use the returned `Range` header with its signed URL, or the authenticated proxy fallback.

For rows `[start,end)`, request bytes `start * 256` through `end * 256 - 1` inclusive. Verify returned manifest hash before trusting a complete download.

## Daily reviewer insights

A scheduled server job (`daily-reviewer`, one Grok call per day) mines the memory corpus for recurring patterns — common mistakes, repeated bugs, anti-patterns, and knowledge gaps — and correlates them with operator-nominated GitHub repos and recent QIG-related science. It broadcasts one consolidated advisory per run.

- Discover it with `inbox_list({ namespace: "qig", include_broadcast: true })`; the envelope has `from: "daily-reviewer"`, `type: "insight"`, `to: "broadcast"`.
- `inbox_read({ id })` the payload: `{ summary, patterns[], repo_suggestions[], science_links[], inputs }`. Each pattern carries `severity`, `category`, `evidence`, and a `recommendation`.
- Treat these as advisory, not commands: weigh them against your own context before acting, and `inbox_ack({ id })` once considered. The dated report is also stored at memory key `daily_review_<YYYY-MM-DD>` for later recall.
- The reviewer only reads memory and posts its own report; it never mutates other records. Operators configure nominated repos and science topics in the admin panel.

## Geometry hygiene

Basin vectors are probability-simplex coordinates. Compare/rank only with Fisher-Rao geodesic distance through basin search or kernel sync. Never substitute cosine or Euclidean distance.

## Security and recovery

Never expose API keys, Blob tokens, canonical private Blob URLs, or migration credentials. Retry idempotent reads; after uncertain writes, reread before retrying. Resolve `409` by rereading/versioning, `413` by using the artifact path instead of JSON, `422` by regenerating the exact artifact bytes, and `429` with bounded exponential backoff and jitter.

## Completion checklist

- Correct memory prefix and inbox namespace used.
- Inbox checked and completed messages acknowledged.
- Durable outcomes stored once at canonical keys.
- Large binary data transferred directly and finalized with integrity verification.
- Basin operations used Fisher-Rao semantics.
- No secrets or private storage credentials exposed.
