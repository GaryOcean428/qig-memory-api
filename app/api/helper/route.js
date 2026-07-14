import { NextResponse } from 'next/server';
import { askHelper, HELPER_GUIDE, HELPER_RESOURCE_URI } from '../../../lib/helper-agent';
import { deniedResponse, errorResponse, requireApiScope } from '../../../lib/http-auth';

export const maxDuration = 60;

export async function GET(req) {
  const authorization = await requireApiScope(req, 'memory:read');
  if (authorization.error) return deniedResponse(authorization);
  return NextResponse.json({ uri: HELPER_RESOURCE_URI, mime_type: 'text/markdown', guide: HELPER_GUIDE });
}

export async function POST(req) {
  const authorization = await requireApiScope(req, 'memory:read');
  if (authorization.error) return deniedResponse(authorization);
  try {
    const body = await req.json();
    if (!body.question || typeof body.question !== 'string') {
      return NextResponse.json({ error: 'invalid_input', message: 'question is required' }, { status: 400 });
    }
    return NextResponse.json(await askHelper(body));
  } catch (error) {
    return errorResponse(error);
  }
}
