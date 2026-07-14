import { verifyToken, hasAnyKey } from './api-keys';
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
  if (await verifyToken(token)) {
    return { type: 'api_key', scopes: ALL_SCOPES, trusted: true };
  }
  return allowOAuth ? getOAuthPrincipal(token) : null;
}

export function hasScope(principal, requiredScope) {
  return Boolean(principal?.scopes?.includes(requiredScope));
}

export async function authorize(req, requiredScope, options = {}) {
  const principal = await authenticate(req, options);
  return hasScope(principal, requiredScope) ? principal : null;
}

export async function auth(req, options = {}) {
  return Boolean(await authenticate(req, options));
}

export async function unauthorizedReason() {
  return (await hasAnyKey()) ? 'invalid_or_insufficient_bearer' : 'server_auth_not_configured';
}
