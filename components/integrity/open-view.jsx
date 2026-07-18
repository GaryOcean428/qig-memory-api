import { CircleDashed } from 'lucide-react';
import { StatusPill } from './palette';

// OPEN (blue): curated open questions from integrity_registry.open, PLUS a
// mechanically-derived in-flight table (verification-registry entries the sync
// classified planned / in_progress). In-flight rows are neutral/grey — they are
// not a curated status, only "currently running".
export function OpenView({ questions = [], inFlight = [], available = true }) {
  return (
    <section className="elev-card rounded-2xl border border-border bg-card p-5">
      <header className="flex flex-wrap items-center gap-2">
        <CircleDashed className="size-4 text-blue-500" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">Open</h2>
        <StatusPill kind="open" label={`${questions.length} question${questions.length === 1 ? '' : 's'}`} />
        <StatusPill kind="neutral" label={`${inFlight.length} in flight`} />
      </header>

      {!available ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Curated open questions await <code className="font-mono text-xs">experiments/integrity_registry.json</code>{' '}
          (Phase 1). The in-flight table below is derived live and shows now.
        </p>
      ) : questions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No curated open questions.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {questions.map((q, i) => (
            <li key={q.id || i} className="rounded-xl border border-border bg-background/40 p-3">
              <div className="flex items-center gap-2">
                <StatusPill kind="open" />
                <span className="font-mono text-[11px] text-muted-foreground">{q.id}</span>
              </div>
              <p className="mt-1.5 text-sm text-foreground">{q.question}</p>
              {q.certified_observable_test ? (
                <p className="mt-1 text-xs text-muted-foreground">Test: {q.certified_observable_test}</p>
              ) : null}
              {(q.experiments || []).length ? (
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{q.experiments.join(', ')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-4 text-xs font-medium text-foreground">In flight — derived from the verification registry</h3>
      {inFlight.length === 0 ? (
        <p className="mt-1.5 text-sm text-muted-foreground">Nothing planned or in progress.</p>
      ) : (
        <div className="mt-1.5 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">ID</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody>
              {inFlight.map((e, i) => (
                <tr key={e.id || i} className="border-b border-border/50 align-top">
                  <td className="py-2 pr-3 font-mono text-[11px] text-foreground">{e.id}</td>
                  <td className="py-2 pr-3">
                    <StatusPill kind="neutral" label={e.status_class} mono />
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">{e.summary || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
