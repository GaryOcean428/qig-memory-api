import { NextResponse } from 'next/server';
import {
  consumeAuthorizationCode,
  getClient,
  issueTokens,
  refreshTokens,
} from '../../../../lib/mcp-oauth-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'cache-control': 'no-store', pragma: 'no-cache' };

function error(error, description, status = 400) {
  return NextResponse.json({ error, error_description: description }, { status, headers });
}

export async function POST(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return error('invalid_request', 'Expected form-encoded token request.');
  }
  const grantType = form.get('grant_type');
  const clientId = String(form.get('client_id') || '');
  const client = await getClient(clientId);
  if (!client) return error('invalid_client', 'Unknown OAuth client.', 401);

  if (grantType === 'authorization_code') {
    const code = String(form.get('code') || '');
    const redirectUri = String(form.get('redirect_uri') || '');
    const codeVerifier = String(form.get('code_verifier') || '');
    const authorization = await consumeAuthorizationCode({ code, clientId, redirectUri, codeVerifier });
    if (!authorization) return error('invalid_grant', 'Authorization code is invalid, expired, or PKCE verification failed.');
    return NextResponse.json(
      await issueTokens({ clientId, userId: authorization.user_id, scope: authorization.scope }),
      { headers },
    );
  }

  if (grantType === 'refresh_token') {
    const tokens = await refreshTokens({ refreshToken: String(form.get('refresh_token') || ''), clientId });
    if (!tokens) return error('invalid_grant', 'Refresh token is invalid or expired.');
    return NextResponse.json(tokens, { headers });
  }

  return error('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}
