import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// RFC 9728 path-aware discovery location for the /api/mcp resource.
export async function GET(request) {
  const origin = new URL(request.url).origin;
  return NextResponse.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${origin}/#connect`,
    },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}
