import { BlobError, del, get, list, put } from '@vercel/blob';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { privateBlobOptions } from './private-blob';

const PREFIX = 'mcp-oauth/';
const CLIENT_PREFIX = `${PREFIX}clients/`;
const CODE_PREFIX = `${PREFIX}codes/`;
const TOKEN_PREFIX = `${PREFIX}tokens/`;
const CLAIM_PREFIX = `${PREFIX}claims/`;
const REGISTRATION_PREFIX = `${PREFIX}registration-limits/`;
const FINGERPRINT_PREFIX = `${PREFIX}fingerprints/`;
const ACCESS_TTL_SECONDS = 60 * 60;
const CODE_TTL_SECONDS = 5 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
// Per-IP-per-hour cap on the creation of NEW clients. Repeated DCR with
// identical metadata is deduped upstream and never reaches this counter, so the
// limit only guards against a client minting distinct records in a loop.
const MAX_REGISTRATIONS = 40;

// Scope granted to a newly registered client. This service exists so agents can
// RECORD what they learn — read-only would make it write-only-by-operator, i.e.
// useless for its actual purpose. Agents may also DELETE (memory:delete) so they
// can MAINTAIN the corpus — correct stale records, remove wrong ones — per PI
// directive 2026-07-20 ("agents should be able to update and correct as needed,
// even delete"). memory:ADMIN (key-mint + cross-namespace admin) stays operator-
// only: the agent default grants delete of memory records, NOT the full admin
// surface. Agents pick up delete on their NEXT authorization (the token scope is
// granted at consent), which is standard OAuth re-consent behaviour.
export const DEFAULT_CLIENT_SCOPES = ['memory:read', 'memory:write', 'memory:delete'];
export const OPERATOR_CLIENT_SCOPES = ['memory:read', 'memory:write', 'memory:delete', 'memory:admin'];
// The scope set new clients used to receive. Clients still carrying exactly this
// were registered under the old default and are upgraded on their next
// registration (DCR is idempotent by fingerprint, so a client that already
// exists would otherwise keep read-only forever and never recover).
const LEGACY_DEFAULT_SCOPES = ['memory:read'];

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

// The @vercel/blob conflict for `allowOverwrite: false` on an existing blob is
// a base BlobError whose only discriminator is its message ("This blob already
// exists...") — the SDK exposes no conflict class or code for it. Requiring the
// BlobError type keeps unrelated errors that merely mention "already exists"
// out of the benign path. Claim primitives below rely on this to separate
// "slot taken" (expected, lose the race) from a store outage (must surface,
// never swallow — a swallowed outage once masqueraded as rate_limit_exceeded
// for every caller).
function isBlobConflict(error) {
  return error instanceof BlobError && /already exists/i.test(String(error.message || ''));
}

// OAuth records live in the PRIVATE Blob store (same binding as every other
// store in this app — BLOB_READ_WRITE_TOKEN_2). Never use the default binding:
// store re-connections rotate BLOB_READ_WRITE_TOKEN underneath deployments.
// Records are additionally sealed (AES-256-GCM) so they stay confidential and
// tamper-evident even if store access is ever misconfigured.
async function writeJson(path, value, { overwrite = true } = {}) {
  await put(
    path,
    seal(value),
    privateBlobOptions({
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: overwrite,
      contentType: 'application/octet-stream',
      cacheControlMaxAge: 0,
    }),
  );
}

// get() returns null for a missing private blob and a statusCode for anything
// else, so "not found" is silent while real faults (access, config) are logged
// rather than masked as an empty record.
async function readJson(path) {
  const result = await get(path, privateBlobOptions({ access: 'private', useCache: false }));
  if (!result) return null;
  if (result.statusCode !== 200) {
    console.log('[v0] oauth readJson unexpected status:', path, result.statusCode);
    return null;
  }
  return unseal(await new Response(result.stream).text());
}

async function remove(path) {
  try {
    await del(path, privateBlobOptions());
  } catch (error) {
    // Deletion is idempotent: an already-gone blob is success. Other failures
    // (permissions, store config, network) are logged instead of swallowed.
    console.log('[v0] oauth remove error:', path, error?.message);
  }
}

