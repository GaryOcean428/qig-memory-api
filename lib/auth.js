// Shared auth helper for the PUBLIC /api/* surface (REST + MCP endpoint).
//
// Auth model: bearer tokens. Valid credentials are (a) the QIG_API_KEY env var
// (bootstrap) and (b) any key minted from the session-gated admin UI, stored as
// a SHA-256 hash in Blob (see lib/api-keys.js).
//
// FAIL-CLOSED: with no env key AND no minted keys, every request is DENIED. An
// absent credential is a misconfiguration, never "open" — the memory store must
// never be world-readable/writable at a public URL.
//
// NOTE: the service's own internal callers (the helper agent, the kernel and
// coordize routes, the memory-browser server actions, and the MCP tool
// executors) call the shared memory-store lib DIRECTLY and never traverse this
// check, so enabling auth does not 401 the app's own features.

import { verifyToken, hasAnyKey } from './api-keys';
import { verifyOAuthAccessToken } from './mcp-oauth-store';

function bearerFrom(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

// Async: verification may read stored key hashes from Blob. OAuth access
// tokens are accepted only where explicitly enabled (the MCP resource), while
// manually generated API keys continue to authenticate REST + MCP.
export async function auth(req, { allowOAuth = false } = {}) {
  const token = bearerFrom(req);
  if (!token) return false;
  if (await verifyToken(token)) return true;
  return allowOAuth ? verifyOAuthAccessToken(token) : false;
}

// 401 body that tells a caller WHY without leaking whether a specific key exists.
export async function unauthorizedReason() {
  return (await hasAnyKey()) ? 'missing_or_invalid_bearer' : 'server_auth_not_configured';
}
