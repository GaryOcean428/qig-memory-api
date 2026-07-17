import { NextResponse } from 'next/server';
import {
  COOKIES,
  getRedirectUri,
  isOAuthConfigured,
  isOperatorIdentity,
  exchangeCodeForTokens,
  fetchUserInfo,
  cookieOptions,
  encodeSession,
} from '../../../../../lib/vercel-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorRedirect(origin, code) {
  return NextResponse.redirect(`${origin}/?auth_error=${encodeURIComponent(code)}`);
}

export async function GET(request) {
  const url = new URL(request.url);
  const origin = url.origin;

  if (!isOAuthConfigured()) {
    return errorRedirect(origin, 'oauth_not_configured');
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return errorRedirect(origin, oauthError);
  }

  const storedState = request.cookies.get(COOKIES.state)?.value;
  const codeVerifier = request.cookies.get(COOKIES.verifier)?.value;
  const returnTo = request.cookies.get(COOKIES.returnTo)?.value || '/';

  if (!code || !returnedState || !storedState || returnedState !== storedState || !codeVerifier) {
    return errorRedirect(origin, 'invalid_state');
  }

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      redirectUri: getRedirectUri(request),
      codeVerifier,
    });

    const profile = await fetchUserInfo(tokens.access_token);

    // Authentication is not authorisation. A valid Vercel login proves who you
    // are, not that you may operate this store.
    if (!isOperatorIdentity({ email: profile.email })) {
      console.log('[v0] auth denied for non-operator:', profile.email || '(no email)');
      return errorRedirect(origin, 'not_authorized');
    }

    const session = {
      user: {
        id: profile.sub,
        username: profile.preferred_username || null,
        email: profile.email || null,
        name: profile.name || profile.preferred_username || null,
        picture: profile.picture || null,
      },
      accessToken: tokens.access_token,
      createdAt: Date.now(),
    };

    const safeReturn = returnTo.startsWith('/') ? returnTo : '/';
    const response = NextResponse.redirect(`${origin}${safeReturn}`);

    const sevenDays = 60 * 60 * 24 * 7;
    response.cookies.set(COOKIES.session, encodeSession(session), cookieOptions(sevenDays));
    // Clear the transient flow cookies.
    response.cookies.set(COOKIES.state, '', cookieOptions(0));
    response.cookies.set(COOKIES.verifier, '', cookieOptions(0));
    response.cookies.set(COOKIES.returnTo, '', cookieOptions(0));
    return response;
  } catch (err) {
    console.log('[v0] Vercel OAuth callback error:', err?.message);
    return errorRedirect(origin, 'token_exchange_failed');
  }
}
