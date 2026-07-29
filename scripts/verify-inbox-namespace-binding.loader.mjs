// ESM loader hook used ONLY by scripts/verify-inbox-namespace-binding.mjs.
//
// lib/inbox-store.js's sendInboxMessage() writes to the private Vercel Blob
// store via ./private-blob. This process has no BLOB_READ_WRITE_TOKEN_2 /
// BLOB_STORE_ID, so a real call would throw "A private Blob binding is
// required" — a false failure unrelated to the namespace check under test.
// This hook intercepts ONLY inbox-store.js's own import of './private-blob'
// and redirects it to an in-memory stub, so sendInboxMessage's "succeeds
// (calls through)" assertions exercise real code up to (and including) the
// store write call, without touching the network or requiring credentials.
//
// Section [5] of the verify script also dynamic-imports lib/qig-tools.js
// (to call the guarded tool `execute` functions directly), which imports
// `after` from 'next/server'. This worktree has no local node_modules (Node's
// ESM resolver walks up to the parent checkout's), and next's package.json
// exports map rejects the extensionless 'next/server' subpath under plain
// Node resolution (Next's own bundler accepts it; only relevant to this
// standalone script). `after` is never actually CALLED by anything this
// script exercises (the DENY paths throw before reaching it; the ALLOW paths
// tested live are task_create/artifact_finalize, neither of which use it), so
// a no-op stub is sufficient and does not mask any behavior under test.
//
// Nothing else is stubbed: lib/api-keys.js's normalizeNamespaces and
// lib/auth.js's namespacesRestricted/namespacesPermit are pure and need no
// stub at all; every other module resolves normally.

const STUB_URL = 'qig-stub:private-blob';
const NEXT_SERVER_STUB_URL = 'qig-stub:next-server';

const STUB_SOURCE = `
  export function isPreconditionFailed() { return false; }
  export async function canonicalEtag() { return 'stub-etag'; }
  export async function readPrivateJson() { return null; }
  export function listPrivate() { return Promise.resolve({ blobs: [], hasMore: false }); }
  export async function deletePrivate() { return null; }
  export async function writePrivateJson(pathname, value) {
    globalThis.__PRIVATE_BLOB_STUB__ ??= { writes: [] };
    globalThis.__PRIVATE_BLOB_STUB__.writes.push({ pathname, value });
    return { pathname, url: 'stub://' + pathname };
  }
`;

const NEXT_SERVER_STUB_SOURCE = `
  export function after(fn) {
    throw new Error('qig-verify-script: after() stub invoked — this script never expects to reach it');
  }
`;

// This repo's lib/*.js files use ESM `import`/`export` syntax without a
// `"type": "module"` in package.json (Next.js's own bundler resolves them
// regardless of that field) AND without explicit file extensions on relative
// specifiers (e.g. `from './private-blob'`) — both fine for webpack/SWC, but
// plain Node ESM resolution requires an explicit extension. Retrying a failed
// relative resolution with '.js' appended lets this loader run the REAL
// lib/*.js source files standalone, unmodified, exactly as Next.js sees them.
async function resolveWithExtensionFallback(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw error;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier === './private-blob' || specifier.endsWith('/private-blob')) &&
    context.parentURL &&
    context.parentURL.endsWith('/lib/inbox-store.js')
  ) {
    return { url: STUB_URL, shortCircuit: true };
  }
  if (specifier === 'next/server' && context.parentURL && context.parentURL.endsWith('/lib/qig-tools.js')) {
    return { url: NEXT_SERVER_STUB_URL, shortCircuit: true };
  }
  return resolveWithExtensionFallback(specifier, context, nextResolve);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    return { format: 'module', source: STUB_SOURCE, shortCircuit: true };
  }
  if (url === NEXT_SERVER_STUB_URL) {
    return { format: 'module', source: NEXT_SERVER_STUB_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
