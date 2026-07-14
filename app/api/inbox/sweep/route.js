import { NextResponse } from 'next/server';
import { deniedResponse, errorResponse, requireApiScope } from '../../../../lib/http-auth';
import { sweepInbox } from '../../../../lib/inbox-store';

export async function POST(req) {
  const authorization = await requireApiScope(req, 'memory:write');
  if (authorization.error) return deniedResponse(authorization);
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json(await sweepInbox(body));
  } catch (error) {
    return errorResponse(error);
  }
}
