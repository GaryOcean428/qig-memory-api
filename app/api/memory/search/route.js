import { NextResponse } from 'next/server';
import { authorize, unauthorizedReason } from '../../../../lib/auth.js';
import { searchMemory } from '../../../../lib/memory-store.js';

// A full search scans the corpus (auto-paginated), so give it headroom.
export const maxDuration = 60;

// GET  /api/memory/search?query=&category=&prefix=&limit=
//        → substring / category / prefix filtering.
// POST /api/memory/search { query, category, prefix, limit, basin: number[] }
//        → same, plus basin-nearest Fisher-Rao ranking when `basin` is provided
//          (the JSON body is used so large simplex vectors don't hit URL limits).
export async function GET(req) {
  if (!(await authorize(req, 'memory:read', { allowOAuth: true })))
    return NextResponse.json({ error: 'unauthorized', reason: await unauthorizedReason() }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get('limit') || '20', 10) || 20;

  try {
    const result = await searchMemory({
      query: searchParams.get('query') || undefined,
      category: searchParams.get('category') || undefined,
      prefix: searchParams.get('prefix') || '',
      limit,
    });
    return NextResponse.json(result);
  } catch (e) {
    console.log('[v0] memory search error:', e?.message || e);
    return NextResponse.json({ error: 'search_failed', detail: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  if (!(await authorize(req, 'memory:read', { allowOAuth: true })))
    return NextResponse.json({ error: 'unauthorized', reason: await unauthorizedReason() }, { status: 401 });

  try {
    const body = await req.json();
    const result = await searchMemory({
      query: body.query,
      category: body.category,
      prefix: body.prefix || '',
      basin: Array.isArray(body.basin) ? body.basin : undefined,
      limit: body.limit || 20,
    });
    return NextResponse.json(result);
  } catch (e) {
    console.log('[v0] memory search error:', e?.message || e);
    return NextResponse.json({ error: 'search_failed', detail: e.message }, { status: 500 });
  }
}
