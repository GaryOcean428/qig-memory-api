// Pure, client-safe helpers shared by the chat task panel and the admin task
// board. No server imports here — just formatting, sorting, grouping, and the
// form→schedule mapping — so both surfaces stay DRY and behave identically.

export const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
export const STATUS_RANK = { running: 0, scheduled: 1, failed: 2, done: 3, cancelled: 4 };
// Canonical display-ordered status list (client-safe, no store import) — drives
// the board's status filter chips and status-based sorting.
export const STATUS_ORDER = Object.keys(STATUS_RANK);

// StatusBadge tones: success | warning | error | neutral.
export function statusTone(status) {
  return (
    { done: 'success', running: 'warning', failed: 'error', scheduled: 'neutral', cancelled: 'neutral' }[status] ||
    'neutral'
  );
}
export function priorityTone(priority) {
  return { high: 'error', medium: 'warning', low: 'neutral' }[priority] || 'neutral';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Client-safe mirror of the store's presets (the store module can't be imported
// into client components — it pulls in Blob/node crypto).
export const INTERVAL_PRESETS = [
  { label: 'Every 15 minutes', ms: 15 * MINUTE },
  { label: 'Hourly', ms: HOUR },
  { label: 'Every 6 hours', ms: 6 * HOUR },
  { label: 'Daily', ms: DAY },
  { label: 'Weekly', ms: 7 * DAY },
];

export function humanInterval(ms) {
  if (!ms) return '';
  if (ms % DAY === 0) {
    const d = ms / DAY;
    if (d === 7) return 'weekly';
    if (d === 1) return 'daily';
    return `every ${d} days`;
  }
  if (ms % HOUR === 0) {
    const h = ms / HOUR;
    return h === 1 ? 'hourly' : `every ${h} hours`;
  }
  const m = Math.round(ms / MINUTE);
  return `every ${m} min`;
}

export function formatDateTime(value) {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(value);
  }
}

// Short relative time ("in 5m", "2h ago") for the next/last run stamps.
export function relativeTime(value) {
  if (!value) return null;
  const diff = Date.parse(value) - Date.now();
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '' : ' ago';
  const prefix = diff >= 0 ? 'in ' : '';
  let unit;
  if (abs < HOUR) unit = `${Math.max(1, Math.round(abs / MINUTE))}m`;
  else if (abs < DAY) unit = `${Math.round(abs / HOUR)}h`;
  else unit = `${Math.round(abs / DAY)}d`;
  return `${prefix}${unit}${suffix}`;
}

// One-line description of a task's schedule for the card.
export function scheduleSummary(task) {
  const s = task.schedule || {};
  if (s.kind === 'once') {
    return s.startAt ? `Once · ${formatDateTime(s.startAt)}` : 'Once · ASAP';
  }
  const interval = humanInterval(s.intervalMs);
  let label = interval.charAt(0).toUpperCase() + interval.slice(1);
  if (s.maxOccurrences) label += ` · ${task.occurrenceCount}/${s.maxOccurrences} runs`;
  if (s.untilDate) label += ` · until ${formatDateTime(s.untilDate)}`;
  return label;
}

export const SORT_OPTIONS = [
  { value: 'priority', label: 'Priority' },
  { value: 'due', label: 'Next run' },
  { value: 'status', label: 'Status' },
  { value: 'recurrence', label: 'Recurring first' },
  { value: 'created', label: 'Newest' },
  { value: 'title', label: 'Title' },
];

export const GROUP_OPTIONS = [
  { value: 'none', label: 'No grouping' },
  { value: 'project', label: 'Project' },
  { value: 'repository', label: 'Repository' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'concept', label: 'Concept' },
  { value: 'recurrence', label: 'Recurrence' },
];

const nextMs = (t) => (t.nextRunAt ? Date.parse(t.nextRunAt) : Number.POSITIVE_INFINITY);

export function sortTasks(tasks, key) {
  const list = [...tasks];
  switch (key) {
    case 'due':
      // Overdue and soonest first; tasks with no next run sink to the bottom.
      return list.sort((a, b) => nextMs(a) - nextMs(b));
    case 'status':
      return list.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9));
    case 'recurrence':
      return list.sort((a, b) => Number(b.isRecurring) - Number(a.isRecurring) || nextMs(a) - nextMs(b));
    case 'created':
      return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    case 'title':
      return list.sort((a, b) => a.title.localeCompare(b.title));
    case 'priority':
    default:
      // Priority, then overdue/soonest within a priority band.
      return list.sort(
        (a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) || nextMs(a) - nextMs(b),
      );
  }
}

