import { NextResponse } from 'next/server';
import { initiateArtifact } from '../../../lib/artifact-store';
import { deniedResponse, errorResponse, requireApiScope } from '../../../lib/http-auth';

export async function POST(req) {
  const authorization = await requireApiScope(req, 'memory:write');
  if (authorization.error) return deniedResponse(authorization);
  try {
    return NextResponse.json(await initiateArtifact(await req.json()), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
