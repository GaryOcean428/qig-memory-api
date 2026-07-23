import { sweepInboxChain } from '../../../../lib/inbox-store';
import { reapStaleCouncilJobs, redeliverUndeliveredRulings } from '../../../../lib/council';

export const runtime = 'nodejs';
// Was 60 — a stale holdover from before Vercel raised the platform default/max to
// 300s on all plans. sweepInbox({ limit: 1000 }) below pages up to 1000 blobs per
// invocation; even with the sequential-read bug fixed (see lib/inbox-store.js),
// 300s matches the headroom already given to this route's bulk-processing
// siblings (cron/daily-review, cron/run-tasks) rather than an arbitrary bump.
export const maxDuration = 300;

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
  // sweepInboxChain follows the sweep's composite cursor to the END of the
  // walk (not one 1000-blob page), because minting the ts-index markers
  // requires a chain reaching has_more=false — a one-shot sweep would re-index
  // the same first 1000 messages every run forever without ever activating the
  // index path. Now that this cron is DAILY (PR #81), completing walks matters
  // even more: see the budget arithmetic and the cross-invocation persisted
  // resume in lib/inbox-store.js.
  const [inbox, council, delivery] = await Promise.all([
    sweepInboxChain({ pageBudget: 20, limit: 1000 }),
    reapStaleCouncilJobs().catch((err) => ({ error: err?.message })),
    redeliverUndeliveredRulings().catch((err) => ({ error: err?.message })),
  ]);
  return Response.json({ inbox, council, delivery });
}
