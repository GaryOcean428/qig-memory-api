import { del, get, head, list, put } from '@vercel/blob';

export const PRIVATE_BLOB_TOKEN =
  process.env.BLOB_READ_WRITE_TOKEN_2 || process.env.MEMORY_BLOB_READ_WRITE_TOKEN || '';

export function privateBlobOptions(options = {}) {
  if (!PRIVATE_BLOB_TOKEN) {
    throw new Error(
      'A private Blob binding is required (BLOB_READ_WRITE_TOKEN_2 or MEMORY_BLOB_READ_WRITE_TOKEN)',
    );
  }
  return { ...options, token: PRIVATE_BLOB_TOKEN };
}

export async function readPrivateJson(pathname) {
  const result = await get(
    pathname,
    privateBlobOptions({ access: 'private', useCache: false }),
  );
  if (!result || result.statusCode !== 200) return null;
  return { data: await new Response(result.stream).json(), blob: result.blob };
}

export function writePrivateJson(pathname, value, options = {}) {
  return put(
    pathname,
    JSON.stringify(value),
    privateBlobOptions({
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: options.allowOverwrite ?? false,
      contentType: 'application/json',
      cacheControlMaxAge: 60,
      ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
    }),
  );
}

export function listPrivate(options = {}) {
  return list(privateBlobOptions(options));
}

export function headPrivate(pathname) {
  return head(pathname, privateBlobOptions({ access: 'private' }));
}

export function getPrivate(pathname, options = {}) {
  return get(
    pathname,
    privateBlobOptions({ access: 'private', useCache: false, ...options }),
  );
}

export function deletePrivate(pathnames) {
  return del(pathnames, privateBlobOptions());
}
