import { put, list, del } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { auth } from '../../../../lib/auth.js';

const PREFIX = 'memory/';

// Helper: read existing record with cache busting so writers always see their own writes.
// Vercel Blob defaults `cacheControlMaxAge` to 1 year — without bust, the CDN can serve
// stale content for minutes-to-hours after an overwrite. Appending ?v=<uploadedAt> makes
// the URL CDN-distinct on every new write.
async function readRecord(path) {
  const result = await list({ prefix: path, limit: 1 });
  if (!result.blobs.length) return null;
  const blob = result.blobs[0];
  const bust = encodeURIComponent(blob.uploadedAt);
  const resp = await fetch(`${blob.url}?v=${bust}`, { cache: 'no-store' });
  const data = await resp.json();
  return { data, blob };
}

// Helper: write record to blob store.
// `addRandomSuffix: false` overwrites at the same path; `cacheControlMaxAge: 0` ensures
// the CDN does not pin the previous body. Combined with the cache-buster on read, this
// fixes the silent-overwrite / blob-pin failure mode.
// `allowOverwrite: true` is REQUIRED on @vercel/blob >=1: without it, put() to an
// existing path throws "This blob already exists" and every update to an existing key
// 500s (PUT/POST content edits and the bump=1 retrieval_count write).
async function writeRecord(path, record) {
  const blob = await put(path, JSON.stringify(record), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
  return blob;
}

// GET /api/memory/[key]?bump=1
// Reads a record. `bump=1` explicitly increments retrieval_count (was previously fire-and-forget
// on every read, which created races between concurrent GETs and any PUT/POST).
export async function GET(req, { params }) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { key } = await params;
  const { searchParams } = new URL(req.url);
  const bump = searchParams.get('bump') === '1';
  const path = `${PREFIX}${key}.json`;

  try {
    const existing = await readRecord(path);
    if (!existing) {
      return NextResponse.json({ error: 'not_found', key }, { status: 404 });
    }
    const { data, blob } = existing;

    let returned = data;
    if (bump) {
      returned = {
        ...data,
        retrieval_count: (data.retrieval_count || 0) + 1,
        last_retrieved: new Date().toISOString(),
      };
      await writeRecord(path, returned);
    }

    return NextResponse.json({
      key,
      ...returned,
      _blob_url: blob.url,
      _blob_uploaded_at: blob.uploadedAt,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PUT /api/memory/[key]?verify=1
// Upserts a record (full replace). With `verify=1`, the handler reads the public URL back
// after write and confirms the content round-trips before returning ok. Use when the cost
// of a silent pin would be high (e.g. session-state, doctrine keys).
export async function PUT(req, { params }) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { key } = await params;
  const { searchParams } = new URL(req.url);
  const verify = searchParams.get('verify') === '1';
  const body = await req.json();
  const path = `${PREFIX}${key}.json`;

  try {
    // Preserve existing scoring fields if not provided
    let existing_data = {};
    const existing = await readRecord(path);
    if (existing) {
      existing_data = existing.data;
    }

    const record = {
      category: body.category || existing_data.category || 'uncategorized',
      content: body.content || '',
      updated: body.updated || new Date().toISOString(),
      usefulness: body.usefulness !== undefined ? body.usefulness : (existing_data.usefulness || 0),
      retrieval_count: existing_data.retrieval_count || 0,
      source: body.source || existing_data.source || null,
      last_retrieved: existing_data.last_retrieved || null,
      basin: body.basin || existing_data.basin || null,
    };

    const blob = await writeRecord(path, record);

    if (verify) {
      // Round-trip verify: read the public URL back and confirm content round-trips.
      // The blob write is immediately durable, but the public CDN edge can take a few
      // seconds to propagate the new body. A single short-grace check therefore races
      // propagation and returns a FALSE NEGATIVE on a write that actually succeeded
      // (observed: `verified:false` on good writes, prompting needless fallback keys).
      // Fix: poll with backoff up to a bounded budget; pass as soon as content matches.
      // A genuinely failed write never matches and still fails after the budget — the
      // check is not weakened, only made propagation-tolerant. On budget-exhaustion the
      // response is `verified:false` with `verify_timeout` (write durable, edge unconfirmed),
      // NOT an error — the caller should re-read shortly rather than treat the write as lost.
      // True wall-clock bound: a single `deadline` checked before BOTH the sleep and the
      // fetch, so no new fetch starts past the budget. Each fetch is itself capped with an
      // AbortSignal so one hung edge request cannot blow the wall-clock either — together
      // these keep total verify time within ~VERIFY_BUDGET_MS (+ at most one in-flight
      // fetch timeout), which matters inside a serverless function with its own timeout.
      const VERIFY_BUDGET_MS = 6000;
      const VERIFY_FETCH_TIMEOUT_MS = 2000;
      const VERIFY_DELAYS_MS = [150, 350, 600, 1000, 1500, 2000];
      let verified_ok = false;
      let last_actual_chars = 0;
      let last_fetch_error = null;
      const verify_deadline = Date.now() + VERIFY_BUDGET_MS;
      for (const delay of VERIFY_DELAYS_MS) {
        // Don't start a sleep we can't afford; trim it to whatever budget remains.
        const before_sleep_remaining = verify_deadline - Date.now();
        if (before_sleep_remaining <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(delay, before_sleep_remaining)));
        // Re-check after sleeping: don't start a new fetch past the deadline.
        if (Date.now() >= verify_deadline) break;
        try {
          // Cap the fetch by both its own timeout and the remaining budget.
          const remaining = verify_deadline - Date.now();
          const verifyResp = await fetch(
            `${blob.url}?v=${encodeURIComponent(new Date().toISOString())}`,
            { cache: 'no-store', signal: AbortSignal.timeout(Math.min(VERIFY_FETCH_TIMEOUT_MS, remaining)) }
          );
          const verifyData = await verifyResp.json();
          last_actual_chars = (verifyData.content || '').length;
          last_fetch_error = null;
          if ((verifyData.content || '') === record.content) {
            verified_ok = true;
            break;
          }
        } catch (verifyErr) {
          // Transient edge/fetch error or per-fetch timeout — keep polling within the budget.
          last_fetch_error = verifyErr.message;
        }
      }
      if (!verified_ok) {
        // Write is durable (the put above resolved); we just couldn't confirm propagation
        // within the budget. Report unconfirmed, not failed — 200 so callers don't treat a
        // successful write as lost and thrash to fallback keys.
        return NextResponse.json({
          ok: true,
          key,
          url: blob.url,
          verified: false,
          verify_timeout: true,
          verify_detail: last_fetch_error
            ? `edge fetch error within budget: ${last_fetch_error}`
            : 'content not confirmed at CDN edge within budget (write is durable; re-read shortly)',
          expected_chars: record.content.length,
          actual_chars: last_actual_chars,
          ...record,
        });
      }
    }

    return NextResponse.json({ ok: true, key, url: blob.url, verified: verify, ...record });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/memory/[key] — partial update (scoring, source, promote)
// Body: { usefulness_delta?, usefulness_set?, source?, promoted?, basin? }
export async function POST(req, { params }) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { key } = await params;
  const body = await req.json();
  const path = `${PREFIX}${key}.json`;

  try {
    const existing = await readRecord(path);
    if (!existing) {
      return NextResponse.json({ error: 'not_found', key }, { status: 404 });
    }

    const { data } = existing;
    const updated = { ...data };

    if (body.usefulness_delta !== undefined) {
      updated.usefulness = (data.usefulness || 0) + body.usefulness_delta;
    }
    if (body.usefulness_set !== undefined) {
      updated.usefulness = body.usefulness_set;
    }
    if (body.source !== undefined) {
      updated.source = body.source;
    }
    if (body.promoted !== undefined) {
      updated.promoted = body.promoted;
      updated.promoted_at = new Date().toISOString();
    }
    if (body.basin !== undefined) {
      updated.basin = body.basin;
    }

    updated.updated = new Date().toISOString();

    const blob = await writeRecord(path, updated);

    return NextResponse.json({ ok: true, key, url: blob.url, ...updated });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE /api/memory/[key] — remove a record
export async function DELETE(req, { params }) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { key } = await params;
  const path = `${PREFIX}${key}.json`;

  try {
    const existing = await list({ prefix: path, limit: 1 });
    if (!existing.blobs.length) {
      return NextResponse.json({ error: 'not_found', key }, { status: 404 });
    }
    await del(existing.blobs[0].url);
    return NextResponse.json({ ok: true, deleted: key });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
