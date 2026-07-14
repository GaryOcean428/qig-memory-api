import { NextResponse } from 'next/server';
import { deniedResponse, errorResponse, requireApiScope } from '../../../lib/http-auth';
import { listInboxMessages, sendInboxMessage } from '../../../lib/inbox-store';

export async function GET(req) {
  const authorization = await requireApiScope(req, 'memory:read');
  if (authorization.error) return deniedResponse(authorization);
  const query = new URL(req.url).searchParams;
  try {
    return NextResponse.json(await listInboxMessages({
      namespace: query.get('namespace') || undefined,
      recipient: query.get('recipient') || undefined,
      status: query.get('status') || undefined,
      include_broadcast: query.get('include_broadcast') !== 'false',
      limit: Number(query.get('limit')) || undefined,
      cursor: query.get('cursor') || undefined,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req) {
  const authorization = await requireApiScope(req, 'memory:write');
  if (authorization.error) return deniedResponse(authorization);
  try {
    return NextResponse.json({ ok: true, message: await sendInboxMessage(await req.json()) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
