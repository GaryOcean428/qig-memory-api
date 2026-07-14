import { createHash, randomUUID } from 'node:crypto';
import { issueSignedToken, presignUrl } from '@vercel/blob';
import { z } from 'zod';
import { sendInboxMessage } from './inbox-store';
import {
  PRIVATE_BLOB_TOKEN,
  deletePrivate,
  getPrivate,
  headPrivate,
  readPrivateJson,
  writePrivateJson,
} from './private-blob';

export const ARTIFACT_COLS = 64;
export const ARTIFACT_ROW_BYTES = ARTIFACT_COLS * Float32Array.BYTES_PER_ELEMENT;
export const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;

export const artifactPutSchema = z.object({
  name: z.string().regex(SAFE_NAME),
  version: z.string().regex(SAFE_VERSION).optional(),
  cols: z.literal(ARTIFACT_COLS),
  row_count: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

function dataPath(name, version) {
  return `artifact/${name}/${version}.f32`;
}
function pendingPath(name, version) {
  return `artifact/${name}/${version}.pending.json`;
}
function manifestPath(name, version) {
  return `artifact/${name}/${version}.manifest.json`;
}
function latestPath(name) {
  return `artifact/${name}/latest.json`;
}

function expectedBytes(rowCount) {
  const bytes = rowCount * ARTIFACT_ROW_BYTES;
  if (bytes > ARTIFACT_MAX_BYTES) {
    const error = new Error(`artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`);
    error.code = 'artifact_too_large';
    throw error;
  }
  return bytes;
}

async function signedUrl(pathname, operation, validUntil, options = {}) {
  const token = await issueSignedToken({
    pathname,
    operations: [operation],
    validUntil,
    token: PRIVATE_BLOB_TOKEN,
    ...(options.maximumSizeInBytes ? { maximumSizeInBytes: options.maximumSizeInBytes } : {}),
    ...(options.allowedContentTypes ? { allowedContentTypes: options.allowedContentTypes } : {}),
  });
  return presignUrl(token, {
    access: 'private',
    operation,
    pathname,
    validUntil,
    ...(operation === 'put'
      ? {
          allowedContentTypes: options.allowedContentTypes,
          maximumSizeInBytes: options.maximumSizeInBytes,
          allowOverwrite: false,
          addRandomSuffix: false,
          cacheControlMaxAge: 31536000,
        }
      : {}),
  });
}

export async function initiateArtifact(input) {
  const parsed = artifactPutSchema.parse(input);
  const version = parsed.version || `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
  const pathname = dataPath(parsed.name, version);
  const byteLength = expectedBytes(parsed.row_count);
  if (await readPrivateJson(manifestPath(parsed.name, version))) {
    const error = new Error('artifact version already published');
    error.code = 'conflict';
    throw error;
  }
  const validUntil = Date.now() + UPLOAD_TTL_MS;
  const pending = {
    ...parsed,
    version,
    byte_length: byteLength,
    pathname,
    status: 'pending',
    created_at: new Date().toISOString(),
    upload_expires_at: new Date(validUntil).toISOString(),
  };
  await writePrivateJson(pendingPath(parsed.name, version), pending);
  const { presignedUrl } = await signedUrl(pathname, 'put', validUntil, {
    maximumSizeInBytes: byteLength,
    allowedContentTypes: ['application/octet-stream'],
  });
  return {
    ...pending,
    upload: {
      method: 'PUT',
      url: presignedUrl,
      headers: { 'content-type': 'application/octet-stream' },
    },
  };
}

async function digestStream(stream) {
  const hash = createHash('sha256');
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest('hex');
}

export async function finalizeArtifact({ name, version }) {
  if (!SAFE_NAME.test(name) || !SAFE_VERSION.test(version)) throw new Error('invalid artifact name or version');
  const existing = await readPrivateJson(manifestPath(name, version));
  if (existing) return existing.data;
  const pendingResult = await readPrivateJson(pendingPath(name, version));
  if (!pendingResult) return null;
  const pending = pendingResult.data;
  const metadata = await headPrivate(pending.pathname).catch(() => null);
  if (!metadata) return null;
  if (metadata.size !== pending.byte_length || metadata.contentType !== 'application/octet-stream') {
    await deletePrivate(pending.pathname).catch(() => {});
    const error = new Error(`uploaded artifact failed size/content-type verification`);
    error.code = 'integrity_failed';
    throw error;
  }
  const blob = await getPrivate(pending.pathname);
  if (!blob || blob.statusCode !== 200) return null;
  const sha256 = await digestStream(blob.stream);
  if (sha256.toLowerCase() !== pending.sha256.toLowerCase()) {
    await deletePrivate(pending.pathname).catch(() => {});
    const error = new Error('uploaded artifact failed SHA-256 verification');
    error.code = 'integrity_failed';
    throw error;
  }
  const publishedAt = new Date().toISOString();
  const manifest = {
    name,
    version,
    cols: ARTIFACT_COLS,
    row_count: pending.row_count,
    row_bytes: ARTIFACT_ROW_BYTES,
    byte_length: pending.byte_length,
    sha256,
    content_type: 'application/octet-stream',
    published_at: publishedAt,
  };
  await writePrivateJson(manifestPath(name, version), manifest);
  await writePrivateJson(latestPath(name), manifest, { allowOverwrite: true });
  await deletePrivate(pendingPath(name, version)).catch(() => {});
  await sendInboxMessage({
    from: 'qig-memory-api',
    to: 'broadcast',
    namespace: 'qig',
    type: 'artifact_updated',
    subject: `${name}@${version} published`,
    payload: { type: 'artifact_updated', name, version, row_count: pending.row_count, sha256 },
  });
  return manifest;
}

export async function getArtifactManifest(name, version) {
  if (!SAFE_NAME.test(name) || (version && !SAFE_VERSION.test(version))) return null;
  const result = await readPrivateJson(version ? manifestPath(name, version) : latestPath(name));
  return result?.data ?? null;
}

export async function getArtifactRows({ name, version, start, end, origin }) {
  const manifest = await getArtifactManifest(name, version);
  if (!manifest) return null;
  const startRow = Number(start);
  const endRow = Number(end);
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow) || startRow < 0 || endRow <= startRow || endRow > manifest.row_count) {
    throw new Error(`row range must satisfy 0 <= start < end <= ${manifest.row_count}`);
  }
  const byteStart = startRow * ARTIFACT_ROW_BYTES;
  const byteEnd = endRow * ARTIFACT_ROW_BYTES - 1;
  const pathname = dataPath(name, manifest.version);
  const validUntil = Date.now() + DOWNLOAD_TTL_MS;
  const { presignedUrl } = await signedUrl(pathname, 'get', validUntil);
  return {
    manifest,
    rows: { start: startRow, end: endRow },
    bytes: { start: byteStart, end: byteEnd, length: byteEnd - byteStart + 1 },
    range_header: `bytes=${byteStart}-${byteEnd}`,
    signed_url: presignedUrl,
    signed_url_expires_at: new Date(validUntil).toISOString(),
    proxy_url: `${origin}/api/artifact/${encodeURIComponent(name)}/${encodeURIComponent(manifest.version)}/rows?start=${startRow}&end=${endRow}`,
  };
}

export async function streamArtifactRows({ name, version, start, end }) {
  const manifest = await getArtifactManifest(name, version);
  if (!manifest) return null;
  const startRow = Number(start);
  const endRow = Number(end);
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow) || startRow < 0 || endRow <= startRow || endRow > manifest.row_count) {
    throw new Error('invalid row range');
  }
  const byteStart = startRow * ARTIFACT_ROW_BYTES;
  const byteEnd = endRow * ARTIFACT_ROW_BYTES - 1;
  const result = await getPrivate(dataPath(name, manifest.version), {
    headers: { Range: `bytes=${byteStart}-${byteEnd}` },
  });
  if (!result || result.statusCode !== 200) return null;
  return { stream: result.stream, manifest, byteStart, byteEnd };
}
