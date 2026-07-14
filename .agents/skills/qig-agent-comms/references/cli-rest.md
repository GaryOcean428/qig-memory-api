# CLI / REST reference

## Safety setup

```sh
export QIG_MEMORY_URL="https://<memory-server>"
export QIG_API_KEY="<secret-from-admin-settings>"
```

Never enable shell tracing (`set -x`) around authenticated commands. Never echo the key. Prefer a secret manager or process environment over command-line literals.

Use a common header:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $QIG_API_KEY" \
  -H "Accept: application/json" \
  "$QIG_MEMORY_URL/api/memory?keys_only=true&prefix=qig_"
```

Add `--connect-timeout`, `--max-time`, and bounded retries in automation. Do not use `--retry-all-errors` for non-idempotent writes without a read-after-failure check.

## Discover keys

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $QIG_API_KEY" \
  "$QIG_MEMORY_URL/api/memory?keys_only=true&prefix=qig_"
```

`keys_only=true` auto-paginates key discovery. URL-encode keys and query values in real clients.

## Read one record

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $QIG_API_KEY" \
  "$QIG_MEMORY_URL/api/memory/qig_project_decisions"
```

Add `?bump=1` only when retrieval telemetry should change. Use `?verify=1` for high-stakes freshness where supported.

## Search

```sh
curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer $QIG_API_KEY" \
  --data-urlencode "q=private blob migration" \
  --data-urlencode "prefix=qig_" \
  --data-urlencode "limit=10" \
  "$QIG_MEMORY_URL/api/memory/search"
```

For basin search, POST JSON to `/api/memory/search`:

```sh
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $QIG_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"basin":[0.2,0.3,0.5],"prefix":"qig_","limit":10}' \
  "$QIG_MEMORY_URL/api/memory/search"
```

The server normalizes valid simplex vectors and ranks by Fisher–Rao distance.

## Create or replace

```sh
curl --fail-with-body --silent --show-error \
  -X PUT \
  -H "Authorization: Bearer $QIG_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"content":"Canonical current decision...","category":"architecture","source":"agent-session"}' \
  "$QIG_MEMORY_URL/api/memory/qig_project_decisions"
```

Keep content below 1 MiB. After important writes, GET the same key and verify expected fields.

## Patch metadata

```sh
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $QIG_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"usefulness_delta":0.1,"promoted":true}' \
  "$QIG_MEMORY_URL/api/memory/qig_project_decisions"
```

This does not replace content.

## Delete

```sh
curl --fail-with-body --silent --show-error \
  -X DELETE \
  -H "Authorization: Bearer $QIG_API_KEY" \
  "$QIG_MEMORY_URL/api/memory/qig_obsolete_record"
```

Requires `memory:admin`. Obtain explicit authorization and verify the key before deleting.

## Full-content pagination

A default collection read returns a bounded page. If `has_more` is true, pass the returned opaque `cursor` unchanged:

```sh
curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer $QIG_API_KEY" \
  --data-urlencode "prefix=qig_" \
  --data-urlencode "limit=100" \
  --data-urlencode "cursor=$CURSOR" \
  "$QIG_MEMORY_URL/api/memory"
```

Do not parse or manufacture cursors. `all=true` is available but can create a large response.

## HTTP handling

- `200`: parse JSON and inspect application fields such as `not_found` or `has_more`.
- `400`: fix request schema; do not retry unchanged.
- `401`: key is absent/invalid.
- `403`: key/OAuth client lacks the required scope.
- `404`: record absent.
- `409`: reread state before retrying.
- `413`: request/content too large.
- `429`: honor `Retry-After`; exponential backoff with jitter.
- `5xx`: retry idempotent reads; for writes, first GET the target to determine whether the write committed.

## Storage boundary

Never use `BLOB_READ_WRITE_TOKEN`, `BLOB_READ_WRITE_TOKEN_2`, `MEMORY_BLOB_READ_WRITE_TOKEN`, or `SOURCE_BLOB_READ_WRITE_TOKEN` as agent credentials. Those are server/migration secrets. Never return or persist private Blob URLs. The API key and OAuth MCP flow are the only supported agent access paths.
