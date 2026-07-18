import { NextResponse } from 'next/server';
import { createApiKey } from '../../../../lib/api-keys.js';
import { requireApiScope, deniedResponse, errorResponse } from '../../../../lib/http-auth.js';

export const runtime = 'nodejs';
export const maxDuration = 30;

// POST /api/keys/synapse — provision a NARROW, revocable key for the synapse
// daemon (or any headless poller), so scripts/synapse/setup.sh can give the
// daemon its OWN least-privilege credential instead of reusing the operator's.
//
// Admin-gated: minting a credential is an admin act, so the caller must present a
// memory:admin (or full-access bootstrap) bearer — the same privilege the admin
// UI's "create key" already requires. It does NOT widen what an admin can do
// (an admin bearer already reads/writes/deletes everything); it only exposes the
// existing mint capability over the API for headless provisioning. The minted key
// is scoped DOWN to memory:read + memory:write ONLY (poll the inbox + write the
// heartbeat — never admin/delete). The plaintext token is returned ONCE; only its
// SHA-256 hash is persisted (see lib/api-keys.js). Revoke it from the admin UI
// like any other key.
export async function POST(req) {
  const auth = await requireApiScope(req, 'memory:admin');
  if (auth.error) return deniedResponse(auth);
  try {
    let host = '';
    try {
      const body = await req.json();
      if (body && typeof body.host === 'string') host = body.host.slice(0, 64).replace(/[^\w.@:-]/g, '');
    } catch {
      // request body is optional
    }
    const label = `synapse-daemon${host ? ` @ ${host}` : ''}`;
    const { token, key } = await createApiKey({
      label,
      createdBy: `synapse-provision:${auth.principal?.key_id || 'admin'}`,
      scopes: ['memory:read', 'memory:write'],
    });
    // token is shown exactly once — the caller writes it to synapse.env.
    return NextResponse.json({ token, key, scopes: ['memory:read', 'memory:write'] }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export function GET() {
  return NextResponse.json(
    { error: 'method_not_allowed', hint: 'POST with a memory:admin bearer to mint a scoped synapse-daemon key' },
    { status: 405, headers: { allow: 'POST' } },
  );
}
