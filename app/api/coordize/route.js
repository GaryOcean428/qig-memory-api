import { NextResponse } from 'next/server';
import { auth, unauthorizedReason } from '../../../lib/auth.js';

// POST /api/coordize — RETIRED 2026-07-20.
//
// This endpoint proxied conversation text to a Modal A10G GPU coordizer
// (vex-coordizer-harvest) that returned 64D basin coordinates. That Modal
// deployment is DECOMMISSIONED and will not be reactivated — so the endpoint
// returned a Modal 502 on every call and its 5-minute cron was pure waste.
//
// It now fails fast with a clear retired status. To bring basin coordization
// back, restore the Modal proxy from git history (the commit before this
// retirement) and set MODAL_COORDIZE_URL — though the standing architecture note
// applies: GPU compute belongs in qig-compute/qig-warp, not the storage service.
export async function POST(req) {
  if (!(await auth(req)))
    return NextResponse.json({ error: 'unauthorized', reason: await unauthorizedReason() }, { status: 401 });
  return NextResponse.json(
    {
      error: 'coordizer_retired',
      reason: 'The Modal GPU coordizer is decommissioned; basin coordization via /api/coordize is unavailable.',
    },
    { status: 503 },
  );
}
