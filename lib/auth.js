// Shared auth helper for the PUBLIC /api/* surface (REST + MCP endpoint).
// Auth model: single bearer token in QIG_API_KEY.
//
// FAIL-CLOSED: if QIG_API_KEY is unset, every request is DENIED. An unset key
// is treated as a misconfiguration, never as "open" — the memory store must
// never be world-readable/writable at a public URL.
//
// NOTE: the service's own internal callers (the helper agent, the kernel and
// coordize routes, the memory-browser server actions, and the MCP tool
// executors) call the shared memory-store lib DIRECTLY and never traverse this
// check, so enabling the key does not 401 the app's own features.

export const API_KEY = process.env.QIG_API_KEY || '';
export const AUTH_CONFIGURED = API_KEY.length > 0;

export function auth(req) {
  if (!API_KEY) return false; // fail-closed: no key configured => deny
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

// 401 body that tells a caller WHY without leaking whether a key exists.
export function unauthorizedReason() {
  return AUTH_CONFIGURED
    ? 'missing_or_invalid_bearer'
    : 'server_auth_not_configured'; // QIG_API_KEY unset on the server
}
