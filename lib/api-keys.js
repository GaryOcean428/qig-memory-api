import { put, list, del } from '@vercel/blob';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// API-key store for the PUBLIC bearer surface (REST + MCP).
//
// Keys are minted from the session-gated admin UI. We persist ONLY a SHA-256
// hash of each token (plus non-secret metadata) — the plaintext is shown to the
// admin exactly once at creation and never stored. The env var QIG_API_KEY
// remains a valid bootstrap credential so existing deployments keep working.
//
// Storage lives under its own `apikeys/` prefix so key records never appear in
// the `memory/` namespace the memory browser lists.

const PREFIX = 'apikeys/';
const ENV_KEY = process.env.QIG_API_KEY || '';
const TOKEN_PREFIX = 'qig_';

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
  const { blobs } = await list({ prefix: PREFIX, limit: 1000 });
  const records = await Promise.all(
    blobs.map(async (b) => {
      try {
        const resp = await fetch(`${b.url}?v=${encodeURIComponent(b.uploadedAt)}`, {
          cache: 'no-store',
        });
        return await resp.json();
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
    .map(({ id, label, last4, created, created_by }) => ({ id, label, last4, created, created_by }))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// Mint a new key. Returns the plaintext token ONCE plus its metadata.
export async function createApiKey({ label, createdBy } = {}) {
  const token = generateToken();
  const id = randomBytes(8).toString('hex');
  const record = {
    id,
    label: (label || '').trim() || 'Untitled key',
    hash: hashToken(token),
    last4: token.slice(-4),
    created: new Date().toISOString(),
    created_by: createdBy || null,
  };
  await put(`${PREFIX}${id}.json`, JSON.stringify(record), {
    access: 'public', // opaque: contains only a hash, never the plaintext token
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
  return {
    token,
    key: { id, label: record.label, last4: record.last4, created: record.created, created_by: record.created_by },
  };
}

export async function revokeApiKey(id) {
  const path = `${PREFIX}${id}.json`;
  const { blobs } = await list({ prefix: path, limit: 1 });
  if (!blobs.length) return false;
  await del(blobs[0].url);
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

// True when ANY credential exists (env bootstrap or at least one minted key).
// Drives the "server_auth_not_configured" vs "invalid_bearer" 401 reason.
export async function hasAnyKey() {
  if (ENV_KEY) return true;
  const { blobs } = await list({ prefix: PREFIX, limit: 1 });
  return blobs.length > 0;
}
