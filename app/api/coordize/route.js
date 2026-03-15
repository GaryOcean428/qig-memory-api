import { NextResponse } from 'next/server';

const API_KEY = process.env.QIG_API_KEY || '';
const HARVEST_URL = process.env.MODAL_HARVEST_URL || '';
const KERNEL_API_KEY_MODAL = process.env.KERNEL_API_KEY || '';

function auth(req) {
  if (!API_KEY) return true;
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

/**
 * POST /api/coordize
 * 
 * Genesis kernel endpoint: takes conversation text, sends to harvest for
 * fingerprinting, runs PGA compress to 64D basin coordinates.
 * 
 * Body: { texts: string[], store_key?: string, min_contexts?: number,
 *         target_tokens?: number, lens_dim?: number }
 */
export async function POST(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!HARVEST_URL) return NextResponse.json({ error: 'MODAL_HARVEST_URL not set' }, { status: 500 });

  const body = await req.json();
  const { texts, store_key, min_contexts = 3, target_tokens = 0, lens_dim = 32 } = body;

  if (!texts || !texts.length) {
    return NextResponse.json({ error: 'texts array required' }, { status: 400 });
  }

  try {
    // Modal fastapi_endpoint receives JSON body as dict param.
    // Auth passed as _api_key in body (not header).
    const harvestBody = { texts, min_contexts, target_tokens, batch_size: 16, max_length: 512 };
    if (KERNEL_API_KEY_MODAL) harvestBody._api_key = KERNEL_API_KEY_MODAL;

    const harvestRes = await fetch(HARVEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(harvestBody)
    });

    if (!harvestRes.ok) {
      const err = await harvestRes.text();
      return NextResponse.json({ error: `Harvest failed: ${harvestRes.status}`, detail: err }, { status: 502 });
    }

    const harvest = await harvestRes.json();
    if (!harvest.success) {
      return NextResponse.json({ error: 'Harvest returned failure', detail: harvest }, { status: 502 });
    }

    const tokenEntries = Object.values(harvest.tokens || {});
    if (tokenEntries.length === 0) {
      return NextResponse.json({ 
        success: false,
        error: 'No tokens met min_contexts threshold',
        harvest_meta: { model_id: harvest.model_id, vocab_size: harvest.vocab_size, total_tokens: harvest.total_tokens_processed }
      });
    }

    // PGA compress: V-dim fingerprints -> 64D basin coordinates
    const V = tokenEntries[0].fingerprint.length;
    const N = tokenEntries.length;

    // Global mean in sqrt space (Frechet mean on probability simplex)
    const globalMeanSqrt = new Float64Array(V);
    for (const entry of tokenEntries) {
      const fp = entry.fingerprint;
      for (let i = 0; i < V; i++) globalMeanSqrt[i] += Math.sqrt(Math.max(fp[i], 1e-12));
    }
    for (let i = 0; i < V; i++) globalMeanSqrt[i] /= N;
    let normSq = 0;
    for (let i = 0; i < V; i++) normSq += globalMeanSqrt[i] * globalMeanSqrt[i];
    const norm = Math.sqrt(normSq);
    for (let i = 0; i < V; i++) globalMeanSqrt[i] /= norm;

    // Center in tangent space
    const centered = tokenEntries.map(entry => {
      const row = new Float64Array(V);
      const fp = entry.fingerprint;
      for (let i = 0; i < V; i++) row[i] = Math.sqrt(Math.max(fp[i], 1e-12)) - globalMeanSqrt[i];
      return row;
    });

    // Dual Gram matrix (N x N since N << V)
    const G = Array.from({ length: N }, () => new Float64Array(N));
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        let dot = 0;
        for (let k = 0; k < V; k++) dot += centered[i][k] * centered[j][k];
        G[i][j] = dot; G[j][i] = dot;
      }
    }

    // Power iteration for top eigenvalues
    const targetDim = Math.min(lens_dim, N, 64);
    const eigenVecs = [];
    const eigenVals = [];

    for (let d = 0; d < targetDim; d++) {
      let v = new Float64Array(N);
      for (let i = 0; i < N; i++) v[i] = Math.random() - 0.5;

      for (let iter = 0; iter < 100; iter++) {
        const Gv = new Float64Array(N);
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) Gv[i] += G[i][j] * v[j];
        for (const prev of eigenVecs) {
          let proj = 0;
          for (let i = 0; i < N; i++) proj += Gv[i] * prev[i];
          for (let i = 0; i < N; i++) Gv[i] -= proj * prev[i];
        }
        let mag = 0;
        for (let i = 0; i < N; i++) mag += Gv[i] * Gv[i];
        mag = Math.sqrt(mag);
        if (mag < 1e-10) break;
        for (let i = 0; i < N; i++) v[i] = Gv[i] / mag;
      }

      let eigenVal = 0;
      const Gv2 = new Float64Array(N);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) Gv2[i] += G[i][j] * v[j];
      for (let i = 0; i < N; i++) eigenVal += v[i] * Gv2[i];
      eigenVecs.push(v);
      eigenVals.push(eigenVal);
    }

    // Project to basin coords (64D, unit normalized)
    const basinCoords = new Float64Array(64);
    const lensCoords = new Float64Array(targetDim);

    for (let d = 0; d < targetDim; d++) {
      let coord = 0;
      for (let i = 0; i < N; i++) {
        let proj = 0;
        for (let k = 0; k < V; k++) proj += centered[i][k] * globalMeanSqrt[k];
        coord += eigenVecs[d][i] * proj;
      }
      lensCoords[d] = coord;
      if (d < 64) basinCoords[d] = coord;
    }

    let basinNorm = 0;
    for (let i = 0; i < 64; i++) basinNorm += basinCoords[i] * basinCoords[i];
    basinNorm = Math.sqrt(basinNorm);
    if (basinNorm > 1e-10) for (let i = 0; i < 64; i++) basinCoords[i] /= basinNorm;

    const result = {
      success: true,
      basin_coords: Array.from(basinCoords),
      lens_coords: Array.from(lensCoords),
      harvest_meta: {
        model_id: harvest.model_id, vocab_size: harvest.vocab_size,
        total_tokens_processed: harvest.total_tokens_processed,
        unique_tokens: tokenEntries.length, elapsed_seconds: harvest.elapsed_seconds
      },
      eigenvalues: eigenVals.slice(0, 10),
      pga_dim: targetDim
    };

    if (store_key) {
      await fetch(`https://qig-memory-api.vercel.app/api/memory/${store_key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'kernel_state',
          content: JSON.stringify({ basin_coords: result.basin_coords, lens_coords: result.lens_coords, harvest_meta: result.harvest_meta, computed_at: new Date().toISOString() }),
          updated: new Date().toISOString()
        })
      });
      result.stored_at = store_key;
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message, stack: err.stack?.slice(0, 500) }, { status: 500 });
  }
}

export const maxDuration = 300;
