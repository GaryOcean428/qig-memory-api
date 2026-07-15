// Vercel Cron Job: Scheduled task runner
//
// Every 5 minutes, finds tasks whose next run is due and executes them with the
// helper agent (full read-write toolset, council excluded). Capped per tick so a
// single run can't exhaust the function or credit budget. See lib/task-runner.js.

import { runDueTasks } from '../../../../lib/task-runner';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request) {
  // Cron auth — FAIL CLOSED, matching the other cron routes. If CRON_SECRET is
  // unset we refuse rather than expose an unauthenticated, credit-spending route.
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
    const result = await runDueTasks({ trigger: 'cron' });
    return Response.json({ ...result, elapsed_ms: Date.now() - t0 });
  } catch (err) {
    return Response.json(
      { ok: false, error: err.message, elapsed_ms: Date.now() - t0 },
      { status: 500 },
    );
  }
}
