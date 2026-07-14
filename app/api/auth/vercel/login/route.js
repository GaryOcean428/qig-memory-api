import { NextResponse } from 'next/server';
import {
  VERCEL_OAUTH,
  COOKIES,
  getClientId,
  getRedirectUri,
  isOAuthConfigured,
  createPkcePair,
  createState,
  cookieOptions,
} from '../../../../../lib/vercel-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const url = new URL(request.url);

  if (!isOAuthConfigured()) {
    return NextResponse.redirect(`${url.origin}/?auth_error=oauth_not_configured`);
  }

  const returnTo = url.searchParams.get('returnTo') || '/';

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const redirectUri = getRedirectUri(request);

  const authorizeUrl = new URL(VERCEL_OAUTH.authorizationEndpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', getClientId());
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', VERCEL_OAUTH.scopes);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const response = NextResponse.redirect(authorizeUrl.toString());
  const tenMinutes = 60 * 10;
  response.cookies.set(COOKIES.state, state, cookieOptions(tenMinutes));
  response.cookies.set(COOKIES.verifier, verifier, cookieOptions(tenMinutes));
  response.cookies.set(COOKIES.returnTo, returnTo, cookieOptions(tenMinutes));
  return response;
}
