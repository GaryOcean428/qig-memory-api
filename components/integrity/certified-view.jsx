import { BadgeCheck } from 'lucide-react';
import { StatusPill } from './palette';

// CERTIFIED (purple). Verbatim from the curated integrity_registry.certified —
// no derivation. Every row carries the CERTIFIED text pill, not colour alone.
export function CertifiedView({ certified = [], available = true }) {
  return (
    <section className="elev-card rounded-2xl border border-border bg-card p-5">
      <header className="flex flex-wrap items-center gap-2">
        <BadgeCheck className="size-4 text-purple-500" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">Certified</h2>
        <StatusPill kind="certified" label={`${certified.length}`} />
      </header>
      {!available ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Awaiting <code className="font-mono text-xs">experiments/integrity_registry.json</code> on
          qig-verification main (Phase 1). Certified claims are curated there, guarded by a pytest freshness gate.
        </p>
      ) : certified.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No certified claims in the curation.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Claim</th>
                <th className="py-2 pr-3 font-medium">Value</th>
                <th className="py-2 pr-3 font-medium">Experiments</th>
                <th className="py-2 font-medium">Survived</th>
              </tr>
            </thead>
            <tbody>
              {certified.map((c, i) => (
                <tr key={c.id || i} className="border-b border-border/50 align-top">
                  <td className="py-2 pr-3">
                    <div className="flex items-start gap-2">
                      <StatusPill kind="certified" className="mt-0.5" />
                      <span className="text-foreground">{c.claim || c.id}</span>
                    </div>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-foreground">{c.value || '—'}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-muted-foreground">
                    {(c.experiments || []).join(', ') || '—'}
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">{c.check_survived || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
