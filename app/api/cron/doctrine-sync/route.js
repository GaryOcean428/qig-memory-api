import { syncDoctrine } from '../../../../lib/doctrine-sync';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Polls each doctrine repo's production branch head and re-syncs only when one
// has moved. Polling rather than a webhook: this service does not own the
// qig-verification / qig-applied repos, so it cannot rely on a webhook being
// configured there, and a missed webhook would silently freeze the canon.
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const force = new URL(request.url).searchParams.get('force') === '1';
  try {
    const result = await syncDoctrine({ force, trigger: 'cron' });
    return Response.json(result);
  } catch (error) {
    console.log('[v0] doctrine sync failed:', error?.message);
    return Response.json({ error: 'sync_failed', message: error?.message }, { status: 500 });
  }
}
