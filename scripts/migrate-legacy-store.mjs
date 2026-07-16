// Migrate durable records out of the legacy PUBLIC Blob store into the private
// store, and audit `memory/` parity between the two — the final step before the
// legacy store can be deleted.
//
// What it copies (hash-verified, written with private access):
//   - apikeys/                    UI-minted API key records
//   - mcp-oauth/clients/          registered OAuth clients
//   - mcp-oauth/fingerprints/     DCR dedup index
// What it audits without ever overwriting newer destination data:
//   - memory/                     copies blobs MISSING in the destination;
//                                 equal hashes verify; differing hashes are
//                                 reported (dest newer = kept, source newer =
//                                 flagged for manual review)
// What it deliberately skips (ephemeral, expired, or superseded):
//   - mcp-oauth/{codes,tokens,claims,registration-limits}/
//
// Usage:
//   node scripts/migrate-legacy-store.mjs            # dry-run report
//   node scripts/migrate-legacy-store.mjs --apply    # copy + verify
//
// Tokens come from SOURCE_BLOB_READ_WRITE_TOKEN (legacy public store) and
// BLOB_READ_WRITE_TOKEN_2 (private store), from the environment or a local
// .env.vercel.local / .env.local pulled via `vercel env pull`.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { get, list, put } from '@vercel/blob';

function loadLocalEnv() {
  for (const file of ['.env.vercel.local', '.env.local']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i < 1 || line.startsWith('#')) continue;
      const key = line.slice(0, i).trim();
      if (!(key in process.env)) process.env[key] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
  }
}
loadLocalEnv();

const sourceToken = process.env.SOURCE_BLOB_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
const destinationToken = process.env.BLOB_READ_WRITE_TOKEN_2;
const apply = process.argv.includes('--apply');
const concurrency = Math.min(Math.max(Number(process.env.MIGRATION_CONCURRENCY) || 8, 1), 32);

if (!sourceToken || !destinationToken) {
  throw new Error('SOURCE_BLOB_READ_WRITE_TOKEN (legacy) and BLOB_READ_WRITE_TOKEN_2 (private) are required');
}
if (sourceToken === destinationToken) {
  throw new Error('Source and destination credentials must target separate stores');
}

const COPY_PREFIXES = ['apikeys/', 'mcp-oauth/clients/', 'mcp-oauth/fingerprints/'];
const AUDIT_PREFIX = 'memory/';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function listAll(prefix, token) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix, limit: 1000, cursor, token });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function readSource(blob) {
  // Legacy store is public: its blob URLs are directly fetchable.
  const response = await fetch(blob.url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`source read failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function readDestination(pathname) {
  const result = await get(pathname, { access: 'private', token: destinationToken, useCache: false });
  if (!result || result.statusCode !== 200) return null;
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

async function copyVerified(blob, bytes, hash) {
  await put(blob.pathname, bytes, {
    access: 'private',
    token: destinationToken,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: blob.contentType || 'application/json',
    cacheControlMaxAge: 0,
  });
  const copied = await readDestination(blob.pathname);
  if (!copied || digest(copied) !== hash) throw new Error('destination verification hash mismatch');
}

async function mapBounded(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function migratePrefix(prefix) {
  const blobs = await listAll(prefix, sourceToken);
  return mapBounded(blobs, async (blob) => {
    try {
      const bytes = await readSource(blob);
      const hash = digest(bytes);
      const existing = await readDestination(blob.pathname);
      if (existing && digest(existing) === hash) {
        return { pathname: blob.pathname, status: 'verified_existing' };
      }
      if (!apply) {
        return { pathname: blob.pathname, status: existing ? 'replace_planned' : 'copy_planned' };
      }
      await copyVerified(blob, bytes, hash);
      return { pathname: blob.pathname, status: 'copied_verified' };
    } catch (error) {
      return { pathname: blob.pathname, status: 'failed', error: error.message };
    }
  });
}

async function auditMemory() {
  const [sourceBlobs, destBlobs] = await Promise.all([
    listAll(AUDIT_PREFIX, sourceToken),
    listAll(AUDIT_PREFIX, destinationToken),
  ]);
  const destByPath = new Map(destBlobs.map((b) => [b.pathname, b]));
  const outcomes = await mapBounded(sourceBlobs, async (blob) => {
    try {
      const dest = destByPath.get(blob.pathname);
      if (!dest) {
        if (!apply) return { pathname: blob.pathname, status: 'missing_copy_planned' };
        const bytes = await readSource(blob);
        await copyVerified(blob, bytes, digest(bytes));
        return { pathname: blob.pathname, status: 'missing_copied_verified' };
      }
      const [sourceBytes, destBytes] = await Promise.all([readSource(blob), readDestination(blob.pathname)]);
      if (destBytes && digest(sourceBytes) === digest(destBytes)) {
        return { pathname: blob.pathname, status: 'verified_identical' };
      }
      // Content differs: the private store has been live since the original
      // migration, so a newer destination is normal ongoing work — keep it.
      // A newer SOURCE means something kept writing the legacy store and a
      // human must reconcile it; never auto-clobber in either direction.
      const destUploaded = Date.parse(dest.uploadedAt);
      const sourceUploaded = Date.parse(blob.uploadedAt);
      if (!Number.isFinite(destUploaded) || !Number.isFinite(sourceUploaded)) {
        return { pathname: blob.pathname, status: 'differs_timestamps_invalid_REVIEW' };
      }
      const destNewer = destUploaded >= sourceUploaded;
      return { pathname: blob.pathname, status: destNewer ? 'differs_dest_newer_kept' : 'differs_SOURCE_NEWER_REVIEW' };
    } catch (error) {
      return { pathname: blob.pathname, status: 'failed', error: error.message };
    }
  });
  return { outcomes, sourceCount: sourceBlobs.length, destCount: destBlobs.length };
}

const report = { mode: apply ? 'apply' : 'dry-run', copy: {}, memory_audit: {} };

for (const prefix of COPY_PREFIXES) {
  const outcomes = await migratePrefix(prefix);
  report.copy[prefix] = outcomes.reduce((acc, o) => ((acc[o.status] = (acc[o.status] || 0) + 1), acc), {});
  const failures = outcomes.filter((o) => o.status === 'failed');
  if (failures.length) report.copy[`${prefix}:failures`] = failures;
}

const { outcomes, sourceCount, destCount } = await auditMemory();
report.memory_audit = {
  source_total: sourceCount,
  dest_total: destCount,
  counts: outcomes.reduce((acc, o) => ((acc[o.status] = (acc[o.status] || 0) + 1), acc), {}),
  needs_review: outcomes
    .filter((o) => o.status === 'differs_SOURCE_NEWER_REVIEW' || o.status === 'failed')
    .map(({ pathname, status, error }) => ({ pathname, status, error })),
};

const clean =
  !Object.values(report.copy).some((c) => Array.isArray(c)) &&
  report.memory_audit.needs_review.length === 0;
report.safe_to_delete_legacy_store = apply && clean;

console.log(JSON.stringify(report, null, 2));
if (!clean) process.exitCode = 1;
