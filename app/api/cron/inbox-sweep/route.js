import { sweepInbox } from '../../../../lib/inbox-store';
import { reapStaleCouncilJobs } from '../../../../lib/council';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Piggyback the council liveness reaper on this hourly sweep (F3): flip any
  // orphaned 'running' council record to 'failed'. Cheap, no new infra.
  const [inbox, council] = await Promise.all([
    sweepInbox({ limit: 1000 }),
    reapStaleCouncilJobs().catch((err) => ({ error: err?.message })),
  ]);
  return Response.json({ inbox, council });
}
