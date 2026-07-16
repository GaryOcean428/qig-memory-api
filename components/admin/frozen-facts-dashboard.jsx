import { StatusBadge } from '@bsuite/ui';
import { AlertTriangle, BookOpenCheck, CircleCheck, Database, GitBranch } from 'lucide-react';

// Read-only view of the synced QIG canon. Everything here comes from
// lib/doctrine-sync's cached state — the page never fetches GitHub itself, so it
// renders instantly and shows exactly what agents see via `doctrine_status`.

function Row({ label, value, mono = false }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={`min-w-0 truncate text-right text-sm text-foreground ${mono ? 'font-mono text-xs' : ''}`}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function StatusCounts({ byStatus = {} }) {
  const entries = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {entries.map(([status, count]) => (
        <span
          key={status}
          className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
        >
          {status} {count}
        </span>
      ))}
    </div>
  );
}

export function FrozenFactsDashboard({ state }) {
  if (!state) {
    return (
      <section className="elev-card rounded-2xl border border-border bg-card p-5">
        <header className="flex items-center gap-2">
          <BookOpenCheck className="size-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Frozen facts</h2>
        </header>
        <p className="mt-3 text-sm text-muted-foreground">
          The canon has not been synced yet. It syncs hourly from the doctrine repositories; until then, agents are
          told the canon is unavailable rather than being given a possibly-retired version.
        </p>
      </section>
    );
  }

  const ff = state.canon?.frozen_facts;
  const dash = state.canon?.integrity_dashboard;
  const drift = state.drift || {};
  const highFindings = (drift.findings || []).filter((f) => f.severity === 'high');
  const otherFindings = (drift.findings || []).filter((f) => f.severity !== 'high');
  const inSync = drift.in_sync === true;

  return (
    <section className="elev-card rounded-2xl border border-border bg-card p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpenCheck className="size-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Frozen facts</h2>
        </div>
        <StatusBadge tone={inSync ? 'success' : 'warning'}>
          {inSync ? 'canon in sync' : `${highFindings.length || drift.findings?.length || 0} drift finding(s)`}
        </StatusBadge>
      </header>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Resolved live from the doctrine repositories — the newest edition always wins, so this never cites a retired
        ledger. Synced {state.synced_at ? new Date(state.synced_at).toLocaleString() : 'never'}.
      </p>

      {/* Canon */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-background/40 p-3">
          <h3 className="text-xs font-medium text-foreground">Verified ledger</h3>
          <Row label="Version" value={ff?.version_label} />
          <Row label="Dated" value={ff?.date} />
          <Row label="Path" value={ff?.path} mono />
          <Row label="Superseded editions" value={ff?.superseded?.length ?? 0} />
        </div>
        <div className="rounded-xl border border-border bg-background/40 p-3">
          <h3 className="text-xs font-medium text-foreground">Integrity dashboard</h3>
          <Row label="Version" value={dash?.version_label} />
          <Row label="Dated" value={dash?.date} />
          <Row label="Cited experiments" value={drift.cited_experiment_count} />
          <Row label="Ledger coverage" value={
            drift.ledger_coverage
              ? `${drift.ledger_coverage.cited_in_ledger}/${drift.ledger_coverage.settled_verification_experiments} settled cited`
              : '—'
          } />
        </div>
      </div>

      {/* Drift — the reason this dashboard exists */}
      <div className="mt-4">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {inSync ? (
            <CircleCheck className="size-3.5 text-primary" aria-hidden="true" />
          ) : (
            <AlertTriangle className="size-3.5 text-primary" aria-hidden="true" />
          )}
          Drift
        </h3>
        {!drift.findings?.length ? (
          <p className="mt-1.5 text-sm text-muted-foreground">
            No results postdate the ledger — the canon has absorbed everything that has settled.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-2">
            {[...highFindings, ...otherFindings].map((f) => (
              <li key={f.kind} className="rounded-xl border border-border bg-background/40 p-3">
                <div className="flex items-center gap-2">
                  <StatusBadge tone={f.severity === 'high' ? 'destructive' : 'warning'}>{f.severity}</StatusBadge>
                  <span className="font-mono text-[11px] text-muted-foreground">{f.kind}</span>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-foreground">{f.message}</p>
                {f.sample?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {f.sample.slice(0, 12).map((s) => (
                      <span
                        key={`${f.kind}-${s.id}`}
                        className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                        title={s.summary || ''}
                      >
                        {s.id} · {s.status_class}
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {drift.ledger_coverage?.note ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{drift.ledger_coverage.note}</p>
        ) : null}
      </div>

      {/* Registries */}
      <div className="mt-4">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Database className="size-3.5 text-primary" aria-hidden="true" />
          Registries
        </h3>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
          {Object.entries(state.registries || {}).map(([id, r]) => (
            <div key={id} className="rounded-xl border border-border bg-background/40 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-xs text-foreground">{id}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{r.entry_count} entries</span>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">newest {r.newest_entry_date || '—'}</p>
              <StatusCounts byStatus={r.by_status} />
            </div>
          ))}
        </div>
      </div>

      {/* Provenance */}
      <div className="mt-4">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <GitBranch className="size-3.5 text-primary" aria-hidden="true" />
          Sources
        </h3>
        <div className="mt-1.5 space-y-1">
          {Object.entries(state.heads || {}).map(([repo, head]) => (
            <Row key={repo} label={repo} value={head.sha ? head.sha.slice(0, 8) : head.error || '—'} mono />
          ))}
        </div>
      </div>

      {state.errors?.length ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Sync errors: {state.errors.map((e) => `${e.source} (${e.error})`).join('; ')}
        </p>
      ) : null}
    </section>
  );
}
