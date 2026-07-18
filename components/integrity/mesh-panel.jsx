import { Network } from 'lucide-react';
import { StatusPill } from './palette';

// Mesh-registry dormancy, DERIVED for display only (days since the entry date;
// results-dir presence proxied by the entry's own result_file pointer). The
// pipeline never mutates mesh_registry.json — any real status change is a
// separate PI-flagged qig-applied PR. Neutral chips; dormancy is not a status
// the registry issued.
export function MeshPanel({ mesh = [] }) {
  if (!mesh.length) return null;
  return (
    <section className="elev-card rounded-2xl border border-border bg-card p-5">
      <header className="flex flex-wrap items-center gap-2">
        <Network className="size-4 text-primary" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">Mesh registry</h2>
        <StatusPill kind="neutral" label={`${mesh.length}`} />
      </header>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Dormancy is derived for display (days since the entry date); the registry is never mutated here.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">ID</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 font-medium">Dormant</th>
              <th className="py-2 font-medium">Results dir</th>
            </tr>
          </thead>
          <tbody>
            {mesh.map((m, i) => (
              <tr key={m.id || i} className="border-b border-border/50">
                <td className="py-2 pr-3 font-mono text-[11px] text-foreground">{m.id}</td>
                <td className="py-2 pr-3">
                  <StatusPill kind="neutral" label={m.status_class} mono />
                </td>
                <td className="py-2 pr-3 text-xs text-muted-foreground">
                  {m.dormant_days != null ? `${m.dormant_days}d` : '—'}
                </td>
                <td className="py-2 text-xs text-muted-foreground">{m.dir_present ? 'present' : 'absent'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
