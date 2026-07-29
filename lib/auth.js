import { resolveToken, hasAnyKey } from './api-keys';
import { getOAuthPrincipal } from './mcp-oauth-store';

const ALL_SCOPES = ['memory:read', 'memory:write', 'memory:delete', 'memory:admin'];

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
    return {
      type: 'api_key',
      scopes: key.scopes || ALL_SCOPES,
      trusted: !key.scopes,
      key_id: key.id,
      namespaces: key.namespaces ?? null,
    };
  }
  return allowOAuth ? getOAuthPrincipal(token) : null;
}

export function hasScope(principal, requiredScope) {
  return Boolean(principal?.scopes?.includes(requiredScope));
}

// Design principle for every operation that performs an INDIRECT inbox write
// (i.e. not the caller's own inbox_send call, which lib/inbox-store.js
// enforces directly): a credential with a non-null `namespaces` allow-list may
// not invoke any operation that performs an inbox write it cannot carry.
//
// These are the SINGLE canonical implementation of that rule — every guard in
// the app (REST routes checking a `principal`, MCP tool `execute`s checking
// the raw `ctx.allowedNamespaces` array-or-null) calls through to
// `namespacesRestricted` / `namespacesPermit` below, so there is exactly one
// place the fail-closed logic can drift.
//
// namespacesRestricted: true for anything OTHER than a true null/undefined
// `namespaces` value — used to gate operations whose inbox write namespace is
// NOT statically known to be safe for every restricted credential (e.g. the
// autonomous task runner's LLM-driven, caller-controlled inbox_send — see
// lib/task-runner.js buildAgentTools). ANY non-null value denies these
// outright (including a malformed non-array value: FAIL CLOSED, matching
// sendInboxMessage's own gate — a bug that produces a bad `namespaces` value
// must never be equivalent to granting full access), because the operation
// cannot promise which namespace it will end up writing.
export function namespacesRestricted(namespaces) {
  return namespaces != null;
}

// namespacesPermit: true when `namespaces` is unrestricted (null) OR is an
// array that includes `namespace` — used to gate operations with a SINGLE
// hardcoded, statically-known write namespace (council rulings and artifact
// broadcasts both always write 'qig'). A non-null, non-array value fails
// CLOSED (denied), not open.
export function namespacesPermit(namespaces, namespace) {
  if (namespaces == null) return true;
  return Array.isArray(namespaces) && namespaces.includes(namespace);
}

// Principal-shaped convenience wrappers for the REST routes, which carry a
// full `principal` object rather than a bare namespaces value.
export function isNamespaceRestricted(principal) {
  return namespacesRestricted(principal?.namespaces);
}
export function namespacePermits(principal, namespace) {
  return namespacesPermit(principal?.namespaces, namespace);
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
