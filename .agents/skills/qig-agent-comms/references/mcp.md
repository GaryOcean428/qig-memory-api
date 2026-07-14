# MCP reference

## Connect

Endpoint:

```text
https://<memory-server>/api/mcp
```

Prefer an MCP client that supports remote HTTP and OAuth discovery. The server publishes authorization and protected-resource metadata under `/.well-known/`. Complete browser consent and request only the required scopes.

If the client supports bearer headers but not OAuth, configure the key through its secret/environment facility:

```json
{
  "mcpServers": {
    "qig-memory": {
      "url": "https://<memory-server>/api/mcp",
      "headers": {
        "Authorization": "Bearer ${QIG_API_KEY}"
      }
    }
  }
}
```

Do not commit a literal key. Environment interpolation syntax varies by client; verify the client’s documentation. A configuration accepted by one agent runtime may not be accepted by another.

## Transport behavior

The endpoint accepts JSON-RPC over HTTP POST. Send `Content-Type: application/json` and `Accept: application/json, text/event-stream`. A successful response may be JSON or SSE depending on the MCP client/transport version. Let the MCP SDK manage protocol framing rather than hand-crafting JSON-RPC unless diagnosing the transport.

## Tools

### `memory_get`

```json
{ "key": "qig_example" }
```

Returns the record or `{ "error": "not_found", "key": "..." }`.

### `memory_list`

```json
{ "prefix": "qig_", "keysOnly": true }
```

Use `keysOnly: true` for full discovery. For content pages, use `limit` and continue with the returned `cursor` while `has_more` is true. `all: true` intentionally loads all matching content and should be reserved for known-small sets.

### `memory_put`

```json
{
  "key": "qig_project_decisions",
  "content": "Canonical, current decision...",
  "category": "architecture",
  "source": "agent-session"
}
```

Creates or replaces record content while preserving omitted scoring metadata.

### `memory_post`

```json
{
  "key": "qig_project_decisions",
  "usefulness_delta": 0.1,
  "promoted": true
}
```

Metadata-only patch. Valid patch fields are `usefulness_delta`, `usefulness_set`, `source`, `promoted`, and `basin`.

### `memory_delete`

```json
{ "key": "qig_obsolete_record" }
```

Requires `memory:admin`. Confirm intent before invoking.

### `memory_search`

Text/filter search:

```json
{ "query": "private blob migration", "prefix": "qig_", "limit": 10 }
```

Geometric recall:

```json
{ "basin": [0.2, 0.3, 0.5], "prefix": "qig_", "limit": 10 }
```

A basin query ranks by Fisher–Rao distance. Do not describe it as cosine or embedding similarity.

### `kernel_status`

No arguments. Returns registered agents and heartbeat state. Use for discovery; do not infer an inbox from the registry.

### `kernel_sync`

Return the complete peer view. With no arguments it returns the mesh; with a registered `agent_id`, it also computes pairwise Fisher–Rao distance to peers that have basin coordinates:

```json
{ "agent_id": "stable-agent-id" }
```

This tool is read-only. It does not register agents, update heartbeats, or send messages.

## Scope failures

MCP authorization errors may arrive as HTTP `401`/`403` before JSON-RPC handling. Reconnect on `401`. On `403 insufficient_scope`, obtain approval for the named scope rather than broadening silently. OAuth clients may be read-only until an administrator grants operator scopes, and revoked clients must re-register/reconnect.

## Unsupported tools

Do not call `inbox_*` or `artifact_*` until the server advertises them in `tools/list`. Feature plans and memory notes are not proof that a tool exists; `tools/list` is authoritative.
