import { NextResponse } from 'next/server';

// POST /api/coordize — RETIRED 2026-07-20, hardened 2026-07-23.
//
// This endpoint proxied conversation text to a Modal A10G GPU coordizer
// (vex-coordizer-harvest) that returned 64D basin coordinates. That Modal
// deployment is DECOMMISSIONED and will not be reactivated — so the endpoint
// returned a Modal 502 on every call and its 5-minute cron was pure waste.
//
// 2026-07-23: production logs showed some caller hammering this route every
// ~4s and getting 401 Unauthorized (not even reaching the retired-status
// body) — a hot retry loop on an auth failure. Root cause: the OLD retired
// response gated on auth(req) BEFORE reporting the retirement, so any caller
// without a fresh credential — including whatever is still discovering this
// URL from the machine-readable `endpoints.coordize` entry that GET /api/kernel
// used to advertise (now removed, see app/api/kernel/route.js) — got a 401,
// which reads to auth-aware HTTP clients as "refresh the token and retry",
// not "stop calling forever". A dead route has no access-control question to
// answer, so auth is no longer checked here at all: EVERY caller, credentialed
// or not, gets an immediate, unambiguous 410 Gone — semantically "this will
// never come back", which well-behaved clients (and even naive ones) do not
// retry the way they retry a 401. This also removes the per-request token
// lookup that a 4s-interval caller was forcing on every hit.
//
// A one-line server log (User-Agent only — never headers/credentials) is kept
// so a persistent caller is still diagnosable from Vercel runtime logs without
// this route doing any other work.
//
// To bring basin coordization back, restore the Modal proxy from git history
// (the commit before the 2026-07-20 retirement) and set MODAL_COORDIZE_URL —
// though the standing architecture note applies: GPU compute belongs in
// qig-compute/qig-warp, not the storage service.
function retired(req) {
  const ua = req.headers.get('user-agent') || 'unknown';
  console.warn(`[coordize] retired route hit by user-agent="${ua}" — see app/api/coordize/route.js`);
  return NextResponse.json(
    {
      error: 'coordizer_retired',
      reason: 'The Modal GPU coordizer is decommissioned; basin coordization via /api/coordize is permanently unavailable. Stop calling this endpoint.',
    },
    { status: 410 },
  );
}

export async function POST(req) {
  return retired(req);
}

export async function GET(req) {
  return retired(req);
}
