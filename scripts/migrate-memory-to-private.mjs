import { createHash } from 'node:crypto';
import { del, get, list, put } from '@vercel/blob';

const sourceToken = process.env.SOURCE_BLOB_READ_WRITE_TOKEN;
const destinationToken = process.env.BLOB_READ_WRITE_TOKEN_2 || process.env.MEMORY_BLOB_READ_WRITE_TOKEN;
const apply = process.argv.includes('--apply');
const cleanup = process.argv.includes('--cleanup');
const prefix = 'memory/';
const concurrency = Math.min(Math.max(Number(process.env.MIGRATION_CONCURRENCY) || 8, 1), 32);

if (!sourceToken || !destinationToken) {
  throw new Error('SOURCE_BLOB_READ_WRITE_TOKEN and a private destination binding (BLOB_READ_WRITE_TOKEN_2 or MEMORY_BLOB_READ_WRITE_TOKEN) are required');
}
if (sourceToken === destinationToken) {
  throw new Error('Source and destination credentials must target separate stores');
}
if (cleanup && !apply) {
  throw new Error('--cleanup requires --apply so every destination is verified before source deletion');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function listAll(token) {
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
  const response = await fetch(blob.url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`source read failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function readDestination(pathname) {
  const result = await get(pathname, { access: 'private', token: destinationToken, useCache: false });
  return result ? Buffer.from(await new Response(result.stream).arrayBuffer()) : null;
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

const blobs = await listAll(sourceToken);
const outcomes = await mapBounded(blobs, async (blob) => {
  try {
    const sourceBytes = await readSource(blob);
    JSON.parse(sourceBytes.toString('utf8'));
    const sourceHash = digest(sourceBytes);
    const existingBytes = await readDestination(blob.pathname);

    if (existingBytes && digest(existingBytes) === sourceHash) {
      return { pathname: blob.pathname, status: 'verified_existing', hash: sourceHash };
    }
    if (!apply) {
      return { pathname: blob.pathname, status: existingBytes ? 'replace_planned' : 'copy_planned', hash: sourceHash };
    }

    await put(blob.pathname, sourceBytes, {
      access: 'private',
      token: destinationToken,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: blob.contentType || 'application/json',
      cacheControlMaxAge: 0,
    });
    const copiedBytes = await readDestination(blob.pathname);
    if (!copiedBytes || digest(copiedBytes) !== sourceHash) throw new Error('destination verification hash mismatch');
    return { pathname: blob.pathname, status: 'copied_verified', hash: sourceHash };
  } catch (error) {
    return { pathname: blob.pathname, status: 'failed', error: error.message };
  }
});

const failed = outcomes.filter((item) => item.status === 'failed');
const allVerified = apply && failed.length === 0 && outcomes.every((item) => ['verified_existing', 'copied_verified'].includes(item.status));
let deleted = 0;
if (cleanup) {
  if (!allVerified) throw new Error('Cleanup refused: every source object must have a hash-verified destination');
  await mapBounded(blobs, async (blob) => {
    await del(blob.url, { token: sourceToken });
    deleted += 1;
  });
}

const counts = outcomes.reduce((summary, item) => {
  summary[item.status] = (summary[item.status] || 0) + 1;
  return summary;
}, {});
console.log(JSON.stringify({
  mode: cleanup ? 'apply-and-cleanup' : apply ? 'apply' : 'dry-run',
  prefix,
  concurrency,
  scanned: blobs.length,
  counts,
  all_verified: allVerified,
  deleted,
  failures: failed.map(({ pathname, error }) => ({ pathname, error })),
}, null, 2));
if (failed.length) process.exitCode = 1;
