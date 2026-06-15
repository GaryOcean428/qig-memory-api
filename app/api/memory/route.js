import { list } from '@vercel/blob';
import { NextResponse } from 'next/server';

const PREFIX = 'memory/';
const API_KEY = process.env.QIG_API_KEY || '';
const MAX_PAGE = 1000;
const DEFAULT_PAGE = 100;

function auth(req) {
  if (!API_KEY) return true;
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

// GET /api/memory
//   ?keys_only=true         — list keys only (fast path; skips per-blob content fetch)
//   ?cursor=<opaque>        — continue from previous page (Vercel Blob cursor pagination)
//   ?limit=N                — page size (max 1000, default 100)
//   ?category=foo           — filter by category (only honoured when keys_only is false)
//   ?prefix=foo_            — restrict to keys starting with prefix (server-side via blob prefix)
//
// Returns: { count, page_size, has_more, cursor, category_filter, records }
// To enumerate the full corpus, loop on `cursor` until `has_more === false`.
export async function GET(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category');
  const keysOnly = searchParams.get('keys_only') === 'true';
  const cursor = searchParams.get('cursor') || undefined;
  const userPrefix = searchParams.get('prefix') || '';
  const limit = Math.min(
    Math.max(parseInt(searchParams.get('limit') || String(DEFAULT_PAGE), 10) || DEFAULT_PAGE, 1),
    MAX_PAGE
  );

  // Build effective blob prefix — pushes filtering down to Vercel Blob
  const blobPrefix = `${PREFIX}${userPrefix}`;

  try {
    const result = await list({
      prefix: blobPrefix,
      limit,
      cursor,
    });

    // keys_only is the fast path — no per-blob fetch
    if (keysOnly) {
      const records = result.blobs.map((b) => ({
        key: b.pathname.replace(PREFIX, '').replace('.json', ''),
        uploaded_at: b.uploadedAt,
        size: b.size,
      }));
      return NextResponse.json({
        count: records.length,
        page_size: result.blobs.length,
        has_more: result.hasMore,
        cursor: result.cursor || null,
        category_filter: null,
        records,
      });
    }

    // Full-content path — fetch in parallel, not serial
    const fetched = await Promise.all(
      result.blobs.map(async (blob) => {
        const key = blob.pathname.replace(PREFIX, '').replace('.json', '');
        try {
          // Cache-buster query — Vercel Blob CDN treats this as a distinct URL,
          // so writers always see their own writes even though default cache TTL is 1 year.
          const bust = encodeURIComponent(blob.uploadedAt);
          const resp = await fetch(`${blob.url}?v=${bust}`, { cache: 'no-store' });
          const data = await resp.json();
          return { key, ...data, _uploaded_at: blob.uploadedAt };
        } catch {
          return { key, _error: 'parse_failed', _uploaded_at: blob.uploadedAt };
        }
      })
    );

    const records = category ? fetched.filter((r) => r.category === category) : fetched;

    return NextResponse.json({
      count: records.length,
      page_size: result.blobs.length,
      has_more: result.hasMore,
      cursor: result.cursor || null,
      category_filter: category || null,
      records,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
