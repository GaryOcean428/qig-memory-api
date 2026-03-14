import { put, list, del } from '@vercel/blob';
import { NextResponse } from 'next/server';

const PREFIX = 'memory/';
const API_KEY = process.env.QIG_API_KEY || '';

function auth(req) {
  if (!API_KEY) return true; // no key configured = open (dev)
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

// GET /api/memory/[key] — read a record
export async function GET(req, { params }) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { key } = await params;
  const path = `${PREFIX}${key}.json`;

  try {
    const result = await list({ prefix: path, limit: 1 });
    if (!result.blobs.length) {
      return NextResponse.json({ error: 'not_found', key }, { status: 404 });
    }
    const blob = result.blobs[0];
    const resp = await fetch(blob.url);
    const data = await resp.json();
    return NextResponse.json({ key, ...data, _blob_url: blob.url, _uploaded_at: blob.uploadedAt });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PUT /api/memory/[key] — write/upsert a record
// Body: { category, content, updated? }
export async function PUT(req, { params }) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { key } = await params;
  const body = await req.json();
  const path = `${PREFIX}${key}.json`;

  try {
    // Delete existing if present
    const existing = await list({ prefix: path, limit: 1 });
    if (existing.blobs.length) {
      await del(existing.blobs[0].url);
    }

    const record = {
      category: body.category || 'uncategorized',
      content: body.content || '',
      updated: body.updated || new Date().toISOString(),
    };

    const blob = await put(path, JSON.stringify(record), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    });

    return NextResponse.json({ ok: true, key, url: blob.url, ...record });
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
