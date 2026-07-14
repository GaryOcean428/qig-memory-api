import { NextResponse } from 'next/server';
import { COOKIES, cookieOptions, decodeSession, revokeToken } from '../../../../../lib/vercel-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const raw = request.cookies.get(COOKIES.session)?.value;
  const session = raw ? decodeSession(raw) : null;

  if (session?.accessToken) {
    await revokeToken(session.accessToken);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIES.session, '', cookieOptions(0));
  return response;
}
