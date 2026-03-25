import { put, list, del } from '@vercel/blob';
import { NextResponse } from 'next/server';

const PREFIX = 'memory/';
const API_KEY = process.env.QIG_API_KEY || '';

function auth(req) {
  if (!API_KEY) return true; // no key configured = open (dev)
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

// Helper: read existing record or return null
async function readRecord(path) {
  const result = await list({ prefix: path, limit: 1 });
  if (!result.blobs.length) return null;
  const blob = result.blobs[0];
  const resp = await fetch(blob.url);
  const data = await resp.json();
  return { data, blob };
}

// Helper: write record to blob store
async function writeRecord(path, record) {
  const existing = await list({ prefix: path, limit: 1 });
  if (existing.blobs.length) {
    await del(existing.blobs[0].url);
  }
  return await put(path, JSON.stringify(record), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

// GET /api/memory/[key] — read a record (auto-increments retrieval_count)
export async function GET(req, { params }) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { key } = await params;
  const path = `${PREFIX}${key}.json`;

  try {
    const existing = await readRecord(path);
    if (!existing) {
      return NextResponse.json({ error: 'not_found', key }, { status: 404 });
    }

    const { data, blob } = existing;

    // Auto-increment retrieval_count (fire-and-forget, don't block response)
    const updated = {
      ...data,
      retrieval_count: (data.retrieval_count || 0) + 1,
      last_retrieved: new Date().toISOString(),
    };
    writeRecord(path, updated).catch(() => {});

    return NextResponse.json({
      key,
      ...updated,
      _blob_url: blob.url,
      _uploaded_at: blob.uploadedAt,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PUT /api/memory/[key] — write/upsert a record (full replace)
// Body: { category, content, updated?, usefulness?, source?, basin? }
export async function PUT(req, { params }) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { key } = await params;
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
      // Scoring fields (preserve existing if not provided in body)
      usefulness: body.usefulness !== undefined ? body.usefulness : (existing_data.usefulness || 0),
      retrieval_count: existing_data.retrieval_count || 0,
      source: body.source || existing_data.source || null,
      last_retrieved: existing_data.last_retrieved || null,
      // Optional basin coordinates (64 floats when coordized)
      basin: body.basin || existing_data.basin || null,
    };

    const blob = await writeRecord(path, record);

    return NextResponse.json({ ok: true, key, url: blob.url, ...record });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/memory/[key] — partial update (scoring, source, promote)
// Body: { usefulness_delta?, usefulness_set?, source?, promoted?, basin? }
// Use this to increment scores without rewriting content.
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

    // Apply scoring updates
    const updated = { ...data };

    // Increment usefulness by delta (e.g. +1 for positive outcome, -0.5 for neutral)
    if (body.usefulness_delta !== undefined) {
      updated.usefulness = (data.usefulness || 0) + body.usefulness_delta;
    }

    // Or set usefulness to absolute value
    if (body.usefulness_set !== undefined) {
      updated.usefulness = body.usefulness_set;
    }

    // Update source attribution
    if (body.source !== undefined) {
      updated.source = body.source;
    }

    // Mark as promoted to resonance bank
    if (body.promoted !== undefined) {
      updated.promoted = body.promoted;
      updated.promoted_at = new Date().toISOString();
    }

    // Store basin coordinates after coordizing
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
