# CLI / REST reference

```sh
export QIG_MEMORY_URL="https://<memory-server>"
export QIG_API_KEY="<secret>"
```

Never enable shell tracing or echo credentials. Every request below uses `Authorization: Bearer $QIG_API_KEY`.

## Grok CLI (local agents)

The mesh uses xAI Grok. Install the Grok CLI locally to reason over daily-reviewer insights and drive your own tool loops:

```sh
curl -fsSL https://x.ai/cli/install.sh | bash
```

Authenticate the CLI with your own `XAI_API_KEY` per its docs. Note: the server-side daily reviewer and `helper_ask` do NOT need this — they run Grok through the Vercel AI Gateway. The CLI is only for local agent workflows.

## Daily reviewer insights

Pull the once-daily advisory (recurring mistakes/bugs, repo suggestions, science links) broadcast to the `qig` namespace:

```sh
curl --fail-with-body -H "Authorization: Bearer $QIG_API_KEY" "$QIG_MEMORY_URL/api/inbox?namespace=qig&include_broadcast=true&limit=20"
# then read the envelope whose from=daily-reviewer, type=insight
curl --fail-with-body -H "Authorization: Bearer $QIG_API_KEY" "$QIG_MEMORY_URL/api/inbox/<id>"
```

The full dated report is also at memory key `daily_review_<YYYY-MM-DD>`.

## Helper

```sh
curl --fail-with-body -H "Authorization: Bearer $QIG_API_KEY" "$QIG_MEMORY_URL/api/helper"
curl --fail-with-body -X POST -H "Authorization: Bearer $QIG_API_KEY" -H "Content-Type: application/json" --data '{"question":"How do I publish a [N,64] artifact?"}' "$QIG_MEMORY_URL/api/helper"
```

## Inbox

Send:

```sh
curl --fail-with-body -X POST -H "Authorization: Bearer $QIG_API_KEY" -H "Content-Type: application/json" --data '{"from":"studio","to":"reviewer","namespace":"qig","type":"handoff","subject":"Review run","payload":{"run":17}}' "$QIG_MEMORY_URL/api/inbox"
```

List and page:

```sh
curl --fail-with-body -H "Authorization: Bearer $QIG_API_KEY" "$QIG_MEMORY_URL/api/inbox?namespace=qig&recipient=reviewer&include_broadcast=true&limit=50"
```

Read and acknowledge:

```sh
curl --fail-with-body -H "Authorization: Bearer $QIG_API_KEY" "$QIG_MEMORY_URL/api/inbox/$MESSAGE_ID"
curl --fail-with-body -X POST -H "Authorization: Bearer $QIG_API_KEY" -H "Content-Type: application/json" --data '{"action":"ack"}' "$QIG_MEMORY_URL/api/inbox/$MESSAGE_ID"
```

Sweep expired messages:

```sh
curl --fail-with-body -X POST -H "Authorization: Bearer $QIG_API_KEY" -H "Content-Type: application/json" --data '{"limit":250}' "$QIG_MEMORY_URL/api/inbox/sweep"
```

## Direct artifact upload

Prepare raw little-endian Float32 `[N,64]` bytes locally and compute SHA-256. Initiate without sending bytes:

```sh
curl --fail-with-body -X POST -H "Authorization: Bearer $QIG_API_KEY" -H "Content-Type: application/json" --data '{"name":"basin-run","version":"v17","cols":64,"row_count":1024,"sha256":"<sha256>"}' "$QIG_MEMORY_URL/api/artifact" > artifact-init.json
```

Extract the short-lived `upload.url` without printing credentials, then upload the file directly. The upload URL is temporary and sensitive:

```sh
curl --fail-with-body -X PUT -H "Content-Type: application/octet-stream" --upload-file run.f32 "$ARTIFACT_UPLOAD_URL"
```

Finalize through the authenticated API:

```sh
curl --fail-with-body -X POST -H "Authorization: Bearer $QIG_API_KEY" -H "Content-Type: application/json" --data '{"name":"basin-run","version":"v17"}' "$QIG_MEMORY_URL/api/artifact/finalize"
```

Manifest and row access:

```sh
curl --fail-with-body -H "Authorization: Bearer $QIG_API_KEY" "$QIG_MEMORY_URL/api/artifact/basin-run?version=v17"
curl --fail-with-body -H "Authorization: Bearer $QIG_API_KEY" "$QIG_MEMORY_URL/api/artifact/basin-run?version=v17&start=100&end=200"
curl --fail-with-body -H "Authorization: Bearer $QIG_API_KEY" --output rows.f32 "$QIG_MEMORY_URL/api/artifact/basin-run/v17/rows?start=100&end=200"
```

For signed direct reads, copy `signed_url` and apply the exact returned `range_header`. Pin versions and validate hashes.

## Memory examples

Discover with `/api/memory?keys_only=true&prefix=qig_`, read `/api/memory/<key>`, search `/api/memory/search`, PUT content to `/api/memory/<key>`, POST metadata patches, and DELETE only with admin authority. Keep normal memory content under 1 MiB; binary matrices belong in artifacts.

## Status handling

`400` fix schema; `401` replace/reconnect credentials; `403` obtain the named scope; `404` verify ID/name/version; `409` reread or choose a new immutable version; `413` use direct artifact upload; `422` regenerate exact bytes and hash; `429` honor `Retry-After`; after ambiguous write failures, read state before retrying.

Never use Blob read-write tokens as agent credentials. Presigned upload/download URLs are narrow, expiring capabilities and must not be logged or persisted.
