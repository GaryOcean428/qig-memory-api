import { NextResponse } from 'next/server';
import { authorize, unauthorizedReason } from '../../../../lib/auth.js';
import {
  getMemory,
  putMemory,
  postMemory,
  deleteMemory,
  ContentTooLargeError,
  MAX_CONTENT_BYTES,
} from '../../../../lib/memory-store.js';

async function requireScope(req, scope) {
  return authorize(req, scope, { allowOAuth: true });
}

function denied(reason, status = 401) {
  return NextResponse.json({ error: 'unauthorized', reason }, { status });
}

export async function GET(req, { params }) {
  if (!(await requireScope(req, 'memory:read'))) return denied(await unauthorizedReason());
  const { key } = await params;
  const record = await getMemory(key);
  if (!record) return NextResponse.json({ error: 'not_found', key }, { status: 404 });
  return NextResponse.json(record);
}

export async function PUT(req, { params }) {
  if (!(await requireScope(req, 'memory:write'))) return denied(await unauthorizedReason());
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
  if (!(await requireScope(req, 'memory:write'))) return denied(await unauthorizedReason());
  const { key } = await params;
  const record = await postMemory(key, await req.json());
  if (!record) return NextResponse.json({ error: 'not_found', key }, { status: 404 });
  return NextResponse.json({ ok: true, ...record });
}

export async function DELETE(req, { params }) {
  if (!(await requireScope(req, 'memory:admin'))) return denied(await unauthorizedReason());
  const { key } = await params;
  if (!(await deleteMemory(key))) return NextResponse.json({ error: 'not_found', key }, { status: 404 });
  return NextResponse.json({ ok: true, deleted: key });
}
