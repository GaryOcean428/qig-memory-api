import { NextResponse } from 'next/server';
import { COOKIES, isOAuthConfigured, isDevLoginAllowed, decodeSession } from '../../../../lib/vercel-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const raw = request.cookies.get(COOKIES.session)?.value;
  const session = raw ? decodeSession(raw) : null;

  return NextResponse.json({
    configured: isOAuthConfigured(),
    devLogin: isDevLoginAllowed(),
    authenticated: Boolean(session?.user),
    user: session?.user ?? null,
  });
}
