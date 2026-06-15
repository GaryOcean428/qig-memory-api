import { put, list, del } from '@vercel/blob';
import { NextResponse } from 'next/server';

const PREFIX = 'memory/';
const API_KEY = process.env.QIG_API_KEY || '';

function auth(req) {
  if (!API_KEY) return true; // no key configured = open (dev)
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

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
async function writeRecord(path, record) {
  const blob = await put(path, JSON.stringify(record), {
    access: 'public',
    addRandomSuffix: false,
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
      // Round-trip verify: read the public URL back and confirm content matches.
      // Small grace period for the put to settle, then cache-busted GET.
      await new Promise((r) => setTimeout(r, 150));
      try {
        const verifyResp = await fetch(`${blob.url}?v=${encodeURIComponent(new Date().toISOString())}`, {
          cache: 'no-store',
        });
        const verifyData = await verifyResp.json();
        if ((verifyData.content || '') !== record.content) {
          return NextResponse.json(
            {
              ok: false,
              error: 'blob_verification_failed',
              key,
              expected_chars: record.content.length,
              actual_chars: (verifyData.content || '').length,
            },
            { status: 500 }
          );
        }
      } catch (verifyErr) {
        return NextResponse.json(
          { ok: false, error: 'blob_verification_fetch_failed', key, detail: verifyErr.message },
          { status: 500 }
        );
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
