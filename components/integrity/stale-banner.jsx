import { AlertTriangle, CircleCheck } from 'lucide-react';

// The loud-failure surface. The whole rebuild exists because a hand-rendered
// snapshot rotted silently; this banner makes rot IMPOSSIBLE to miss — it shouts
// on ledger-mismatch (curation behind the live ledger), sync-age (cache older
// than 2× the hourly cron), missing generated sources, and per-source sync
// errors. Amber, never red; the messages carry the signal in text.

const HOUR_MS = 3_600_000;

function fmtAge(ms) {
  if (ms == null) return 'never';
  const h = Math.floor(ms / HOUR_MS);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function StaleBanner({ meta = {}, errors = [] }) {
  const syncedAt = meta.synced_at ? Date.parse(meta.synced_at) : null;
  const ageMs = syncedAt ? Date.now() - syncedAt : null;
  const ageStale = ageMs != null && ageMs > 2 * HOUR_MS;
  const sourceErrors = Array.isArray(errors) ? errors : [];

  const problems = [];
  if (meta.ledger_mismatch) {
    problems.push(
      `Curation built against ${meta.curation_ledger || '?'}, but the live ledger is ${meta.ledger_version || '?'} — CERTIFIED / OPEN may be behind. Re-curate integrity_registry.json.`,
    );
  }
  if (ageStale) problems.push(`Last synced ${fmtAge(ageMs)} ago (the cron is hourly) — the cache may be stale.`);
  if (meta.sources && !meta.sources.integrity_registry) {
    problems.push('Source not yet on qig-verification main: experiments/integrity_registry.json (CERTIFIED + OPEN).');
  }
  if (meta.sources && !meta.sources.completeness) {
    problems.push('Source not yet on qig-verification main: results/COMPLETENESS.json.');
  }
  for (const e of sourceErrors) {
    problems.push(`Sync error [${e.source}]: ${String(e.error || '').slice(0, 160)}`);
  }

  if (problems.length === 0) {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
        <CircleCheck className="size-4 shrink-0 text-purple-500" aria-hidden="true" />
        <span>
          In sync — ledger {meta.ledger_version || '?'}, synced {fmtAge(ageMs)} ago. Generated from the JSON
          registries, so this view cannot silently rot.
        </span>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-300">
          STALE / INCOMPLETE — {problems.length} issue{problems.length === 1 ? '' : 's'}
        </h2>
      </div>
      <ul className="mt-2 space-y-1 text-xs leading-relaxed text-amber-800 dark:text-amber-200/90">
        {problems.map((p, i) => (
          <li key={i}>• {p}</li>
        ))}
      </ul>
    </div>
  );
}
