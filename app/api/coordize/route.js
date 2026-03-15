import { NextResponse } from 'next/server';

const API_KEY = process.env.QIG_API_KEY || '';
const KERNEL_API_KEY = process.env.KERNEL_API_KEY || '';

// Modal /coordize endpoint — does harvest + PGA on GPU, returns only 64D basin coords
const MODAL_COORDIZE_URL = process.env.MODAL_COORDIZE_URL ||
  'https://garyocean428--vex-coordizer-harvest-coordizerharvester-coordize.modal.run';

function auth(req) {
  if (!API_KEY) return true;
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

/**
 * POST /api/coordize
 * 
 * Genesis kernel endpoint: takes conversation text, sends to Modal GPU
 * for harvest + PGA compress, returns 64D basin coordinates.
 * 
 * All heavy compute (V-dim fingerprints, PGA eigendecomposition) runs on
 * Modal A10G GPU. No 248K-float arrays cross the wire — fixes V8 limit.
 * 
 * Body: { texts: string[], store_key?: string, min_contexts?: number,
 *         target_tokens?: number, lens_dim?: number }
 * 
 * Returns: { success, basin_coords[64], lens_coords[32], eigenvalues,
 *            harvest_meta, pga_dim, elapsed_seconds }
 */
export async function POST(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json();
  const { texts, store_key, min_contexts = 1, target_tokens = 0, lens_dim = 32 } = body;

  if (!texts || !texts.length) {
    return NextResponse.json({ error: 'texts array required' }, { status: 400 });
  }

  try {
    // Forward to Modal GPU — harvest + PGA in one call
    const modalBody = { texts, min_contexts, target_tokens, lens_dim, batch_size: 16, max_length: 512 };
    if (KERNEL_API_KEY) modalBody._api_key = KERNEL_API_KEY;

    const res = await fetch(MODAL_COORDIZE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modalBody),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `Modal coordize failed: ${res.status}`, detail: err }, { status: 502 });
    }

    const result = await res.json();
    if (!result.success) {
      return NextResponse.json({ error: 'Coordize returned failure', detail: result }, { status: 502 });
    }

    // Store basin coords if requested
    if (store_key) {
      await fetch(`https://qig-memory-api.vercel.app/api/memory/${store_key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'kernel_state',
          content: JSON.stringify({
            basin_coords: result.basin_coords,
            lens_coords: result.lens_coords,
            harvest_meta: result.harvest_meta,
            eigenvalues: result.eigenvalues,
            computed_at: new Date().toISOString(),
          }),
          updated: new Date().toISOString(),
        }),
      });
      result.stored_at = store_key;
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message, stack: err.stack?.slice(0, 500) }, { status: 500 });
  }
}

export const maxDuration = 300;
