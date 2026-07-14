import { NextResponse } from 'next/server';
import { isSafeRedirectUri, registerClient } from '../../../../lib/mcp-oauth-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const registrations = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_REGISTRATIONS = 20;

function registrationAllowed(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  const address = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  const now = Date.now();
  const recent = (registrations.get(address) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_REGISTRATIONS) return false;
  registrations.set(address, [...recent, now]);
  return true;
}

export async function POST(request) {
  if (!registrationAllowed(request)) {
    return NextResponse.json({ error: 'rate_limit_exceeded' }, { status: 429, headers: { 'retry-after': '3600' } });
  }
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 16_384) {
    return NextResponse.json({ error: 'invalid_client_metadata' }, { status: 413 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_client_metadata' }, { status: 400 });
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!redirectUris.length || redirectUris.length > 10 || redirectUris.some((uri) => !isSafeRedirectUri(uri))) {
    return NextResponse.json(
      { error: 'invalid_redirect_uri', error_description: 'Use HTTPS or a loopback HTTP redirect URI.' },
      { status: 400 },
    );
  }
  const client = await registerClient({ redirectUris, clientName: body.client_name });
  return NextResponse.json(client, {
    status: 201,
    headers: { 'cache-control': 'no-store' },
  });
}
