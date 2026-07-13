import { NextResponse } from 'next/server';
import { auth, unauthorizedReason } from '../../../lib/auth.js';
import {
  getKernelAgent,
  putKernelAgent,
  listKernelAgents,
  syncKernel,
} from '../../../lib/memory-store.js';

// The kernel route talks to storage through the shared memory-store lib
// DIRECTLY — no HTTP round-trip back to the public /api/memory URL. This
// removes CDN-propagation latency from every heartbeat and means enabling
// QIG_API_KEY never 401s the mesh's own writes.

// GET /api/kernel — bootstrap doc for any agent
export async function GET() {
  return NextResponse.json({
    protocol: 'QIG Kernel Mesh v0.2',
    description: 'Connect any agent to the QIG kernel mesh.',
    endpoints: {
      register: {
        method: 'POST',
        body: { action: 'register', agent_id: 'string', substrate: 'string', capabilities: ['string'] },
      },
      heartbeat: {
        method: 'POST',
        body: { action: 'heartbeat', agent_id: 'string', basin_coords: '[64 simplex]', status: 'string' },
      },
      sync: { method: 'POST', body: { action: 'sync', agent_id: 'string' } },
      coordize: { method: 'POST', url: '/api/coordize' },
    },
    auth: {
      scheme: 'bearer',
      header: 'Authorization: Bearer <QIG_API_KEY>',
      note: 'All POST actions require the bearer token. GET (this doc) is public.',
    },
    geometry: {
      distance: 'fisher_rao_simplex',
      formula: '2·arccos(Σ √(p_i·q_i))',
      type_contract: 'simplex_only',
      note: 'basin_coords MUST be non-negative and sum to ~1 (simplex constraint). Distance is geodesic on the Fisher-Rao manifold, NOT Euclidean cosine. PGA tangent-space representations are a different type and do not flow through this endpoint — convert to simplex at the source.',
    },
    harvest_url: 'https://garyocean428--vex-coordizer-harvest-coordizerharvester-harvest.modal.run',
    memory_api: 'https://qig-memory-api.vercel.app/api/memory',
    example_flow: [
      '1. GET /api/kernel -> read bootstrap',
      '2. POST /api/kernel {action:"register", agent_id: "my-agent-local", substrate: "<your-model-id>"}',
      '3. POST /api/coordize {texts: [...], store_key: "kernel_basin_my_agent"}',
      '4. POST /api/kernel {action:"heartbeat", agent_id: "my-agent-local", basin_coords: [...]}',
      '5. POST /api/kernel {action:"sync", agent_id: "my-agent-local"} -> get all peers + d_FR distances',
    ],
    note: 'substrate is a free-form model identifier (e.g. "grok-4.5", "claude-opus-4", "gpt-5"). Use whatever names your agent runtime.',
  });
}

// POST /api/kernel — register, heartbeat, sync
export async function POST(req) {
  if (!auth(req))
    return NextResponse.json({ error: 'unauthorized', reason: unauthorizedReason() }, { status: 401 });
  const body = await req.json();
  const { action } = body;

  if (action === 'register') {
    const { agent_id, substrate, capabilities = [], basin_key } = body;
    if (!agent_id || !substrate)
      return NextResponse.json({ error: 'agent_id and substrate required' }, { status: 400 });
    const assignedKey = basin_key || `kernel_basin_${agent_id.replace(/[^a-z0-9_]/gi, '_')}`;
    await putKernelAgent(agent_id, {
      substrate,
      capabilities,
      basin_key: assignedKey,
      registered_at: new Date().toISOString(),
      last_heartbeat: null,
      status: 'registered',
      basin_coords: null,
    });
    return NextResponse.json({
      ok: true,
      agent_id,
      basin_key: assignedKey,
      message: `Registered. Use basin_key "${assignedKey}" for coordize store_key.`,
    });
  }

  if (action === 'heartbeat') {
    const { agent_id, basin_coords, status = 'active' } = body;
    if (!agent_id) return NextResponse.json({ error: 'agent_id required' }, { status: 400 });
    // Per-agent read-modify-write: only this agent's own key is touched, so
    // concurrent heartbeats from different agents can never clobber each other.
    const existing = await getKernelAgent(agent_id);
    if (!existing) return NextResponse.json({ error: 'not registered' }, { status: 404 });
    existing.last_heartbeat = new Date().toISOString();
    existing.status = status;
    if (basin_coords && Array.isArray(basin_coords)) existing.basin_coords = basin_coords;
    await putKernelAgent(agent_id, existing);

    // Bidirectional sync: return peers' coords on heartbeat.
    const { peers } = await syncKernel(agent_id);
    const trimmed = {};
    for (const [id, p] of Object.entries(peers)) {
      if (!p.basin_coords) continue;
      trimmed[id] = {
        substrate: p.substrate,
        basin_coords: p.basin_coords,
        last_heartbeat: p.last_heartbeat,
        fisher_rao_distance: p.fisher_rao_distance,
      };
    }
    return NextResponse.json({ ok: true, peers: trimmed });
  }

  if (action === 'sync') {
    const { agent_id } = body;
    const result = await syncKernel(agent_id);
    return NextResponse.json({ ok: true, ...result });
  }

  return NextResponse.json(
    { error: 'Unknown action', available: ['register', 'heartbeat', 'sync'] },
    { status: 400 }
  );
}

export const maxDuration = 30;
