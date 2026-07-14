import { put, list, del } from '@vercel/blob';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'mcp-oauth/';
const CLIENT_PREFIX = `${PREFIX}clients/`;
const CODE_PREFIX = `${PREFIX}codes/`;
const TOKEN_PREFIX = `${PREFIX}tokens/`;
const ACCESS_TTL_SECONDS = 60 * 60;
const CODE_TTL_SECONDS = 5 * 60;

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const opaque = (prefix) => `${prefix}${randomBytes(32).toString('base64url')}`;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

async function writeJson(path, value) {
  await put(path, JSON.stringify(value), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
}

async function readJson(path) {
  const { blobs } = await list({ prefix: path, limit: 1 });
  const blob = blobs.find((item) => item.pathname === path);
  if (!blob) return null;
  try {
    const response = await fetch(`${blob.url}?v=${encodeURIComponent(blob.uploadedAt)}`, { cache: 'no-store' });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function remove(path) {
  const { blobs } = await list({ prefix: path, limit: 1 });
  const blob = blobs.find((item) => item.pathname === path);
  if (blob) await del(blob.url);
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
  const path = `${CODE_PREFIX}${hash(code || '')}.json`;
  const record = await readJson(path);
  if (!record) return null;
  await remove(path);
  if (record.expires_at < Date.now()) return null;
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
  const path = `${TOKEN_PREFIX}${hash(refreshToken || '')}.json`;
  const record = await readJson(path);
  if (!record || record.type !== 'refresh' || record.expires_at < Date.now()) return null;
  if (!safeEqual(record.client_id, clientId)) return null;
  await remove(path);
  return issueTokens(record);
}

export async function verifyOAuthAccessToken(token) {
  if (!token?.startsWith('qig_oauth_')) return false;
  const record = await readJson(`${TOKEN_PREFIX}${hash(token)}.json`);
  return Boolean(record && record.type === 'access' && record.expires_at >= Date.now());
}
