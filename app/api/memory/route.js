import { list } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { auth, unauthorizedReason } from '../../../lib/auth.js';

const PREFIX = 'memory/';
const MAX_PAGE = 1000;
const DEFAULT_PAGE = 100;

// A full-content listing of 1700+ blobs fetches each body over the network, so
// give it headroom. Heavy enumeration should still prefer keys_only=true.
export const maxDuration = 60;

const AUTO_PAGE_CAP = 5000;

// Walk every blob page via the cursor, up to a safety cap. Returns the same
// normalized shape as a single `list()` call so callers stay uniform.
async function listAllBlobs(blobPrefix, startCursor) {
  const blobs = [];
  let cursor = startCursor;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await list({ prefix: blobPrefix, limit: MAX_PAGE, cursor });
    blobs.push(...page.blobs);
    cursor = page.cursor || null;
    if (!page.hasMore) return { blobs, hasMore: false, cursor: null };
    if (blobs.length >= AUTO_PAGE_CAP) return { blobs, hasMore: true, cursor };
  }
}

// GET /api/memory
//   ?keys_only=true         — full key index; auto-paginated to completion by default (no cursor loop needed)
//   ?all=true               — fetch every content page in one request (bounded)
//   ?cursor=<opaque>        — continue from previous page (Vercel Blob cursor pagination)
//   ?limit=N                — page size (max 1000, default 100)
//   ?category=foo           — filter by category (only honoured when keys_only is false)
//   ?prefix=foo_            — restrict to keys starting with prefix (server-side via blob prefix)
//
// Returns: { count, page_size, has_more, cursor, complete, category_filter, records }
// keys_only returns the complete index in one call. For content, if has_more is
// true, loop on `cursor` until has_more === false (or pass all=true).
export async function GET(req) {
  if (!(await auth(req)))
    return NextResponse.json({ error: 'unauthorized', reason: await unauthorizedReason() }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category');
  const keysOnly = searchParams.get('keys_only') === 'true';
  const fetchAll = searchParams.get('all') === 'true';
  const cursor = searchParams.get('cursor') || undefined;
  const userPrefix = searchParams.get('prefix') || '';
  const limit = Math.min(
    Math.max(parseInt(searchParams.get('limit') || String(DEFAULT_PAGE), 10) || DEFAULT_PAGE, 1),
    MAX_PAGE
  );

  // Build effective blob prefix — pushes filtering down to Vercel Blob
  const blobPrefix = `${PREFIX}${userPrefix}`;

  try {
    // keys_only defaults to walking the whole index; an explicit cursor opts
    // back into manual paging. A category filter is applied AFTER fetching, so
    // it must also walk every page or matches on page 2+ look empty.
    const walkAll = fetchAll || ((keysOnly || !!category) && !cursor);
    const result = walkAll
      ? await listAllBlobs(blobPrefix, cursor)
      : await list({ prefix: blobPrefix, limit, cursor });

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
        complete: !result.hasMore,
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
      complete: !result.hasMore,
      category_filter: category || null,
      records,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
