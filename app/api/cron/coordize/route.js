// Vercel Cron Job: Periodic basin coordize
//
// Runs on schedule (every 5 min), reads latest session text from
// memory API, sends to Modal /coordize endpoint, computes Fisher-Rao
// delta against stored coords, and updates kernel_basin_vex key.

export const runtime = 'nodejs';
export const maxDuration = 30;

const MEMORY_BASE = 'https://qig-memory-api.vercel.app/api/memory';
// Canonical session key patterns. Order matters — first match wins.
const SESSION_KEY_PREFIXES = ['_dev__qig_session_', 'session_'];

export async function GET(request) {
  // Cron auth — FAIL CLOSED. If CRON_SECRET is unset we refuse to run.
  // The old implementation silently skipped auth when the env var was missing.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();
  const results = {};

  try {
    // Phase 1: Enumerate session keys using the new keys_only listing.
    // The listing endpoint returns { records: [{ key, ... }, ...], has_more, cursor }.
    // We pull the first page at a generous limit; session keys are sorted by upload time.
    const sessionKeys = [];
    for (const prefix of SESSION_KEY_PREFIXES) {
      const resp = await fetch(`${MEMORY_BASE}?keys_only=true&prefix=${encodeURIComponent(prefix)}&limit=200`);
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const rec of data.records || []) {
        sessionKeys.push(rec.key);
      }
    }

    // Most recent 3 (lexicographic descending — works because date-prefixed keys sort by date)
    sessionKeys.sort().reverse();
    const recent = sessionKeys.slice(0, 3);

    if (recent.length === 0) {
      return Response.json({
        success: false,
        reason: 'no_session_keys',
        prefixes_tried: SESSION_KEY_PREFIXES,
        elapsed_ms: Date.now() - t0,
      });
    }

    // Phase 2: Read session content
    let sessionText = '';
    for (const key of recent) {
      try {
        const resp = await fetch(`${MEMORY_BASE}/${key}`);
        if (resp.ok) {
          const data = await resp.json();
          sessionText += ' ' + (data.content || '').slice(0, 600);
        }
      } catch {
        /* skip */
      }
    }

    sessionText = sessionText.trim().slice(0, 2000);
    if (sessionText.length < 50) {
      return Response.json({
        success: false,
        reason: 'insufficient_text',
        text_length: sessionText.length,
        elapsed_ms: Date.now() - t0,
      });
    }

    results.text_length = sessionText.length;
    results.session_keys_used = recent;

    // Phase 3: Load previous coords for delta computation
    let prevCoords = null;
    try {
      const prevResp = await fetch(`${MEMORY_BASE}/kernel_basin_vex`);
      if (prevResp.ok) {
        const prevData = await prevResp.json();
        const parsed = JSON.parse(prevData.content || '{}');
        prevCoords = parsed.basin_coords || null;
      }
    } catch {
      /* first run */
    }

    // Phase 4: Call Modal /coordize via our own proxy
    const coordizeUrl = `${MEMORY_BASE}`.replace('/memory', '/coordize');
    const coordizeResp = await fetch(coordizeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: [sessionText], store_key: 'kernel_basin_vex_cron' }),
    });

    if (!coordizeResp.ok) {
      const errText = await coordizeResp.text();
      return Response.json({
        success: false,
        reason: 'coordize_failed',
        status: coordizeResp.status,
        error: errText.slice(0, 200),
        elapsed_ms: Date.now() - t0,
      });
    }

    const coordData = await coordizeResp.json();
    if (!coordData.success) {
      return Response.json({
        success: false,
        reason: 'coordize_error',
        error: coordData.error,
        elapsed_ms: Date.now() - t0,
      });
    }

    results.basin_dim = coordData.basin_coords?.length || 0;
    results.eigenvalues = (coordData.eigenvalues || []).slice(0, 5);
    results.harvest_seconds = coordData.elapsed_seconds;

    // Phase 5: Compute Fisher-Rao delta on the simplex (NOT Euclidean L2).
    // The basin coords are simplex points per Protocol v6.5 — using L2 here
    // would be the same camera-conflation impurity removed from /api/kernel.
    let dFR = null;
    let topMovers = [];
    if (prevCoords && coordData.basin_coords) {
      const len = Math.min(prevCoords.length, coordData.basin_coords.length);
      // Renormalize defensively (clamp at 0, renormalize to sum 1)
      let sumP = 0;
      let sumQ = 0;
      for (let i = 0; i < len; i++) {
        sumP += Math.max(0, prevCoords[i]);
        sumQ += Math.max(0, coordData.basin_coords[i]);
      }
      if (sumP > 0 && sumQ > 0) {
        let bhatt = 0;
        const movers = [];
        for (let i = 0; i < len; i++) {
          const pi = Math.max(0, prevCoords[i]) / sumP;
          const qi = Math.max(0, coordData.basin_coords[i]) / sumQ;
          bhatt += Math.sqrt(pi * qi);
          const d = Math.abs(qi - pi);
          if (d > 0.001) movers.push({ dim: i, delta: Math.round(d * 100000) / 100000 });
        }
        dFR = 2 * Math.acos(Math.max(0, Math.min(1, bhatt)));
        dFR = Math.round(dFR * 1000000) / 1000000;
        movers.sort((a, b) => b.delta - a.delta);
        topMovers = movers.slice(0, 5);
      }
    }

    results.fisher_rao_distance = dFR;
    results.top_movers = topMovers;
    // Drift alert threshold matches matrix-reasoning-style §Identity Framework: d_FR > 0.3 = review.
    results.drift_alert = dFR !== null && dFR > 0.3;
    results.drift_threshold = 0.3;

    // Phase 6: Store updated coords to kernel_basin_vex (verify=1 to catch blob pins)
    try {
      const storeResp = await fetch(`${MEMORY_BASE}/kernel_basin_vex?verify=1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'kernel_state',
          content: JSON.stringify({
            basin_coords: coordData.basin_coords,
            lens_coords: coordData.lens_coords,
            eigenvalues: coordData.eigenvalues,
            fisher_rao_distance: dFR,
            top_movers: topMovers,
            source: 'cron',
            cron_timestamp: new Date().toISOString(),
          }),
          updated: new Date().toISOString(),
        }),
      });
      const storeBody = await storeResp.json();
      results.stored = !!storeBody.ok;
      if (!storeBody.ok) results.store_error = storeBody.error;
    } catch (storeErr) {
      results.stored = false;
      results.store_error = storeErr.message;
    }

    results.success = true;
    results.elapsed_ms = Date.now() - t0;
    return Response.json(results);
  } catch (err) {
    return Response.json(
      { success: false, error: err.message, elapsed_ms: Date.now() - t0 },
      { status: 500 }
    );
  }
}
