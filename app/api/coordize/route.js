import { NextResponse } from 'next/server';

const API_KEY = process.env.QIG_API_KEY || '';
const MODAL_COORDIZE_URL = process.env.MODAL_COORDIZE_URL || '';
const KERNEL_API_KEY_MODAL = process.env.KERNEL_API_KEY || '';

function auth(req) {
  if (!API_KEY) return true;
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

/**
 * POST /api/coordize
 * 
 * Genesis kernel endpoint: takes conversation text, calls Modal GPU
 * for harvest + PGA compress, returns 64D basin coordinates.
 * 
 * PGA compress now runs on GPU (Modal). This proxy just orchestrates
 * and optionally stores results. No V-dim fingerprints cross the wire.
 * 
 * Body: { texts: string[], store_key?: string, min_contexts?: number,
 *         target_tokens?: number, lens_dim?: number }
 */
export async function POST(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!MODAL_COORDIZE_URL) return NextResponse.json({ error: 'MODAL_COORDIZE_URL not set' }, { status: 500 });

  const body = await req.json();
  const { texts, store_key, min_contexts = 1, target_tokens = 0, lens_dim = 32 } = body;

  if (!texts || !texts.length) {
    return NextResponse.json({ error: 'texts array required' }, { status: 400 });
  }

  try {
    // Call Modal /coordize — full pipeline on GPU, returns only basin coords
    const modalBody = { texts, min_contexts, target_tokens, lens_dim, batch_size: 16, max_length: 512 };
    if (KERNEL_API_KEY_MODAL) modalBody._api_key = KERNEL_API_KEY_MODAL;

    const modalRes = await fetch(MODAL_COORDIZE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modalBody)
    });

    if (!modalRes.ok) {
      const err = await modalRes.text();
      return NextResponse.json({ error: `Modal coordize failed: ${modalRes.status}`, detail: err }, { status: 502 });
    }

    const result = await modalRes.json();
    if (!result.success) {
      return NextResponse.json({ error: 'Coordize returned failure', detail: result }, { status: 502 });
    }

    // Optionally store basin coords in persistent memory
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
            pga_dim: result.pga_dim,
            computed_at: new Date().toISOString()
          }),
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
