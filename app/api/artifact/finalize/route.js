import { NextResponse } from 'next/server';
import { finalizeArtifact } from '../../../../lib/artifact-store';
import { deniedResponse, errorResponse, requireApiScope } from '../../../../lib/http-auth';

export const maxDuration = 60;

export async function POST(req) {
  const authorization = await requireApiScope(req, 'memory:write');
  if (authorization.error) return deniedResponse(authorization);
  try {
    const body = await req.json();
    const manifest = await finalizeArtifact(body);
    return manifest
      ? NextResponse.json({ ok: true, manifest })
      : NextResponse.json({ error: 'not_found', name: body.name, version: body.version }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
