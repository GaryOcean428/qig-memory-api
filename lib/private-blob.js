import { del, get, head, list, put } from '@vercel/blob';

// Only BLOB_READ_WRITE_TOKEN_2 identifies the private store (store_PWEX…).
// MEMORY_BLOB_READ_WRITE_TOKEN is deliberately NOT accepted: despite its name
// it resolves to the LEGACY public store (store_Pmb3Crn…, slated for deletion),
// so using it as a fallback would silently route the private stores at a store
// that is about to disappear. Fail closed instead.
export const PRIVATE_BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN_2 || '';

// Auth resolution, mirroring the SDK's own priority but never falling through
// to the ambient BLOB_READ_WRITE_TOKEN (store re-connections rotate that
// default binding underneath deployments — the cause of the 2026-07-16 outage):
// 1. Explicit private token (BLOB_READ_WRITE_TOKEN_2)
// 2. OIDC federation: VERCEL_OIDC_TOKEN + BLOB_STORE_ID (BLOB_STORE_ID already
//    points at the private store) — passed explicitly so the SDK cannot
//    silently pick a different credential source.
export function privateBlobOptions(options = {}) {
  if (PRIVATE_BLOB_TOKEN) return { ...options, token: PRIVATE_BLOB_TOKEN };
  if (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID) {
    return {
      ...options,
      oidcToken: process.env.VERCEL_OIDC_TOKEN,
      storeId: process.env.BLOB_STORE_ID,
    };
  }
  throw new Error(
    'A private Blob binding is required: set BLOB_READ_WRITE_TOKEN_2, or provide OIDC credentials (VERCEL_OIDC_TOKEN + BLOB_STORE_ID).',
  );
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
