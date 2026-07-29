import { NextResponse } from 'next/server';
import { finalizeArtifact } from '../../../../lib/artifact-store';
import { deniedResponse, errorResponse, requireApiScope } from '../../../../lib/http-auth';
import { namespacePermits } from '../../../../lib/auth';

export const maxDuration = 60;

export async function POST(req) {
  const authorization = await requireApiScope(req, 'memory:write');
  if (authorization.error) return deniedResponse(authorization);
  // finalizeArtifact broadcasts artifact_updated to the hardcoded 'qig'
  // namespace (lib/artifact-store.js) — same rule as /api/council.
  if (!namespacePermits(authorization.principal, 'qig')) {
    return NextResponse.json(
      { error: 'namespace_restricted', message: 'namespace-restricted credentials without "qig" access cannot finalize artifacts' },
      { status: 403 },
    );
  }
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
