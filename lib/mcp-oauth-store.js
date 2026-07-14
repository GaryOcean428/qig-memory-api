import { put, list, del } from '@vercel/blob';
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
const ACCESS_TTL_SECONDS = 60 * 60;
const CODE_TTL_SECONDS = 5 * 60;

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

async function readJson(path) {
  const { blobs } = await list({ prefix: path, limit: 1 });
  const blob = blobs.find((item) => item.pathname === path);
  if (!blob) return null;
  try {
    const response = await fetch(`${blob.url}?v=${encodeURIComponent(blob.uploadedAt)}`, { cache: 'no-store' });
    return response.ok ? unseal(await response.text()) : null;
  } catch {
    return null;
  }
}

async function remove(path) {
  const { blobs } = await list({ prefix: path, limit: 1 });
  const blob = blobs.find((item) => item.pathname === path);
  if (blob) await del(blob.url);
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

export async function registerClient({ redirectUris, clientName }) {
  const clientId = `qig_client_${randomBytes(18).toString('base64url')}`;
  const record = {
    client_id: clientId,
    client_name: String(clientName || 'MCP client').slice(0, 120),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
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

export async function createAuthorizationCode({ clientId, redirectUri, codeChallenge, userId, scope }) {
  const code = opaque('qig_code_');
  const record = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    user_id: userId,
    scope: scope || 'mcp:tools',
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
  const accessToken = opaque('qig_oauth_');
  const refreshToken = opaque('qig_refresh_');
  const now = Date.now();
  const common = { client_id: clientId, user_id: userId, scope: scope || 'mcp:tools' };
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

export async function verifyOAuthAccessToken(token) {
  if (!token?.startsWith('qig_oauth_')) return false;
  const record = await readJson(`${TOKEN_PREFIX}${hash(token)}.json`);
  return Boolean(
    record &&
      record.type === 'access' &&
      record.client_id &&
      record.user_id &&
      record.expires_at >= Date.now(),
  );
}
