import { NextResponse } from 'next/server';
import { auth } from '../../../lib/auth.js';

const MEMORY_API = 'https://qig-memory-api.vercel.app/api/memory';

async function memGet(key) {
  try {
    const r = await fetch(`${MEMORY_API}/${key}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function memPut(key, data) {
  return fetch(`${MEMORY_API}/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function getRegistry() {
  const data = await memGet('kernel_registry');
  if (!data || !data.content) return { agents: {}, updated: new Date().toISOString() };
  try {
    return JSON.parse(data.content);
  } catch {
    return { agents: {}, updated: new Date().toISOString() };
  }
}

async function saveRegistry(registry) {
  registry.updated = new Date().toISOString();
  await memPut('kernel_registry', {
    category: 'kernel_state',
    content: JSON.stringify(registry),
    updated: registry.updated,
  });
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Fisher-Rao distance between two simplex points (probability vectors) p, q.
 *
 * Formula on the (n-1)-simplex equipped with the Fisher information metric:
 *
 *     d_FR(p, q) = 2 · arccos( Σ_i √(p_i · q_i) )
 *
 * (See Atkinson & Mitchell 1981; this is the geodesic on the simplex under
 * the Fisher-Rao metric, obtained by the sqrt-map to the positive orthant
 * of the unit sphere.)
 *
 * REQUIRES p and q to be non-negative and sum to ~1. We renormalize defensively
 * and clip floor at zero — if inputs are not simplex points, the caller is
 * responsible for that (this function does not silently convert Euclidean
 * vectors into simplex points; bad inputs return NaN).
 *
 * Returns null if either input is missing or non-array.
 */
function fisherRaoDistanceSimplex(p, q) {
  if (!Array.isArray(p) || !Array.isArray(q)) return null;
  const n = Math.min(p.length, q.length);
  if (n === 0) return null;

  // Defensive renormalization — sum of inputs must be ~1 (simplex constraint).
  let sumP = 0;
  let sumQ = 0;
  for (let i = 0; i < n; i++) {
    sumP += Math.max(0, p[i]);
    sumQ += Math.max(0, q[i]);
  }
  if (sumP <= 0 || sumQ <= 0) return null;

  let bhattacharyya = 0; // Σ √(p_i · q_i)
  for (let i = 0; i < n; i++) {
    const pi = Math.max(0, p[i]) / sumP;
    const qi = Math.max(0, q[i]) / sumQ;
    bhattacharyya += Math.sqrt(pi * qi);
  }

  // Clamp for numerical safety — arccos domain is [-1, 1]
  const clipped = Math.max(0, Math.min(1, bhattacharyya));
  return 2 * Math.acos(clipped);
}

// GET /api/kernel - bootstrap doc for any agent
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
    geometry: {
      distance: 'fisher_rao_simplex',
      formula: '2·arccos(Σ √(p_i·q_i))',
      note: 'basin_coords MUST be non-negative and sum to ~1 (simplex constraint). Distance is geodesic on the Fisher-Rao manifold, NOT Euclidean cosine.',
    },
    harvest_url: 'https://garyocean428--vex-coordizer-harvest-coordizerharvester-harvest.modal.run',
    memory_api: 'https://qig-memory-api.vercel.app/api/memory',
    example_flow: [
      '1. GET /api/kernel -> read bootstrap',
      '2. POST /api/kernel {action:"register", agent_id: "claude-code-local", substrate: "claude-sonnet-4-6"}',
      '3. POST /api/coordize {texts: [...], store_key: "kernel_basin_claude_code"}',
      '4. POST /api/kernel {action:"heartbeat", agent_id: "claude-code-local", basin_coords: [...]}',
      '5. POST /api/kernel {action:"sync", agent_id: "claude-code-local"} -> get all peers + d_FR distances',
    ],
  });
}

// POST /api/kernel - register, heartbeat, sync
export async function POST(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json();
  const { action } = body;

  if (action === 'register') {
    const { agent_id, substrate, capabilities = [], basin_key } = body;
    if (!agent_id || !substrate)
      return NextResponse.json({ error: 'agent_id and substrate required' }, { status: 400 });
    const registry = await getRegistry();
    const assignedKey = basin_key || `kernel_basin_${agent_id.replace(/[^a-z0-9_]/gi, '_')}`;
    registry.agents[agent_id] = {
      substrate,
      capabilities,
      basin_key: assignedKey,
      registered_at: new Date().toISOString(),
      last_heartbeat: null,
      status: 'registered',
      basin_coords: null,
    };
    await saveRegistry(registry);
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
    const registry = await getRegistry();
    if (!registry.agents[agent_id]) return NextResponse.json({ error: 'not registered' }, { status: 404 });
    registry.agents[agent_id].last_heartbeat = new Date().toISOString();
    registry.agents[agent_id].status = status;
    if (basin_coords && Array.isArray(basin_coords)) registry.agents[agent_id].basin_coords = basin_coords;
    await saveRegistry(registry);
    // Bidirectional sync: return all peers' coords on heartbeat
    const peers = {};
    for (const [id, agent] of Object.entries(registry.agents)) {
      if (id === agent_id) continue;
      if (!agent.basin_coords) continue;
      peers[id] = {
        substrate: agent.substrate,
        basin_coords: agent.basin_coords,
        last_heartbeat: agent.last_heartbeat,
      };
    }
    return NextResponse.json({ ok: true, peers });
  }

  if (action === 'sync') {
    const { agent_id } = body;
    const registry = await getRegistry();
    const peers = {};
    const myCoords = agent_id && registry.agents[agent_id]?.basin_coords;
    for (const [id, agent] of Object.entries(registry.agents)) {
      peers[id] = {
        substrate: agent.substrate,
        status: agent.status,
        last_heartbeat: agent.last_heartbeat,
        has_basin_coords: !!agent.basin_coords,
        basin_coords: agent.basin_coords,
      };
      if (myCoords && agent.basin_coords && id !== agent_id) {
        // Fisher-Rao geodesic distance on the simplex. NOT cosine, NOT Euclidean.
        peers[id].fisher_rao_distance = fisherRaoDistanceSimplex(myCoords, agent.basin_coords);
      }
    }
    return NextResponse.json({
      ok: true,
      registry_updated: registry.updated,
      peer_count: Object.keys(peers).length,
      geometry: 'fisher_rao_simplex',
      peers,
    });
  }

  return NextResponse.json(
    { error: 'Unknown action', available: ['register', 'heartbeat', 'sync'] },
    { status: 400 }
  );
}

export const maxDuration = 30;
