import { NextResponse } from 'next/server';
import { getArtifactManifest, getArtifactRows } from '../../../../lib/artifact-store';
import { deniedResponse, errorResponse, requireApiScope } from '../../../../lib/http-auth';

export async function GET(req, { params }) {
  const authorization = await requireApiScope(req, 'memory:read');
  if (authorization.error) return deniedResponse(authorization);
  try {
    const { name } = await params;
    const query = new URL(req.url).searchParams;
    const version = query.get('version') || undefined;
    if (query.has('start') || query.has('end')) {
      const rows = await getArtifactRows({
        name,
        version,
        start: query.get('start'),
        end: query.get('end'),
        origin: new URL(req.url).origin,
      });
      return rows ? NextResponse.json(rows) : NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const manifest = await getArtifactManifest(name, version);
    return manifest ? NextResponse.json(manifest) : NextResponse.json({ error: 'not_found' }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
