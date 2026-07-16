import { del, get, head, list, put } from '@vercel/blob';

// Only BLOB_READ_WRITE_TOKEN_2 identifies the private store by static token.
// MEMORY_BLOB_READ_WRITE_TOKEN is deliberately NOT accepted: despite its name it
// resolved to the LEGACY public store, so using it as a fallback would silently
// route the private stores at a store that no longer exists.
export const PRIVATE_BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN_2 || '';

// Credential resolution for the private store:
//   1. Static read-write token (BLOB_READ_WRITE_TOKEN_2), when present.
//   2. OIDC federation — pass `storeId` ONLY and let @vercel/blob resolve the
//      token itself.
//
// Do NOT gate this on process.env.VERCEL_OIDC_TOKEN. At runtime the OIDC token
// is a per-request credential delivered in the `x-vercel-oidc-token` header and
// read via the SDK's async resolver (@vercel/oidc getVercelOidcToken:
// `getContext().headers?.['x-vercel-oidc-token'] ?? process.env.VERCEL_OIDC_TOKEN`).
// The env var exists only as a LOCAL-dev fallback — `vercel env pull` writes one,
// which is what made an env-var check look correct in local testing while
// failing closed on every production request once the static tokens were removed.
//
// The SDK's own last resort is the ambient BLOB_READ_WRITE_TOKEN. That binding
// is intentionally not part of this project's configuration (it pointed at the
// deleted legacy store); passing an explicit storeId keeps every private-store
// call pinned to the correct store regardless.
export function privateBlobOptions(options = {}) {
  if (PRIVATE_BLOB_TOKEN) return { ...options, token: PRIVATE_BLOB_TOKEN };
  const storeId = process.env.BLOB_STORE_ID?.trim();
  if (storeId) return { ...options, storeId };
  throw new Error(
    'A private Blob binding is required: set BLOB_READ_WRITE_TOKEN_2, or enable OIDC and set BLOB_STORE_ID.',
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
