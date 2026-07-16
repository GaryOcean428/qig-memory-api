import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { deletePrivate, listPrivate, readPrivateJson, writePrivateJson } from './private-blob';

// API-key store for the PUBLIC bearer surface (REST + MCP).
//
// Keys are minted from the session-gated admin UI. We persist ONLY a SHA-256
// hash of each token (plus non-secret metadata) — the plaintext is shown to the
// admin exactly once at creation and never stored. The env var QIG_API_KEY
// remains a valid bootstrap credential so a fresh deployment can authenticate
// before its first key is minted; once UI-minted keys exist it can be removed.
//
// Records live in the PRIVATE Blob store (the same binding as every other
// store in this app) under their own `apikeys/` prefix so key records never
// appear in the `memory/` namespace the memory browser lists. Never use the
// default Blob binding here: store re-connections rotate BLOB_READ_WRITE_TOKEN
// underneath deployments, which once silently orphaned every minted key.

const PREFIX = 'apikeys/';
const ENV_KEY = process.env.QIG_API_KEY || '';
const TOKEN_PREFIX = 'qig_';

// Valid scopes for minted keys. Keys created before scopes existed have no
// `scopes` field and are treated as full-access (backwards compatible).
export const API_KEY_SCOPES = ['memory:read', 'memory:write', 'memory:admin'];

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return null;
  const valid = scopes.filter((s) => API_KEY_SCOPES.includes(s));
  return valid.length ? [...new Set(valid)] : null;
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

// Constant-time string compare that never throws on length mismatch.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// High-entropy opaque token: `qig_` + 32 random bytes (base64url).
export function generateToken() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

async function readKeyRecords() {
  const { blobs } = await listPrivate({ prefix: PREFIX, limit: 1000 });
  const records = await Promise.all(
    blobs.map(async (b) => {
      try {
        const result = await readPrivateJson(b.pathname);
        return result?.data || null;
      } catch {
        return null;
      }
    }),
  );
  return records.filter(Boolean);
}

// Public metadata only — never returns hashes.
export async function listApiKeys() {
  const recs = await readKeyRecords();
  return recs
    .map(({ id, label, last4, created, created_by, scopes }) => ({
      id,
      label,
      last4,
      created,
      created_by,
      scopes: normalizeScopes(scopes),
    }))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// Mint a new key. Returns the plaintext token ONCE plus its metadata.
// `scopes` limits the key (e.g. ['memory:read']); omitted = full access.
export async function createApiKey({ label, createdBy, scopes } = {}) {
  const token = generateToken();
  const id = randomBytes(8).toString('hex');
  const record = {
    id,
    label: (label || '').trim() || 'Untitled key',
    hash: hashToken(token),
    last4: token.slice(-4),
    created: new Date().toISOString(),
    created_by: createdBy || null,
    scopes: normalizeScopes(scopes),
  };
  await writePrivateJson(`${PREFIX}${id}.json`, record, { allowOverwrite: true });
  return {
    token,
    key: { id, label: record.label, last4: record.last4, created: record.created, created_by: record.created_by },
  };
}

export async function revokeApiKey(id) {
  const path = `${PREFIX}${id}.json`;
  const { blobs } = await listPrivate({ prefix: path, limit: 1 });
  if (!blobs.length) return false;
  await deletePrivate([blobs[0].pathname]);
  return true;
}

// Verify a presented bearer token against the env bootstrap key and every
// stored hash. Fail-closed: unknown/empty tokens return false.
export async function verifyToken(token) {
  if (!token) return false;
  if (ENV_KEY && safeEqual(token, ENV_KEY)) return true;
  const hash = hashToken(token);
  const recs = await readKeyRecords();
  return recs.some((r) => r.hash && safeEqual(r.hash, hash));
}

// Like verifyToken, but returns the matched key's metadata (including scopes)
// so callers can build a correctly-scoped principal. The env bootstrap key and
// legacy records without a `scopes` field are full-access.
export async function resolveToken(token) {
  if (!token) return null;
  if (ENV_KEY && safeEqual(token, ENV_KEY)) {
    return { id: 'env', label: 'QIG_API_KEY (env)', scopes: null };
  }
  const hash = hashToken(token);
  const recs = await readKeyRecords();
  const match = recs.find((r) => r.hash && safeEqual(r.hash, hash));
  if (!match) return null;
  return { id: match.id, label: match.label, scopes: normalizeScopes(match.scopes) };
}

// True when ANY credential exists (env bootstrap or at least one minted key).
// Drives the "server_auth_not_configured" vs "invalid_bearer" 401 reason.
export async function hasAnyKey() {
  if (ENV_KEY) return true;
  const { blobs } = await listPrivate({ prefix: PREFIX, limit: 1 });
  return blobs.length > 0;
}
