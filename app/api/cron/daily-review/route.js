// Vercel Cron Job: Daily memory review
//
// Once a day, reviews the memory corpus for recurring patterns (common mistakes,
// bugs, anti-patterns), scans operator-nominated GitHub repos, pulls related
// science, and broadcasts consolidated suggestions to the inbox for connected
// agents. Makes a single model call per run to stay credit-frugal.

import { runDailyReview } from '../../../../lib/daily-reviewer';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request) {
  // Cron auth — FAIL CLOSED, matching /api/cron/coordize. If CRON_SECRET is unset
  // we refuse to run rather than expose an unauthenticated, credit-spending route.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();
  try {
    const result = await runDailyReview({ trigger: 'cron' });
    return Response.json({ ...result, elapsed_ms: Date.now() - t0 });
  } catch (err) {
    return Response.json(
      { ok: false, error: err.message, elapsed_ms: Date.now() - t0 },
      { status: 500 },
    );
  }
}
