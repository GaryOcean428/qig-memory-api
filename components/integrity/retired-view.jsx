import { Archive } from 'lucide-react';
import { StatusPill } from './palette';

// RETIRED (amber). Fully mechanical from retired_registry.json — verbatim, never
// reclassed. "Never reassert these" is the whole point of the section.
export function RetiredView({ retired = [] }) {
  return (
    <section className="elev-card rounded-2xl border border-border bg-card p-5">
      <header className="flex flex-wrap items-center gap-2">
        <Archive className="size-4 text-amber-500" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">Retired</h2>
        <StatusPill kind="retired" label={`${retired.length}`} />
      </header>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Never reassert these. Mechanical from <code className="font-mono text-[11px]">retired_registry.json</code>.
      </p>
      {retired.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No retired claims.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Claim</th>
                <th className="py-2 pr-3 font-medium">Reason</th>
                <th className="py-2 font-medium">Superseded by</th>
              </tr>
            </thead>
            <tbody>
              {retired.map((r, i) => (
                <tr key={r.id || i} className="border-b border-border/50 align-top">
                  <td className="py-2 pr-3">
                    <div className="flex items-start gap-2">
                      <StatusPill kind="retired" className="mt-0.5" />
                      <span className="text-foreground">{r.claim || r.id}</span>
                    </div>
                    {r.status ? (
                      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{r.status}</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">{r.reason || '—'}</td>
                  <td className="py-2 font-mono text-[11px] text-muted-foreground">{r.superseded_by || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
