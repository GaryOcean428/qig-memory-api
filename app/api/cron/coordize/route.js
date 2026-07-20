// Vercel Cron Job: Periodic basin coordize — RETIRED 2026-07-20.
//
// Removed from vercel.json crons. The Modal GPU coordizer it drove is
// decommissioned (see app/api/coordize/route.js) and will not be reactivated, so
// this fired every 5 minutes only to 502. Kept as a fail-closed no-op so a manual
// trigger returns a clear retired status instead of proxying to a dead endpoint.
export const runtime = 'nodejs';

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return Response.json({
    success: false,
    reason: 'coordizer_retired',
    note: 'Modal coordizer decommissioned; this cron is disabled (removed from vercel.json).',
  });
}
