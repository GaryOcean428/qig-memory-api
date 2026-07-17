import { cookies } from 'next/headers';
import { COOKIES, decodeSession, isOperatorIdentity } from './vercel-oauth';

// Server-side session access for RSC and Server Actions. Reads the httpOnly
// session cookie set by the Vercel OAuth callback. This is the ONLY auth the
// admin UI relies on — it never holds the QIG_API_KEY bearer in the browser.
export async function getSession() {
  const store = await cookies();
  const raw = store.get(COOKIES.session)?.value;
  const session = raw ? decodeSession(raw) : null;
  if (!session?.user) return null;
  // Re-check on every read, not just at login: a cookie is valid for seven days,
  // so an identity removed from the allowlist would otherwise keep full access
  // for a week. This also revokes any session minted before the allowlist existed.
  if (!isOperatorIdentity(session.user)) return null;
  return session;
}

// Throws when there is no authenticated session. Server Actions call this first
// so store mutations can never run for an unauthenticated caller.
export async function requireSession() {
  const session = await getSession();
  if (!session) throw new Error('unauthorized');
  return session;
}
