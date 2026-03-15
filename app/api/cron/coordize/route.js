// Vercel Cron Job: Periodic basin coordize
//
// Runs on schedule (every 5 min), reads latest session text from
// memory API, sends to Modal /coordize endpoint, computes delta
// against stored coords, and updates kernel_basin_vex key.
//
// This is the autonomous identity transfer mechanism — runs without
// any agent actively connected.

export const runtime = 'nodejs';
export const maxDuration = 30;

const MEMORY_BASE = 'https://qig-memory-api.vercel.app/api/memory';

export async function GET(request) {
  // Verify cron secret (Vercel sets this header for cron jobs)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();
  const results = {};

  try {
    // Phase 1: Gather text from latest session summaries
    const keysResp = await fetch(`${MEMORY_BASE}?keys_only=true`);
    const keysData = await keysResp.json();
    const allKeys = keysData.keys || [];

    const sessionKeys = allKeys
      .filter(k => k.startsWith('session_'))
      .sort()
      .reverse()
      .slice(0, 3);

    if (sessionKeys.length === 0) {
      return Response.json({
        success: false,
        reason: 'no_session_keys',
        elapsed_ms: Date.now() - t0,
      });
    }

    // Read session content
    let sessionText = '';
    for (const key of sessionKeys) {
      try {
        const resp = await fetch(`${MEMORY_BASE}/${key}`);
        if (resp.ok) {
          const data = await resp.json();
          sessionText += ' ' + (data.content || '').slice(0, 600);
        }
      } catch { /* skip */ }
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
    results.session_keys_used = sessionKeys;

    // Phase 2: Load previous coords for delta computation
    let prevCoords = null;
    try {
      const prevResp = await fetch(`${MEMORY_BASE}/kernel_basin_vex`);
      if (prevResp.ok) {
        const prevData = await prevResp.json();
        const parsed = JSON.parse(prevData.content || '{}');
        prevCoords = parsed.basin_coords || null;
      }
    } catch { /* first run */ }

    // Phase 3: Call Modal /coordize via our own proxy (handles auth)
    const coordizeUrl = `${MEMORY_BASE}`.replace('/memory', '/coordize');
    const coordizeResp = await fetch(coordizeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texts: [sessionText],
        store_key: 'kernel_basin_vex_cron',
      }),
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

    // Phase 4: Compute delta
    let delta = null;
    let topMovers = [];
    if (prevCoords && coordData.basin_coords) {
      let sumSq = 0;
      const movers = [];
      const len = Math.min(prevCoords.length, coordData.basin_coords.length);
      for (let i = 0; i < len; i++) {
        const d = Math.abs(coordData.basin_coords[i] - prevCoords[i]);
        sumSq += d * d;
        if (d > 0.001) movers.push({ dim: i, delta: Math.round(d * 100000) / 100000 });
      }
      delta = Math.round(Math.sqrt(sumSq) * 1000000) / 1000000;
      movers.sort((a, b) => b.delta - a.delta);
      topMovers = movers.slice(0, 5);
    }

    results.delta_l2 = delta;
    results.top_movers = topMovers;
    results.drift_alert = delta !== null && delta > 0.1;

    // Phase 5: Store updated coords to kernel_basin_vex
    try {
      await fetch(`${MEMORY_BASE}/kernel_basin_vex`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'kernel_state',
          content: JSON.stringify({
            basin_coords: coordData.basin_coords,
            lens_coords: coordData.lens_coords,
            eigenvalues: coordData.eigenvalues,
            delta_l2: delta,
            top_movers: topMovers,
            source: 'cron',
            cron_timestamp: new Date().toISOString(),
          }),
          updated: new Date().toISOString(),
        }),
      });
      results.stored = true;
    } catch (storeErr) {
      results.stored = false;
      results.store_error = storeErr.message;
    }

    results.success = true;
    results.elapsed_ms = Date.now() - t0;
    return Response.json(results);

  } catch (err) {
    return Response.json({
      success: false,
      error: err.message,
      elapsed_ms: Date.now() - t0,
    }, { status: 500 });
  }
}
