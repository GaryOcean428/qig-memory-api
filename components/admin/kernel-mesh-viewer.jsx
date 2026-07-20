'use client';

import { useState, useTransition } from 'react';
import { Button, StatusBadge, EmptyState, LoadingSpinner } from '@bsuite/ui';
import { Network, Radio } from 'lucide-react';
import { loadKernelMeshAction } from '@/app/admin/actions';

const STATUS_TONE = { active: 'success', online: 'success', idle: 'warning', offline: 'neutral' };

function formatDate(value) {
  if (!value) return '—';
  try {
    // Deterministic UTC — identical on server + client, so no hydration mismatch (React #418).
    return `${new Date(value).toLocaleString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} UTC`;
  } catch {
    return String(value);
  }
}

// Color-scale a Fisher-Rao distance (0 = identical basin, ~π = maximally apart).
function distanceTone(d) {
  if (d == null) return 'neutral';
  if (d < 0.5) return 'success';
  if (d < 1.5) return 'info';
  return 'warning';
}

export function KernelMeshViewer({ initialAgentIds, initialMesh }) {
  const [agentIds] = useState(initialAgentIds);
  const [selected, setSelected] = useState(initialAgentIds[0] || null);
  const [mesh, setMesh] = useState(initialMesh);
  const [isLoading, startLoad] = useTransition();

  function selectAgent(id) {
    if (id === selected) return;
    setSelected(id);
    startLoad(async () => {
      const res = await loadKernelMeshAction(id);
      setMesh(res);
    });
  }

  const peers = mesh?.peers ? Object.entries(mesh.peers) : [];

  return (
    <section id="admin-kernel" className="mt-16 scroll-mt-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Kernel mesh
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {agentIds.length} agent{agentIds.length === 1 ? '' : 's'} registered. Distances use the
            Fisher-Rao geodesic on the simplex.
          </p>
        </div>
        <StatusBadge tone="info">{mesh?.geometry || 'fisher_rao_simplex'}</StatusBadge>
      </div>

      {agentIds.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Network className="h-6 w-6" />}
            title="No agents on the mesh"
            description="Agents appear here once they register via /api/kernel."
          />
        </div>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[16rem_1fr]">
          {/* Agent selector */}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Relative to
            </p>
            <ul className="flex flex-col gap-1.5">
              {agentIds.map((id) => {
                const active = id === selected;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => selectAgent(id)}
                      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        active
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-card text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      <Radio
                        className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`}
                      />
                      <span className="min-w-0 truncate font-mono">{id}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Peer distance table */}
          <div className="min-w-0 rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-sm font-medium text-foreground">
                Peers of <code className="font-mono text-primary">{selected}</code>
              </p>
              {isLoading && <LoadingSpinner size="sm" />}
            </div>
            {peers.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Agent</th>
                      <th className="px-4 py-2.5 font-medium">Substrate</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5 font-medium">d(Fisher-Rao)</th>
                      <th className="px-4 py-2.5 font-medium">Heartbeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {peers.map(([id, p]) => (
                      <tr key={id} className="border-b border-border/60 last:border-0">
                        <td className="px-4 py-3">
                          <code className="font-mono text-foreground">{id}</code>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{p.substrate || '—'}</td>
                        <td className="px-4 py-3">
                          <StatusBadge tone={STATUS_TONE[p.status] || 'neutral'}>
                            {p.status || 'unknown'}
                          </StatusBadge>
                        </td>
                        <td className="px-4 py-3">
                          {typeof p.fisher_rao_distance === 'number' ? (
                            <StatusBadge tone={distanceTone(p.fisher_rao_distance)}>
                              {p.fisher_rao_distance.toFixed(4)}
                            </StatusBadge>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {p.has_basin_coords ? 'n/a' : 'no coords'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {formatDate(p.last_heartbeat)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No peers to compare against.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
