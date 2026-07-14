import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/session';
import { createAuthorizationCode, getClient } from '../../../../lib/mcp-oauth-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function oauthError(redirectUri, error, state, description) {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  if (description) target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  return NextResponse.redirect(target);
}

export async function GET(request) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const responseType = url.searchParams.get('response_type');
  const codeChallenge = url.searchParams.get('code_challenge');
  const challengeMethod = url.searchParams.get('code_challenge_method');
  const state = url.searchParams.get('state');
  const scope = url.searchParams.get('scope') || 'mcp:tools';

  const client = await getClient(clientId);
  if (!client || !redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return NextResponse.json({ error: 'invalid_request', error_description: 'Unknown client or redirect URI.' }, { status: 400 });
  }
  if (responseType !== 'code' || !codeChallenge || challengeMethod !== 'S256') {
    return oauthError(redirectUri, 'invalid_request', state, 'Authorization code + PKCE S256 is required.');
  }

  const session = await getSession();
  if (!session) {
    const returnTo = `${url.pathname}${url.search}`;
    return NextResponse.redirect(new URL(`/api/auth/vercel/login?returnTo=${encodeURIComponent(returnTo)}`, url.origin));
  }

  const code = await createAuthorizationCode({
    clientId,
    redirectUri,
    codeChallenge,
    userId: session.user.id || session.user.email || session.user.username,
    scope,
  });
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  return NextResponse.redirect(target);
}
