import { NextResponse } from 'next/server';
import { deniedResponse, errorResponse, requireApiScope } from '../../../../lib/http-auth';
import { acknowledgeInboxMessage, readInboxMessage } from '../../../../lib/inbox-store';

export async function GET(req, { params }) {
  const authorization = await requireApiScope(req, 'memory:read');
  if (authorization.error) return deniedResponse(authorization);
  try {
    const { id } = await params;
    const message = await readInboxMessage(id, {
      markRead: new URL(req.url).searchParams.get('mark_read') !== 'false',
    });
    return message
      ? NextResponse.json(message)
      : NextResponse.json({ error: 'not_found', id }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req, { params }) {
  const authorization = await requireApiScope(req, 'memory:write');
  if (authorization.error) return deniedResponse(authorization);
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (body.action !== 'ack') {
      return NextResponse.json({ error: 'invalid_input', message: 'action must be ack' }, { status: 400 });
    }
    const message = await acknowledgeInboxMessage(id);
    return message
      ? NextResponse.json({ ok: true, message })
      : NextResponse.json({ error: 'not_found', id }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
