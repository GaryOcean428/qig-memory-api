import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/session';
import {
  consumeConsentToken,
  createAuthorizationCode,
  createConsentToken,
  getClient,
} from '../../../../lib/mcp-oauth-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function oauthError(redirectUri, error, state, description) {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  if (description) target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  return NextResponse.redirect(target, { status: 303 });
}

async function validate(params) {
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const responseType = params.get('response_type');
  const codeChallenge = params.get('code_challenge');
  const challengeMethod = params.get('code_challenge_method');
  const state = params.get('state');
  const requestedScopes = (params.get('scope') || 'memory:read').split(/\s+/).filter(Boolean);
  const client = await getClient(clientId);

  if (!client || !redirectUri || !client.redirect_uris.includes(redirectUri)) {
    // Cannot safely redirect: without a validated client + redirect_uri, bouncing
    // the error back would be an open redirect. The GET (browser) path turns this
    // into a human-readable reconnect page; POST keeps the strict JSON 400.
    return {
      unknownClient: true,
      response: NextResponse.json(
        { error: 'invalid_request', error_description: 'Unknown client or redirect URI.' },
        { status: 400 },
      ),
    };
  }
  if (client.revoked_at) {
    return { response: oauthError(redirectUri, 'unauthorized_client', state, 'This OAuth client has been revoked.') };
  }
  if (responseType !== 'code' || !codeChallenge || challengeMethod !== 'S256') {
    return { response: oauthError(redirectUri, 'invalid_request', state, 'Authorization code + PKCE S256 is required.') };
  }
  const approvedScopes = new Set(client.approved_scopes || ['memory:read']);
  if (!requestedScopes.length || requestedScopes.some((scope) => !approvedScopes.has(scope))) {
    return { response: oauthError(redirectUri, 'invalid_scope', state, 'This client is not approved for one or more requested scopes.') };
  }

  return { client, clientId, redirectUri, codeChallenge, state, scope: requestedScopes.join(' ') };
}

// Human-readable page for the most common connector failure: a stale/unknown
// client_id (e.g. a cached registration from a previous deployment). Rendered
// only on the browser GET path so the user gets actionable guidance instead of
// a bare JSON 400.
function unknownClientPage() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<title>Reconnect required · QIG Memory API</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 1.5rem; background: #0a0a0a; color: #ededed;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.6;
  }
  .card {
    width: 100%; max-width: 30rem; background: #131313; border: 1px solid #262626;
    border-radius: 14px; padding: 2rem; box-shadow: 0 10px 40px rgba(0,0,0,0.4);
  }
  .badge {
    display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.05em; color: #fbbf24;
    background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.25);
    padding: 0.25rem 0.6rem; border-radius: 999px; margin-bottom: 1.25rem;
  }
  h1 { font-size: 1.35rem; margin: 0 0 0.75rem; letter-spacing: -0.01em; }
  p { margin: 0 0 1rem; color: #a3a3a3; }
  ol { margin: 0 0 1rem; padding-left: 1.25rem; color: #d4d4d4; }
  li { margin-bottom: 0.4rem; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em;
    background: #1f1f1f; border: 1px solid #2e2e2e; padding: 0.15rem 0.4rem; border-radius: 6px;
    color: #e5e5e5; word-break: break-all;
  }
  .hint { font-size: 0.8rem; color: #737373; border-top: 1px solid #262626; padding-top: 1rem; margin-top: 1.25rem; }
</style>
</head>
<body>
  <main class="card">
    <span class="badge">Reconnect required</span>
    <h1>This connection is out of date</h1>
    <p>The client credentials your MCP app sent aren&apos;t recognized by this server. This usually means the connector cached a registration from an earlier version and needs to register again.</p>
    <p>To fix it, remove and re-add this MCP server in your client so it performs a fresh registration:</p>
    <ol>
      <li>Remove the existing <code>qig-memory</code> connection.</li>
      <li>Add it again, pointing at <code>https://qig-memory-api.vercel.app/api/mcp</code>.</li>
      <li>Complete the sign-in prompt when it reopens.</li>
    </ol>
    <p class="hint">If you keep seeing this after re-adding, the server may need its latest deployment published. No action is needed on this page&mdash;you can close it.</p>
  </main>
</body>
</html>`;
  return new NextResponse(html, {
    status: 400,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(request) {
  const url = new URL(request.url);
  const result = await validate(url.searchParams);
  if (result.unknownClient) return unknownClientPage();
  if (result.response) return result.response;

  const session = await getSession();
  if (!session) {
    const returnTo = `${url.pathname}${url.search}`;
    return NextResponse.redirect(new URL(`/api/auth/vercel/login?returnTo=${encodeURIComponent(returnTo)}`, url.origin));
  }

  const userId = session.user.id || session.user.email || session.user.username;
  const consentToken = createConsentToken({
    clientId: result.clientId,
    redirectUri: result.redirectUri,
    codeChallenge: result.codeChallenge,
    userId,
    scope: result.scope,
  });
  const consentParams = new URLSearchParams(url.searchParams);
  consentParams.set('consent_token', consentToken);
  return NextResponse.redirect(new URL(`/oauth/consent?${consentParams.toString()}`, url.origin));
}

export async function POST(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin !== url.origin) {
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
  const userId = session.user.id || session.user.email || session.user.username;
  const consentValid = await consumeConsentToken(form.get('consent_token'), {
    clientId: result.clientId,
    redirectUri: result.redirectUri,
    codeChallenge: result.codeChallenge,
    userId,
    scope: result.scope,
  });
  if (!consentValid) {
    return NextResponse.json({ error: 'invalid_request', error_description: 'Consent token is missing, expired, or already used.' }, { status: 403 });
  }
  if (form.get('decision') !== 'allow') {
    return oauthError(result.redirectUri, 'access_denied', result.state, 'The user denied access.');
  }

  const code = await createAuthorizationCode({
    clientId: result.clientId,
    redirectUri: result.redirectUri,
    codeChallenge: result.codeChallenge,
    userId,
    scope: result.scope,
  });
  const target = new URL(result.redirectUri);
  target.searchParams.set('code', code);
  if (result.state) target.searchParams.set('state', result.state);
  return NextResponse.redirect(target, { status: 303 });
}
