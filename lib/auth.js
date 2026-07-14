import { resolveToken, hasAnyKey } from './api-keys';
import { getOAuthPrincipal } from './mcp-oauth-store';

const ALL_SCOPES = ['memory:read', 'memory:write', 'memory:admin'];

function bearerFrom(req) {
  const header = req.headers.get('authorization') || '';
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === 'bearer' ? token : null;
}

export async function authenticate(req, { allowOAuth = false } = {}) {
  const token = bearerFrom(req);
  if (!token) return null;
  const key = await resolveToken(token);
  if (key) {
    // Keys minted with explicit scopes are limited to them; legacy keys and
    // the env bootstrap key (scopes: null) remain full-access.
    return { type: 'api_key', scopes: key.scopes || ALL_SCOPES, trusted: !key.scopes, key_id: key.id };
  }
  return allowOAuth ? getOAuthPrincipal(token) : null;
}

export function hasScope(principal, requiredScope) {
  return Boolean(principal?.scopes?.includes(requiredScope));
}

export async function authorizeDetailed(req, requiredScope, options = {}) {
  const principal = await authenticate(req, options);
  if (!principal) return { principal: null, status: 401, error: 'invalid_token' };
  if (!hasScope(principal, requiredScope)) {
    return { principal, status: 403, error: 'insufficient_scope', requiredScope };
  }
  return { principal, status: 200, error: null };
}

export async function authorize(req, requiredScope, options = {}) {
  const result = await authorizeDetailed(req, requiredScope, options);
  return result.principal && !result.error ? result.principal : null;
}

export async function auth(req, options = {}) {
  return Boolean(await authenticate(req, options));
}

export async function unauthorizedReason() {
  return (await hasAnyKey()) ? 'invalid_or_insufficient_bearer' : 'server_auth_not_configured';
}
