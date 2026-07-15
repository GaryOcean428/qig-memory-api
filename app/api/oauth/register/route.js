import { NextResponse } from 'next/server';
import {
  claimClientRegistration,
  findClientByFingerprint,
  isSafeRedirectUri,
  registerClient,
} from '../../../../lib/mcp-oauth-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
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

  // Idempotent DCR: clients (hermes, Claude, etc.) re-register on every connect.
  // Reuse the existing record for identical metadata so retries don't consume
  // rate-limit slots or proliferate duplicate clients.
  const existing = await findClientByFingerprint({ redirectUris, clientName: body.client_name });
  if (existing) {
    return NextResponse.json(existing, { status: 200, headers: { 'cache-control': 'no-store' } });
  }

  // Only genuinely new clients are rate-limited (per IP, per hour).
  const forwarded = request.headers.get('x-forwarded-for');
  const address = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  if (!(await claimClientRegistration(address))) {
    return NextResponse.json({ error: 'rate_limit_exceeded' }, { status: 429, headers: { 'retry-after': '3600' } });
  }

  const client = await registerClient({ redirectUris, clientName: body.client_name });
  return NextResponse.json(client, {
    status: 201,
    headers: { 'cache-control': 'no-store' },
  });
}
