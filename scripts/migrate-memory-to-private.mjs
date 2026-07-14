import { get, list, put } from '@vercel/blob';

const sourceToken = process.env.SOURCE_BLOB_READ_WRITE_TOKEN;
const destinationToken = process.env.MEMORY_BLOB_READ_WRITE_TOKEN;
const apply = process.argv.includes('--apply');
const prefix = 'memory/';

if (!sourceToken || !destinationToken) {
  throw new Error('SOURCE_BLOB_READ_WRITE_TOKEN and MEMORY_BLOB_READ_WRITE_TOKEN are required');
}
if (sourceToken === destinationToken) {
  throw new Error('Source and destination credentials must target separate stores');
}

async function sourceBlobs() {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix, limit: 1000, cursor, token: sourceToken });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function destinationExists(pathname) {
  const result = await list({ prefix: pathname, limit: 1, token: destinationToken });
  return result.blobs.some((blob) => blob.pathname === pathname);
}

const blobs = await sourceBlobs();
const report = { mode: apply ? 'apply' : 'dry-run', scanned: blobs.length, copied: 0, skipped: 0, failed: [] };

for (const blob of blobs) {
  try {
    if (await destinationExists(blob.pathname)) {
      report.skipped += 1;
      continue;
    }
    if (!apply) {
      report.copied += 1;
      continue;
    }
    const source = await get(blob.pathname, { access: 'public', token: sourceToken, useCache: false });
    if (!source) throw new Error('source blob missing');
    const bytes = await new Response(source.stream).arrayBuffer();
    await put(blob.pathname, bytes, {
      access: 'private', token: destinationToken, addRandomSuffix: false,
      allowOverwrite: false, contentType: source.blob.contentType || 'application/json',
    });
    report.copied += 1;
  } catch (error) {
    report.failed.push({ pathname: blob.pathname, error: error.message });
  }
}

console.log(JSON.stringify(report, null, 2));
if (report.failed.length) process.exitCode = 1;
