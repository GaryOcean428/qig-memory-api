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

async function validate(params) {
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const responseType = params.get('response_type');
  const codeChallenge = params.get('code_challenge');
  const challengeMethod = params.get('code_challenge_method');
  const state = params.get('state');
  const scope = params.get('scope') || 'mcp:tools';
  const client = await getClient(clientId);

  if (!client || !redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return { response: NextResponse.json({ error: 'invalid_request', error_description: 'Unknown client or redirect URI.' }, { status: 400 }) };
  }
  if (responseType !== 'code' || !codeChallenge || challengeMethod !== 'S256') {
    return { response: oauthError(redirectUri, 'invalid_request', state, 'Authorization code + PKCE S256 is required.') };
  }
  if (scope !== 'mcp:tools') {
    return { response: oauthError(redirectUri, 'invalid_scope', state, 'Only the mcp:tools scope is supported.') };
  }

  return { client, clientId, redirectUri, codeChallenge, state, scope };
}

export async function GET(request) {
  const url = new URL(request.url);
  const result = await validate(url.searchParams);
  if (result.response) return result.response;

  const session = await getSession();
  if (!session) {
    const returnTo = `${url.pathname}${url.search}`;
    return NextResponse.redirect(new URL(`/api/auth/vercel/login?returnTo=${encodeURIComponent(returnTo)}`, url.origin));
  }

  // Never auto-approve a dynamically registered client. Send the authenticated
  // user to an explicit consent screen that identifies the client and scope.
  return NextResponse.redirect(new URL(`/oauth/consent?${url.searchParams.toString()}`, url.origin));
}

export async function POST(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) {
    return NextResponse.json({ error: 'invalid_request', error_description: 'Cross-origin consent is not allowed.' }, { status: 403 });
  }

  const form = await request.formData();
  const params = new URLSearchParams();
  for (const key of ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope']) {
    const value = form.get(key);
    if (typeof value === 'string') params.set(key, value);
  }
  const result = await validate(params);
  if (result.response) return result.response;

  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'login_required' }, { status: 401 });
  if (form.get('decision') !== 'allow') {
    return oauthError(result.redirectUri, 'access_denied', result.state, 'The user denied access.');
  }

  const code = await createAuthorizationCode({
    clientId: result.clientId,
    redirectUri: result.redirectUri,
    codeChallenge: result.codeChallenge,
    userId: session.user.id || session.user.email || session.user.username,
    scope: result.scope,
  });
  const target = new URL(result.redirectUri);
  target.searchParams.set('code', code);
  if (result.state) target.searchParams.set('state', result.state);
  return NextResponse.redirect(target);
}
