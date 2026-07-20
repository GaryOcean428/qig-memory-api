import { NextResponse } from 'next/server';
import { authorizeDetailed, unauthorizedReason } from '../../../../lib/auth.js';
import {
  getMemory,
  keyToPath,
  writeRecord,
  putMemory,
  postMemory,
  deleteMemory,
  ContentTooLargeError,
  MAX_CONTENT_BYTES,
} from '../../../../lib/memory-store.js';

async function requireScope(req, scope) {
  return authorizeDetailed(req, scope, { allowOAuth: true });
}

async function denied(result) {
  const reason = result.error === 'insufficient_scope' ? 'insufficient_scope' : await unauthorizedReason();
  const challenge = result.error === 'insufficient_scope'
    ? `Bearer error="insufficient_scope", scope="${result.requiredScope}"`
    : 'Bearer';
  return NextResponse.json(
    { error: result.error, reason, required_scope: result.requiredScope || undefined },
    { status: result.status, headers: { 'www-authenticate': challenge } },
  );
}

export async function GET(req, { params }) {
  const authorization = await requireScope(req, 'memory:read');
  if (authorization.error) return denied(authorization);
  const { key } = await params;
  const bump = new URL(req.url).searchParams.get('bump') === '1';
  const record = await getMemory(key);
  if (!record) return NextResponse.json({ error: 'not_found', key }, { status: 404 });
  if (!bump) return NextResponse.json(record);

  const updated = {
    ...record,
    retrieval_count: (record.retrieval_count || 0) + 1,
    last_retrieved: new Date().toISOString(),
  };
  const { key: _key, ...stored } = updated;
  await writeRecord(keyToPath(key), stored);
  return NextResponse.json(updated);
}

export async function PUT(req, { params }) {
  const authorization = await requireScope(req, 'memory:write');
  if (authorization.error) return denied(authorization);
  const { key } = await params;
  try {
    const body = await req.json();
    const record = await putMemory(key, body);
    if (new URL(req.url).searchParams.get('verify') === '1') {
      const verified = await getMemory(key);
      return NextResponse.json({ ok: true, verified: verified?.content === record.content, ...record });
    }
    return NextResponse.json({ ok: true, ...record });
  } catch (error) {
    if (error instanceof ContentTooLargeError) {
      return NextResponse.json({ error: error.code, max_bytes: MAX_CONTENT_BYTES, got_bytes: error.bytes }, { status: 413 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  const authorization = await requireScope(req, 'memory:write');
  if (authorization.error) return denied(authorization);
  const { key } = await params;
  const record = await postMemory(key, await req.json());
  if (!record) return NextResponse.json({ error: 'not_found', key }, { status: 404 });
  return NextResponse.json({ ok: true, ...record });
}

export async function DELETE(req, { params }) {
  const authorization = await requireScope(req, 'memory:delete');
  if (authorization.error) return denied(authorization);
  const { key } = await params;
  if (!(await deleteMemory(key))) return NextResponse.json({ error: 'not_found', key }, { status: 404 });
  return NextResponse.json({ ok: true, deleted: key });
}
