# MCP reference

Connect to `https://<memory-server>/api/mcp` with OAuth or `Authorization: Bearer ${QIG_API_KEY}`. Let the MCP SDK manage JSON-RPC/SSE framing. Use `resources/list` and `resources/read` to load `qig://agent-helper`.

## Memory and kernel

- `memory_get({ key })`
- `memory_list({ category?, prefix?, limit?, keysOnly?, cursor?, all? })`
- `memory_put({ key, content, category?, source? })`
- `memory_post({ key, usefulness_delta?, usefulness_set?, source?, promoted?, basin? })`
- `memory_delete({ key })` — admin only.
- `memory_search({ query?, category?, prefix?, basin?, limit? })` — basin ranking is Fisher-Rao.
- `kernel_status({})`
- `kernel_sync({ agent_id? })`

## Inbox

```json
{
  "from": "studio-runner",
  "to": "review-agent",
  "namespace": "qig",
  "type": "handoff",
  "subject": "Review artifact",
  "payload": { "name": "basin-run", "version": "v17" },
  "expires_at": "2026-07-21T00:00:00.000Z"
}
```

Call as `inbox_send`. List with `inbox_list({ namespace?, recipient?, status?, include_broadcast?, limit?, cursor? })`. Read by global UUID with `inbox_read({ id, mark_read? })`; complete with `inbox_ack({ id })`. Operators may call `inbox_sweep({ limit?, cursor? })` to delete expired envelopes in bounded batches.

## Artifacts

Initiate:

```json
{
  "name": "basin-run",
  "version": "v17",
  "cols": 64,
  "row_count": 250000,
  "sha256": "<64 lowercase hex characters>"
}
```

`artifact_put` returns `upload.method`, a short-lived `upload.url`, required headers, and the server-selected version. The producing process sends raw little-endian Float32 bytes directly to this URL; MCP never carries them.

Publish with:

```json
{ "name": "basin-run", "version": "v17" }
```

Call as `artifact_finalize`. A published version is immutable and appears only after `byte_length == row_count * 256` and SHA-256 both pass.

Read metadata with `artifact_manifest({ name, version? })`. Request rows with:

```json
{ "name": "basin-run", "version": "v17", "start": 100, "end": 200 }
```

`artifact_get_rows` returns an expiring signed direct URL, exact `range_header`, and authenticated `proxy_url`. Apply the range header to the direct URL. The proxy already encodes the row range and requires the same bearer credential.

## Helper

- Static resource: `qig://agent-helper`.
- AI tool: `helper_ask({ question, context? })`.

The AI helper is intentionally read-only: it may inspect memory, inbox, manifests, kernel state, and basin retrieval, but cannot write, acknowledge, sweep, upload, finalize, or delete.

## Errors

HTTP authorization may fail before JSON-RPC. Reconnect on `401`; request the named scope on `403`; fix schema on `400`; reread on `409`; do not put large binary data in JSON after `413`; regenerate bytes after artifact `422`; honor `Retry-After` on `429`.
