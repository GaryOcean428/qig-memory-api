import { NextResponse } from 'next/server';
import { askHelper, HELPER_GUIDE, HELPER_RESOURCE_URI } from '../../../lib/helper-agent';
import { deniedResponse, errorResponse, requireApiScope } from '../../../lib/http-auth';

// Raised from 60 so the helper can convene the council when explicitly asked.
// council_convene returns immediately and finishes in the background via after(),
// whose work is bounded by this route's maxDuration — so match /api/mcp at 800.
export const maxDuration = 800;

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
    // The helper may only convene the council when the caller's own credential
    // carries write scope — convening persists a ruling and sends inbox mail.
    const writeCheck = await requireApiScope(req, 'memory:write');
    return NextResponse.json(await askHelper({ ...body, canConvene: !writeCheck.error }));
  } catch (error) {
    return errorResponse(error);
  }
}
