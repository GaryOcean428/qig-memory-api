import { NextResponse } from 'next/server';
import { authorize, unauthorizedReason } from '../../../lib/auth.js';
import { listMemory } from '../../../lib/memory-store.js';

export const maxDuration = 60;

export async function GET(req) {
  if (!(await authorize(req, 'memory:read', { allowOAuth: true }))) {
    return NextResponse.json({ error: 'unauthorized', reason: await unauthorizedReason() }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 100, 1), 1000);
  try {
    const category = searchParams.get('category') || undefined;
    const result = await listMemory({
      category,
      prefix: searchParams.get('prefix') || '',
      keysOnly: searchParams.get('keys_only') === 'true',
      all: searchParams.get('all') === 'true',
      cursor: searchParams.get('cursor') || undefined,
      limit,
    });
    return NextResponse.json({
      ...result,
      count: result.count ?? result.key_count ?? result.records.length,
      page_size: result.records.length,
      category_filter: category || null,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
