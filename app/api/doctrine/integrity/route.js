import { NextResponse } from 'next/server';
import { authorize, unauthorizedReason } from '../../../../lib/auth.js';
import { getIntegrityView } from '../../../../lib/doctrine-sync.js';

// Token-scoped, read-only: the generated integrity-dashboard view for agents/CI.
// Reads ONLY the cached view (never fetches GitHub) and enforces the same
// memory:read scope (bearer API key OR OAuth) as the memory API. The literal
// "read-only, token-scoped" ruling from the rebuild directive.
export const maxDuration = 60;

export async function GET(req) {
  if (!(await authorize(req, 'memory:read', { allowOAuth: true }))) {
    return NextResponse.json(
      { error: 'unauthorized', reason: await unauthorizedReason() },
      { status: 401 },
    );
  }

  const view = await getIntegrityView();
  if (!view) {
    // Synced-but-absent is a real state before the first sync after deploy, or
    // if the generated sources have never resolved. Say so; do not 200 an empty.
    return NextResponse.json(
      { error: 'unavailable', reason: 'integrity view has not been synced yet', synced_at: null },
      { status: 503 },
    );
  }
  return NextResponse.json(view);
}
