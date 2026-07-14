import { NextResponse } from 'next/server';
import { isSafeRedirectUri, registerClient } from '../../../../lib/mcp-oauth-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_client_metadata' }, { status: 400 });
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!redirectUris.length || redirectUris.length > 10 || redirectUris.some((uri) => !isSafeRedirectUri(uri))) {
    return NextResponse.json(
      { error: 'invalid_redirect_uri', error_description: 'Use HTTPS or a loopback HTTP redirect URI.' },
      { status: 400 },
    );
  }
  const client = await registerClient({ redirectUris, clientName: body.client_name });
  return NextResponse.json(client, {
    status: 201,
    headers: { 'cache-control': 'no-store' },
  });
}
