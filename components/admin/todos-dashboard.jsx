import { StatusBadge } from '@bsuite/ui';
import { AlertTriangle, CalendarClock, FlaskConical, ListTodo } from 'lucide-react';

// Read-only "work board" that pulls the scattered work sources into one
// top-of-page view: tasks needing attention now, scheduled tasks, planned
// experiments across the registries, and unacknowledged inbox mail. Everything
// is server-seeded from the same data the admin page already loads (plus one
// inbox fetch), so it renders instantly and never calls out to GitHub — the same
// property the frozen-facts dashboard has.
//
// StatusBadge tones use the @bsuite/ui vocabulary (neutral | info | success |
// warning | destructive). NOT 'error' — that is not a defined tone and renders
// unstyled (the latent bug lib/task-ui.js's statusTone still carries).

const PRIORITY_TONE = { high: 'destructive', medium: 'warning', low: 'neutral' };

function relTime(iso) {
  if (!iso) return null;
  const diff = Date.parse(iso) - Date.now();
  if (Number.isNaN(diff)) return null;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const abs = Math.abs(diff);
  let unit;
  if (abs < HOUR) unit = `${Math.max(1, Math.round(abs / MIN))}m`;
  else if (abs < DAY) unit = `${Math.round(abs / HOUR)}h`;
  else unit = `${Math.round(abs / DAY)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

function Pill({ children, title }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full border border-border bg-background/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
    >
      {children}
    </span>
  );
}

function Section({ icon: Icon, title, count, children }) {
  return (
    <div className="mt-4">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Icon className="size-3.5 text-primary" aria-hidden="true" />
        {title}
        {count != null ? <span className="text-muted-foreground">· {count}</span> : null}
      </h3>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

export function TodosDashboard({ tasks = [], doctrine = null, inbox = [] }) {
  const active = tasks.filter((t) => t.status === 'scheduled' || t.status === 'running');
  const overdue = tasks.filter((t) => t.overdue);
  const dueSoon = tasks.filter((t) => t.dueSoon && !t.overdue);
  const needsActionInbox = inbox || [];

  // Planned experiments across the registries: per-registry counts from
  // by_status, plus the actual ids that postdate the ledger (the drift sample)
  // so there are real handles, not just a number.
  const registries = doctrine?.registries || {};
  const plannedByRegistry = Object.entries(registries)
    .map(([id, r]) => ({ id, planned: r.by_status?.planned || 0 }))
    .filter((r) => r.planned > 0);
  const plannedTotal = plannedByRegistry.reduce((n, r) => n + r.planned, 0);
  const driftPlanned = [];
  for (const f of doctrine?.drift?.findings || []) {
    for (const s of f.sample || []) {
      if (s.status_class === 'planned') driftPlanned.push(s);
    }
  }

  const needNowCount = overdue.length + dueSoon.length + needsActionInbox.length;

  return (
    <section className="elev-card mb-6 rounded-2xl border border-border bg-card p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ListTodo className="size-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Work board</h2>
        </div>
        <StatusBadge tone={needNowCount ? 'warning' : 'success'}>
          {needNowCount ? `${needNowCount} need${needNowCount === 1 ? 's' : ''} attention` : 'nothing due'}
        </StatusBadge>
      </header>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        One view of what needs doing — scheduled tasks, planned experiments across the registries, and unacknowledged
        inbox mail. Seeded from the same data the panels below show, so it never fetches GitHub.
      </p>

      {/* Needs action now — the top-of-board "do this" list */}
      <Section icon={AlertTriangle} title="Needs action now" count={needNowCount}>
        {needNowCount === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing overdue, due within the hour, or waiting in the inbox.</p>
        ) : (
          <ul className="space-y-2">
            {overdue.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background/40 p-3"
              >
                <span className="min-w-0 truncate text-sm text-foreground">{t.title}</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <StatusBadge tone="destructive">overdue {relTime(t.nextRunAt)}</StatusBadge>
                  <StatusBadge tone={PRIORITY_TONE[t.priority] || 'neutral'}>{t.priority}</StatusBadge>
                </div>
              </li>
            ))}
            {dueSoon.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background/40 p-3"
              >
                <span className="min-w-0 truncate text-sm text-foreground">{t.title}</span>
                <StatusBadge tone="warning">due {relTime(t.nextRunAt)}</StatusBadge>
              </li>
            ))}
            {needsActionInbox.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background/40 p-3"
              >
                <span className="min-w-0 truncate text-sm text-foreground">
                  <span className="text-muted-foreground">
                    {m.from} → {m.to}:
                  </span>{' '}
                  {m.subject || m.type}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Pill>{m.type}</Pill>
                  <StatusBadge tone={m.status === 'unread' ? 'info' : 'neutral'}>{m.status}</StatusBadge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Scheduled tasks — complements the full task board below */}
      <Section icon={CalendarClock} title="Scheduled tasks" count={active.length}>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active scheduled tasks. Create one in the task board below.</p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {active.slice(0, 8).map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-1">
                  <span className="min-w-0 truncate text-sm text-foreground">{t.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{relTime(t.nextRunAt) || '—'}</span>
                </li>
              ))}
            </ul>
            {active.length > 8 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">+{active.length - 8} more in the task board below.</p>
            ) : null}
          </>
        )}
      </Section>

      {/* Planned experiments — pulls the registries into the work view */}
      <Section icon={FlaskConical} title="Planned experiments" count={plannedTotal || null}>
        {!doctrine ? (
          <p className="text-sm text-muted-foreground">Canon not synced — planned counts unavailable.</p>
        ) : plannedTotal === 0 ? (
          <p className="text-sm text-muted-foreground">No planned experiments across the registries.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {plannedByRegistry.map((r) => (
                <Pill key={r.id} title={`${r.planned} planned in ${r.id}`}>
                  {r.id} · {r.planned}
                </Pill>
              ))}
            </div>
            {driftPlanned.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {driftPlanned.slice(0, 16).map((s) => (
                  <Pill key={s.id} title={s.summary || ''}>
                    {s.id}
                  </Pill>
                ))}
              </div>
            ) : null}
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Counts are per registry; the pills are the specific planned entries that postdate the current ledger. Full
              per-experiment detail lands when the doctrine sync persists the planned list.
            </p>
          </>
        )}
      </Section>
    </section>
  );
}
