import { put, list, del, head, BlobNotFoundError } from '@vercel/blob';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const PREFIX = 'mcp-oauth/';
const CLIENT_PREFIX = `${PREFIX}clients/`;
const CODE_PREFIX = `${PREFIX}codes/`;
const TOKEN_PREFIX = `${PREFIX}tokens/`;
const CLAIM_PREFIX = `${PREFIX}claims/`;
const REGISTRATION_PREFIX = `${PREFIX}registration-limits/`;
const ACCESS_TTL_SECONDS = 60 * 60;
const CODE_TTL_SECONDS = 5 * 60;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const MAX_REGISTRATIONS = 20;

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const opaque = (prefix) => `${prefix}${randomBytes(32).toString('base64url')}`;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function storageKey() {
  const secret = process.env.SESSION_SECRET || process.env.VERCEL_OAUTH_CLIENT_SECRET;
  if (!secret && (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV)) {
    throw new Error('SESSION_SECRET or VERCEL_OAUTH_CLIENT_SECRET is required for OAuth storage.');
  }
  return createHash('sha256').update(secret || 'qig-local-oauth-storage-only').digest();
}

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', storageKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: ciphertext.toString('base64url'),
  });
}

function unseal(value) {
  try {
    const envelope = JSON.parse(value);
    if (envelope?.v !== 1 || !envelope.iv || !envelope.tag || !envelope.data) return null;
    const decipher = createDecipheriv('aes-256-gcm', storageKey(), Buffer.from(envelope.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
}

// Blob URLs are public because this store uses the public Blob product, but
// only authenticated ciphertext is ever written. OAuth records are therefore
// confidential and tamper-evident even if a blob URL is disclosed.
async function writeJson(path, value, { overwrite = true } = {}) {
  await put(path, seal(value), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: overwrite,
    contentType: 'application/octet-stream',
    cacheControlMaxAge: 0,
  });
}

// Point-reads use head(pathname) — a consistent metadata lookup — instead of
// list(), which is eventually consistent and can lag ~seconds after a put().
// That lag broke the claude.ai connector flow: DCR registration immediately
// followed by /authorize could not find the just-written client record.
async function readJson(path) {
  try {
    const blob = await head(path);
    const response = await fetch(`${blob.url}?v=${encodeURIComponent(blob.uploadedAt)}`, { cache: 'no-store' });
    return response.ok ? unseal(await response.text()) : null;
  } catch (error) {
    // A missing blob is the expected "not found" case; anything else (access
    // denied, misconfigured store, network fault) is a real fault we surface in
    // logs rather than silently masking as an empty record.
    if (error instanceof BlobNotFoundError) return null;
    console.log('[v0] oauth readJson error:', path, error?.message);
    return null;
  }
}

async function remove(path) {
  try {
    await del(path);
  } catch (error) {
    // Deletion is idempotent: an already-gone blob is success. Other failures
    // (permissions, store config, network) are logged instead of swallowed.
    if (error instanceof BlobNotFoundError) return;
    console.log('[v0] oauth remove error:', path, error?.message);
  }
}

// A create-only claim makes read/consume single-winner across concurrent
// serverless invocations. The high-entropy artifact hash keeps claim paths
// unguessable, and claims intentionally remain as replay tombstones.
async function claimOnce(kind, artifact) {
  const path = `${CLAIM_PREFIX}${kind}/${hash(artifact || '')}.lock`;
  try {
    await writeJson(path, { claimed_at: Date.now() }, { overwrite: false });
    return true;
  } catch {
    return false;
  }
}

export async function claimClientRegistration(address) {
  const bucket = Math.floor(Date.now() / REGISTRATION_WINDOW_MS);
  const addressHash = hash(address || 'unknown');
  for (let slot = 0; slot < MAX_REGISTRATIONS; slot += 1) {
    const path = `${REGISTRATION_PREFIX}${bucket}/${addressHash}/${slot}.lock`;
    try {
      await writeJson(path, { created_at: Date.now() }, { overwrite: false });
      return true;
    } catch {
      // This durable slot is occupied; try the next one.
    }
  }
  return false;
}

export async function registerClient({ redirectUris, clientName }) {
  const clientId = `qig_client_${randomBytes(18).toString('base64url')}`;
  const record = {
    client_id: clientId,
    client_name: String(clientName || 'MCP client').slice(0, 120),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    approved_scopes: ['memory:read'],
    trusted: false,
    created_at: new Date().toISOString(),
  };
  await writeJson(`${CLIENT_PREFIX}${hash(clientId)}.json`, record);
  return record;
}

export function isSafeRedirectUri(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function getClient(clientId) {
  if (!clientId) return null;
  return readJson(`${CLIENT_PREFIX}${hash(clientId)}.json`);
}

export async function listOAuthClients() {
  const { blobs } = await list({ prefix: CLIENT_PREFIX, limit: 1000 });
  const clients = await Promise.all(blobs.map((blob) => readJson(blob.pathname)));
  return clients.filter(Boolean).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function setClientAccess(clientId, mode, approvedBy = null) {
  const client = await getClient(clientId);
  if (!client) return null;
  const now = new Date().toISOString();
  const trusted = mode === 'operator';
  const revoked = mode === 'revoked';
  const updated = {
    ...client,
    trusted,
    approved_scopes: revoked ? [] : trusted ? ['memory:read', 'memory:write', 'memory:admin'] : ['memory:read'],
    approved_by: approvedBy,
    approval_updated_at: now,
    revoked_at: revoked ? now : null,
  };
  await writeJson(`${CLIENT_PREFIX}${hash(clientId)}.json`, updated);
  return updated;
}

export async function setClientTrust(clientId, trusted, approvedBy = null) {
  return setClientAccess(clientId, trusted ? 'operator' : 'read', approvedBy);
}

export function createConsentToken({ clientId, redirectUri, codeChallenge, userId, scope }) {
  return seal({
    type: 'consent',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    user_id: userId,
    scope,
    nonce: randomBytes(16).toString('base64url'),
    expires_at: Date.now() + CODE_TTL_SECONDS * 1000,
  });
}

export async function consumeConsentToken(token, expected) {
  if (!token || !(await claimOnce('consent', token))) return false;
  const record = unseal(token);
  return Boolean(
    record &&
    record.type === 'consent' &&
    record.expires_at >= Date.now() &&
    safeEqual(record.client_id, expected.clientId) &&
    safeEqual(record.redirect_uri, expected.redirectUri) &&
    safeEqual(record.code_challenge, expected.codeChallenge) &&
    safeEqual(record.user_id, expected.userId) &&
    safeEqual(record.scope, expected.scope),
  );
}

export async function createAuthorizationCode({ clientId, redirectUri, codeChallenge, userId, scope }) {
  const code = opaque('qig_code_');
  const record = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    user_id: userId,
    scope: scope || 'memory:read',
    expires_at: Date.now() + CODE_TTL_SECONDS * 1000,
  };
  await writeJson(`${CODE_PREFIX}${hash(code)}.json`, record);
  return code;
}

export async function consumeAuthorizationCode({ code, clientId, redirectUri, codeVerifier }) {
  if (!(await claimOnce('code', code))) return null;
  const path = `${CODE_PREFIX}${hash(code || '')}.json`;
  const record = await readJson(path);
  await remove(path);
  if (!record || record.expires_at < Date.now()) return null;
  if (!safeEqual(record.client_id, clientId) || !safeEqual(record.redirect_uri, redirectUri)) return null;
  const expected = createHash('sha256').update(String(codeVerifier || '')).digest('base64url');
  if (!safeEqual(record.code_challenge, expected)) return null;
  return record;
}

async function persistToken(token, record) {
  await writeJson(`${TOKEN_PREFIX}${hash(token)}.json`, record);
}

export async function issueTokens({ clientId, userId, scope }) {
  const client = await getClient(clientId);
  if (!client || client.revoked_at) return null;
  const requested = new Set(String(scope || 'memory:read').split(/\s+/).filter(Boolean));
  const effectiveScopes = (client.approved_scopes || ['memory:read']).filter((item) => requested.has(item));
  if (!effectiveScopes.length) return null;

  const accessToken = opaque('qig_oauth_');
  const refreshToken = opaque('qig_refresh_');
  const now = Date.now();
  const common = { client_id: clientId, user_id: userId, scope: effectiveScopes.join(' ') };
  await Promise.all([
    persistToken(accessToken, { ...common, type: 'access', expires_at: now + ACCESS_TTL_SECONDS * 1000 }),
    persistToken(refreshToken, { ...common, type: 'refresh', expires_at: now + 30 * 24 * 60 * 60 * 1000 }),
  ]);
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: common.scope,
  };
}

export async function refreshTokens({ refreshToken, clientId }) {
  if (!(await claimOnce('refresh', refreshToken))) return null;
  const path = `${TOKEN_PREFIX}${hash(refreshToken || '')}.json`;
  const record = await readJson(path);
  await remove(path);
  if (!record || record.type !== 'refresh' || record.expires_at < Date.now()) return null;
  if (!safeEqual(record.client_id, clientId)) return null;
  return issueTokens({ clientId: record.client_id, userId: record.user_id, scope: record.scope });
}

export async function getOAuthPrincipal(token) {
  if (!token?.startsWith('qig_oauth_')) return null;
  const record = await readJson(`${TOKEN_PREFIX}${hash(token)}.json`);
  if (!record || record.type !== 'access' || !record.client_id || !record.user_id || record.expires_at < Date.now()) return null;
  const client = await getClient(record.client_id);
  if (!client) return null;
  if (client.revoked_at) return null;
  const tokenScopes = new Set(String(record.scope || '').split(/\s+/).filter(Boolean));
  const approved = client.approved_scopes || ['memory:read'];
  const scopes = approved.filter((scope) => tokenScopes.has(scope));
  return { type: 'oauth', clientId: record.client_id, userId: record.user_id, scopes, trusted: Boolean(client.trusted) };
}

export async function verifyOAuthAccessToken(token) {
  return Boolean(await getOAuthPrincipal(token));
}
