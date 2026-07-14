import { streamArtifactRows } from '../../../../../../lib/artifact-store';
import { deniedResponse, errorResponse, requireApiScope } from '../../../../../../lib/http-auth';

export async function GET(req, { params }) {
  const authorization = await requireApiScope(req, 'memory:read');
  if (authorization.error) return deniedResponse(authorization);
  try {
    const { name, version } = await params;
    const query = new URL(req.url).searchParams;
    const result = await streamArtifactRows({
      name,
      version,
      start: query.get('start'),
      end: query.get('end'),
    });
    if (!result) return Response.json({ error: 'not_found' }, { status: 404 });
    return new Response(result.stream, {
      status: 206,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(result.byteEnd - result.byteStart + 1),
        'content-range': `bytes ${result.byteStart}-${result.byteEnd}/${result.manifest.byte_length}`,
        'accept-ranges': 'bytes',
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
