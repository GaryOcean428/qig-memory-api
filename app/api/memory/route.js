import { list } from '@vercel/blob';
import { NextResponse } from 'next/server';

const PREFIX = 'memory/';
const API_KEY = process.env.QIG_API_KEY || '';

function auth(req) {
  if (!API_KEY) return true;
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

// GET /api/memory?category=sleep_packet&limit=50
export async function GET(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category');
  const limitParam = parseInt(searchParams.get('limit') || '100', 10);
  const keysOnly = searchParams.get('keys_only') === 'true';

  try {
    const result = await list({ prefix: PREFIX, limit: 1000 });
    let records = [];

    for (const blob of result.blobs) {
      const key = blob.pathname.replace(PREFIX, '').replace('.json', '');
      if (keysOnly) {
        records.push({ key, uploaded_at: blob.uploadedAt, size: blob.size });
        continue;
      }

      try {
        const resp = await fetch(blob.url);
        const data = await resp.json();
        if (category && data.category !== category) continue;
        records.push({ key, ...data, _uploaded_at: blob.uploadedAt });
      } catch {
        records.push({ key, _error: 'parse_failed', _uploaded_at: blob.uploadedAt });
      }
    }

    if (limitParam < records.length) records = records.slice(0, limitParam);

    return NextResponse.json({
      count: records.length,
      total_blobs: result.blobs.length,
      category_filter: category || null,
      records,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
