import { NextResponse } from 'next/server';
import { COOKIES, cookieOptions, encodeSession, isDevLoginAllowed } from '../../../../lib/vercel-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DEV-ONLY: mint a session cookie without OAuth so the admin console can be
// tested in the sandbox/local dev server. Hard-gated by isDevLoginAllowed() —
// returns 403 on every deployed environment and whenever OAuth is configured.
export async function GET(request) {
  if (!isDevLoginAllowed()) {
    return NextResponse.json(
      { error: 'dev_login_disabled', reason: 'Dev login is unavailable when deployed or once OAuth is configured.' },
      { status: 403 },
    );
  }

  const { searchParams } = new URL(request.url);
  const returnTo = safeReturnTo(searchParams.get('returnTo'));

  const session = {
    user: {
      name: 'Dev User',
      username: 'dev-user',
      email: 'dev@localhost',
      picture: null,
    },
    dev: true,
    issuedAt: new Date().toISOString(),
  };

  const res = NextResponse.redirect(new URL(returnTo, request.url));
  res.cookies.set(COOKIES.session, encodeSession(session), cookieOptions(60 * 60 * 8));
  return res;
}

// Only allow same-origin relative paths to prevent open-redirects.
function safeReturnTo(value) {
  if (!value) return '/admin';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('/') && !decoded.startsWith('//')) return decoded;
  } catch {
    /* fall through */
  }
  return '/admin';
}