// Returns [{ key, label, items }] grouped by the chosen flag. "concept" fans a
// task into each of its concepts so it appears under every relevant heading.
export function groupTasks(tasks, key) {
  if (key === 'none') return [{ key: 'all', label: null, items: tasks }];
  const buckets = new Map();
  const push = (bucketKey, label, task) => {
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, { key: bucketKey, label, items: [] });
    buckets.get(bucketKey).items.push(task);
  };
  for (const task of tasks) {
    if (key === 'concept') {
      const concepts = task.concepts?.length ? task.concepts : ['(no concept)'];
      for (const c of concepts) push(c, c, task);
    } else if (key === 'repository') {
      const repo = task.repository || '(no repository)';
      push(repo, repo, task);
    } else if (key === 'recurrence') {
      const label = task.isRecurring ? 'Recurring' : 'One-off';
      push(label, label, task);
    } else {
      const val = task[key] || `(no ${key})`;
      const label = key === 'priority' || key === 'status' ? val.charAt(0).toUpperCase() + val.slice(1) : val;
      push(val, label, task);
    }
  }
  return [...buckets.values()];
}

// Blank form state for the create/edit dialog.
export function emptyTaskForm() {
  return {
    title: '',
    instruction: '',
    project: 'General',
    repository: '',
    conceptsText: '',
    priority: 'medium',
    scheduleKind: 'once',
    startMode: 'asap', // 'asap' | 'at'
    startAt: '', // datetime-local value
    intervalMs: HOUR,
    capType: 'none', // 'none' | 'count' | 'until'
    maxOccurrences: 5,
    untilDate: '', // datetime-local value
  };
}

// Hydrate the form from an existing task (for editing).
export function taskToForm(task) {
  const s = task.schedule || {};
  const toLocal = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const off = d.getTimezoneOffset() * MINUTE;
    return new Date(d.getTime() - off).toISOString().slice(0, 16);
  };
  return {
    ...emptyTaskForm(),
    title: task.title,
    instruction: task.instruction,
    project: task.project || 'General',
    repository: task.repository || '',
    conceptsText: (task.concepts || []).join(', '),
    priority: task.priority,
    scheduleKind: s.kind || 'once',
    startMode: s.startAt ? 'at' : 'asap',
    startAt: toLocal(s.startAt),
    intervalMs: s.intervalMs || HOUR,
    capType: s.maxOccurrences ? 'count' : s.untilDate ? 'until' : 'none',
    maxOccurrences: s.maxOccurrences || 5,
    untilDate: toLocal(s.untilDate),
  };
}

// Map form state to the API's task input. Throws with a friendly message on
// invalid combinations so the UI can surface it before hitting the server.
export function formToInput(form) {
  const localToIso = (v) => (v ? new Date(v).toISOString() : null);
  const concepts = form.conceptsText
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 12);

  const schedule = {
    kind: form.scheduleKind,
    startAt: form.startMode === 'at' ? localToIso(form.startAt) : null,
    intervalMs: null,
    maxOccurrences: null,
    untilDate: null,
  };

  if (form.scheduleKind === 'recurring') {
    schedule.intervalMs = Number(form.intervalMs);
    if (form.capType === 'count') schedule.maxOccurrences = Math.max(1, Number(form.maxOccurrences) || 1);
    if (form.capType === 'until') schedule.untilDate = localToIso(form.untilDate);
  }

  if (form.scheduleKind === 'once' && form.startMode === 'at' && !schedule.startAt) {
    throw new Error('Pick a date and time for the scheduled run, or choose "As soon as possible".');
  }
  if (form.scheduleKind === 'recurring' && form.capType === 'until' && !schedule.untilDate) {
    throw new Error('Pick an end date, or choose a different stop condition.');
  }

  return {
    title: form.title.trim(),
    instruction: form.instruction.trim(),
    project: form.project.trim() || 'General',
    repository: form.repository.trim() || null,
    concepts,
    priority: form.priority,
    schedule,
  };
}
