import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

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

// This deployment is PRIVATE: it is one operator's memory store, and a session
// grants the memory browser (including delete), API-key minting, OAuth client
// approval, doctrine editing and the chat. "Signed in with Vercel" is NOT an
// authorisation decision — anyone can create a Vercel account — so identity is
// checked against an explicit allowlist before any session is minted.
//
// OPERATOR_EMAILS (comma-separated) overrides the default without a redeploy.
// The default is a real address rather than "deny all" so a misconfigured env
// cannot lock the operator out of their own store; it is not a secret (it is
// already the commit author in this public repo).
const DEFAULT_OPERATOR_EMAILS = ['braden.lang77@gmail.com'];

export function operatorAllowlist() {
  const configured = String(process.env.OPERATOR_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_OPERATOR_EMAILS;
}

/** True only for an allowlisted operator identity. Case-insensitive on email. */
export function isOperatorIdentity(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return false;
  return operatorAllowlist().includes(email);
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

// Session sealing uses AES-256-GCM: the ciphertext keeps the OAuth access token
// confidential (SEC) and the GCM auth tag makes the cookie tamper-proof, so a
// forged or edited cookie is rejected by decodeSession instead of granting
// admin access. Cookie layout is base64url(iv[12] || tag[16] || ciphertext).
const SESSION_IV_BYTES = 12;
const SESSION_TAG_BYTES = 16;

// Dev-only key, used ONLY when the dev-login escape hatch is active (local /
// sandbox). A real deployment must never seal sessions with a hardcoded key.
const DEV_SESSION_SECRET = 'qig-memory-api-dev-session-secret';

// Derive the 32-byte AES key. In any real deployment a secret MUST be present
// (SESSION_SECRET, falling back to the OAuth client secret that the real login
// flow already requires). We only fall back to a fixed dev key when dev-login
// is allowed, matching the dev-login environment boundary.
function getSessionKey() {
  let secret = process.env.SESSION_SECRET || getClientSecret();
  if (!secret) {
    if (!isDevLoginAllowed()) {
      throw new Error(
        'SESSION_SECRET (or VERCEL_OAUTH_CLIENT_SECRET) must be set to seal sessions',
      );
    }
    secret = DEV_SESSION_SECRET;
  }
  return createHash('sha256').update(secret).digest();
}

/** Seal the minimal session payload into an encrypted, authenticated cookie. */
export function encodeSession(session) {
  const iv = randomBytes(SESSION_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getSessionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(session), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

/** Decrypt and verify a session cookie. Returns null for any tampered, forged
 * or otherwise unreadable value. */
export function decodeSession(value) {
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length <= SESSION_IV_BYTES + SESSION_TAG_BYTES) return null;
    const iv = raw.subarray(0, SESSION_IV_BYTES);
    const tag = raw.subarray(SESSION_IV_BYTES, SESSION_IV_BYTES + SESSION_TAG_BYTES);
    const ciphertext = raw.subarray(SESSION_IV_BYTES + SESSION_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', getSessionKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
}