// A create-only claim makes read/consume single-winner across concurrent
// serverless invocations. The high-entropy artifact hash keeps claim paths
// unguessable, and claims intentionally remain as replay tombstones until the
// GC sweep retires them after their artifact's own lifetime has lapsed.
async function claimOnce(kind, artifact) {
  const path = `${CLAIM_PREFIX}${kind}/${hash(artifact || '')}.lock`;
  try {
    await writeJson(path, { claimed_at: Date.now() }, { overwrite: false });
    return true;
  } catch (error) {
    if (isBlobConflict(error)) return false;
    throw error;
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
    } catch (error) {
      // Occupied slot: try the next one. Anything else is a store fault and
      // must NOT read as "rate limited" — rethrow so callers return 500.
      if (!isBlobConflict(error)) throw error;
    }
  }
  return false;
}

// Stable identity for a public client: the exact set of callback URLs plus the
// declared name. Two DCR calls with the same fingerprint describe the same
// logical client, so we can safely return the original record instead of
// minting a new one (RFC 7591 permits reuse; PKCE still protects each exchange).
function clientFingerprint(redirectUris, clientName) {
  const canonical = JSON.stringify({
    redirect_uris: [...redirectUris].map((u) => String(u)).sort(),
    client_name: String(clientName || 'MCP client').slice(0, 120),
  });
  return hash(canonical);
}

// Returns an existing, non-revoked client for identical registration metadata,
// or null. Used to make repeated DCR idempotent and free of rate-limit cost.
export async function findClientByFingerprint({ redirectUris, clientName }) {
  const fingerprint = clientFingerprint(redirectUris, clientName);
  const pointer = await readJson(`${FINGERPRINT_PREFIX}${fingerprint}.json`);
  if (!pointer?.client_id) return null;
  const client = await getClient(pointer.client_id);
  if (!client || client.revoked_at) return null;
  return client;
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
    approved_scopes: [...DEFAULT_CLIENT_SCOPES],
    trusted: false,
    created_at: new Date().toISOString(),
  };
  await writeJson(`${CLIENT_PREFIX}${hash(clientId)}.json`, record);
  // Index by fingerprint so subsequent identical DCR calls reuse this record.
  await writeJson(`${FINGERPRINT_PREFIX}${clientFingerprint(redirectUris, clientName)}.json`, {
    client_id: clientId,
  });
  return record;
}

/**
 * Upgrade a client still holding the retired read-only default.
 * DCR is idempotent by fingerprint: an existing client is returned as-is, so
 * without this every client registered under the old default would stay
 * read-only forever — including ones whose operator never touched the admin UI.
 * Only the exact legacy set is touched: a deliberately read-limited client
 * (or a revoked one) is left alone.
 */
export async function upgradeLegacyClientScopes(client) {
  if (!client || client.trusted || client.revoked_at) return client;
  const current = client.approved_scopes || [];
  const isLegacyDefault =
    current.length === LEGACY_DEFAULT_SCOPES.length && LEGACY_DEFAULT_SCOPES.every((s) => current.includes(s));
  if (!isLegacyDefault) return client;
  const upgraded = { ...client, approved_scopes: [...DEFAULT_CLIENT_SCOPES] };
  await writeJson(`${CLIENT_PREFIX}${hash(client.client_id)}.json`, upgraded);
  return upgraded;
}

