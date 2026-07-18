import { ListChecks } from 'lucide-react';

// The completeness panel surfaces experiment-numbering gap classes at a glance —
// what ran (indexed), what was filed elsewhere / subsumed / pre-registered /
// narrative-only, and which numbers were NEVER assigned (the visible holes in
// the id space). All classification is computed Python-side; this only renders
// the committed COMPLETENESS.json. Neutral/grey chips — this is a census, not a
// certified/open/retired status, so it does not use the purple/blue/amber palette.

const GAP_ORDER = ['indexed', 'filed_elsewhere', 'subsumed', 'pre_registered', 'narrative_only', 'never_assigned'];
const GAP_LABEL = {
  indexed: 'indexed',
  filed_elsewhere: 'filed elsewhere',
  subsumed: 'subsumed',
  pre_registered: 'pre-registered',
  narrative_only: 'narrative-only',
  never_assigned: 'never assigned',
};

export function CompletenessPanel({ completeness = null }) {
  const neverAssigned = (completeness?.numbers || []).filter((n) => n.class === 'never_assigned').map((n) => n.n);
  const dangling = completeness?.dangling_pointers || [];

  return (
    <section className="elev-card rounded-2xl border border-border bg-card p-5">
      <header className="flex items-center gap-2">
        <ListChecks className="size-4 text-primary" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">Completeness</h2>
      </header>
      {!completeness ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Awaiting <code className="font-mono text-xs">results/COMPLETENESS.json</code> on qig-verification main
          (Phase 1). This panel surfaces the experiment-numbering gap classes — what ran, what the canon absorbed, and
          which numbers were never assigned.
        </p>
      ) : (
        <>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Id space {completeness.id_space?.min ?? '?'}–{completeness.id_space?.max ?? '?'} ·{' '}
            {completeness.registry_entries ?? '?'} registry entries.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {GAP_ORDER.map((g) =>
              completeness.summary?.[g] != null ? (
                <span
                  key={g}
                  className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  {GAP_LABEL[g]} {completeness.summary[g]}
                </span>
              ) : null,
            )}
          </div>

          {neverAssigned.length ? (
            <div className="mt-3">
              <h3 className="text-xs font-medium text-foreground">Never assigned ({neverAssigned.length})</h3>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {neverAssigned.map((n) => (
                  <span key={n} className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {n}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {dangling.length ? (
            <div className="mt-3">
              <h3 className="text-xs font-medium text-foreground">Dangling pointers ({dangling.length})</h3>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {dangling.slice(0, 24).map((d, i) => (
                  <span
                    key={`${d.id}-${i}`}
                    title={d.path || ''}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {d.id}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
