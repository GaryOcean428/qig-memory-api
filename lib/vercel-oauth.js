import { createHash, randomBytes } from 'node:crypto';

// Authoritative endpoints from https://vercel.com/.well-known/openid-configuration
export const VERCEL_OAUTH = {
  authorizationEndpoint: 'https://vercel.com/oauth/authorize',
  tokenEndpoint: 'https://api.vercel.com/login/oauth/token',
  userinfoEndpoint: 'https://api.vercel.com/login/oauth/userinfo',
  revocationEndpoint: 'https://api.vercel.com/login/oauth/token/revoke',
  scopes: 'openid email profile',
};

export const COOKIES = {
  session: 'qig_session',
  state: 'qig_oauth_state',
  verifier: 'qig_oauth_verifier',
  returnTo: 'qig_oauth_return_to',
};

export function getClientId() {
  return process.env.VERCEL_OAUTH_CLIENT_ID || '';
}

export function getClientSecret() {
  return process.env.VERCEL_OAUTH_CLIENT_SECRET || '';
}

export function isOAuthConfigured() {
  return Boolean(getClientId() && getClientSecret());
}

// Guarded dev-login escape hatch. It exists ONLY to let the admin UI be tested
// in the local/sandbox dev server — where the real OAuth redirect URI (the
// ephemeral sandbox origin) cannot be registered with Vercel, so the true flow
// can't complete. The security boundary is the ENVIRONMENT, not whether OAuth
// keys are present: it is hard-disabled on every deployment. It returns false
// when the app is built for production (NODE_ENV) or running on ANY Vercel
// deployment (VERCEL_ENV is set on preview + production builds).
export function isDevLoginAllowed() {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.VERCEL_ENV) return false;
  return true;
}

/** Build the redirect URI from the incoming request origin so it works in every environment. */
export function getRedirectUri(request) {
  const origin = new URL(request.url).origin;
  return `${origin}/api/auth/vercel/callback`;
}

function base64url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Generate a PKCE verifier/challenge pair (S256). */
export function createPkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function createState() {
  return base64url(randomBytes(24));
}

/** Standard httpOnly cookie options for auth cookies. */
export function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForTokens({ code, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: getClientId(),
    client_secret: getClientSecret(),
    code_verifier: codeVerifier,
  });

  const res = await fetch(VERCEL_OAUTH.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return res.json();
}

/** Fetch the authenticated user's profile. */
export async function fetchUserInfo(accessToken) {
  const res = await fetch(VERCEL_OAUTH.userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Userinfo request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return res.json();
}

/** Best-effort token revocation on logout. */
export async function revokeToken(token) {
  try {
    const basic = Buffer.from(`${getClientId()}:${getClientSecret()}`).toString('base64');
    await fetch(VERCEL_OAUTH.revocationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Revocation is best-effort; ignore network errors.
  }
}

/** Serialize the minimal session payload stored in the httpOnly cookie. */
export function encodeSession(session) {
  return Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
}

export function decodeSession(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