// Projection returned to DCR callers. A caller only proves knowledge of the
// (non-secret) redirect_uris + client_name, so never echo admin-managed trust
// state (approved_by, approval_updated_at, trusted, approved_scopes, revoked_at)
// — that would leak an operator's identity and a client's privilege level to an
// unauthenticated party. Only the standard registered metadata is public.
export function toRegistrationResponse(client) {
  const issuedAt = Date.parse(client.created_at);
  return {
    client_id: client.client_id,
    // Public clients under PKCE have no secret; advertising it as never-expiring
    // keeps strict RFC 7591 clients from prompting for a client_secret.
    client_id_issued_at: Number.isFinite(issuedAt) ? Math.floor(issuedAt / 1000) : undefined,
    client_secret_expires_at: 0,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    grant_types: client.grant_types,
    response_types: client.response_types,
  };
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
  const { blobs } = await list(privateBlobOptions({ prefix: CLIENT_PREFIX, limit: 1000 }));
  const clients = await Promise.all(blobs.map((blob) => readJson(blob.pathname)));
  return clients.filter(Boolean).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// modes: 'operator' (read+write+admin), 'agent' (read+write — the default),
// 'read' (read-only), 'revoked' (nothing).
export async function setClientAccess(clientId, mode, approvedBy = null) {
  const client = await getClient(clientId);
  if (!client) return null;
  const now = new Date().toISOString();
  const trusted = mode === 'operator';
  const revoked = mode === 'revoked';
  const scopes = revoked
    ? []
    : trusted
      ? [...OPERATOR_CLIENT_SCOPES]
      : mode === 'read'
        ? ['memory:read']
        : [...DEFAULT_CLIENT_SCOPES];
  const updated = {
    ...client,
    trusted,
    approved_scopes: scopes,
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
    persistToken(refreshToken, { ...common, type: 'refresh', expires_at: now + REFRESH_TTL_MS }),
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
  const approved = client.approved_scopes || [...DEFAULT_CLIENT_SCOPES];
  const scopes = approved.filter((scope) => tokenScopes.has(scope));
  return { type: 'oauth', clientId: record.client_id, userId: record.user_id, scopes, trusted: Boolean(client.trusted) };
}

export async function verifyOAuthAccessToken(token) {
  return Boolean(await getOAuthPrincipal(token));
}

// Retire ephemeral OAuth blobs whose own lifetime has lapsed. Everything here
// is judged by uploadedAt (no reads needed) with margins comfortably past each
// artifact's real TTL, so a sweep can never break a live grant:
// - codes/ expire in 5 minutes            → delete after 1 hour
// - claims/{code,consent}/ guard 5-minute artifacts → delete after 1 day
// - claims/refresh/ guard 30-day refresh tokens     → delete after 31 days
// - tokens/ live at most 30 days (refresh)          → delete after 31 days
// - registration-limits/<bucket>/ matter only in their own hour → delete once
//   the bucket is at least 2 hours old
export async function sweepExpiredOAuthBlobs({ now = Date.now() } = {}) {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const currentBucket = Math.floor(now / REGISTRATION_WINDOW_MS);
  const expired = [];
  let cursor;
  do {
    const page = await list(privateBlobOptions({ prefix: PREFIX, limit: 1000, cursor }));
    for (const blob of page.blobs) {
      const age = now - Date.parse(blob.uploadedAt);
      const path = blob.pathname;
      if (path.startsWith(REGISTRATION_PREFIX)) {
        const bucket = Number(path.slice(REGISTRATION_PREFIX.length).split('/')[0]);
        if (Number.isFinite(bucket) && bucket < currentBucket - 1) expired.push(path);
      } else if (!Number.isFinite(age)) {
        // An unparseable uploadedAt would make every TTL check false and pin
        // the blob forever — surface it instead of silently skipping.
        console.log('[v0] oauth gc: unparseable uploadedAt, skipping', path, blob.uploadedAt);
      } else if (path.startsWith(CODE_PREFIX)) {
        if (age > HOUR) expired.push(path);
      } else if (path.startsWith(`${CLAIM_PREFIX}code/`) || path.startsWith(`${CLAIM_PREFIX}consent/`)) {
        if (age > DAY) expired.push(path);
      } else if (path.startsWith(`${CLAIM_PREFIX}refresh/`) || path.startsWith(TOKEN_PREFIX)) {
        if (age > 31 * DAY) expired.push(path);
      }
      // clients/ and fingerprints/ are durable registrations — never swept.
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  for (let i = 0; i < expired.length; i += 100) {
    await del(expired.slice(i, i + 100), privateBlobOptions());
  }
  return { scanned_prefix: PREFIX, deleted: expired.length };
}
