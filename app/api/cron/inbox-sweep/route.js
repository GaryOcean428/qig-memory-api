import { sweepInbox } from '../../../../lib/inbox-store';
import { reapStaleCouncilJobs, redeliverUndeliveredRulings } from '../../../../lib/council';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Piggyback council maintenance on this hourly sweep, cheap + no new infra:
  //  - liveness reaper (F3): flip any orphaned 'running' record to 'failed';
  //  - delivery reaper: re-deliver any completed, convener-addressed ruling whose
  //    inbox delivery never landed (the "done isn't delivered" gap).
  const [inbox, council, delivery] = await Promise.all([
    sweepInbox({ limit: 1000 }),
    reapStaleCouncilJobs().catch((err) => ({ error: err?.message })),
    redeliverUndeliveredRulings().catch((err) => ({ error: err?.message })),
  ]);
  return Response.json({ inbox, council, delivery });
}
