import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  deletePrivate,
  listPrivate,
  readPrivateJson,
  writePrivateJson,
} from './private-blob';

// Scheduled agent tasks. Each task is one private blob at tasks/<id>.json so the
// cron runner, the REST API, the agent tools, and the session-gated admin/chat
// UIs all share a single source of truth (mirrors the inbox/reviewer stores).
//
// A task carries WHAT the agent should do (instruction) plus organizational
// metadata (project, repository, concepts) and a schedule. The runner executes
// due tasks autonomously; see lib/task-runner.js.

const TASK_PREFIX = 'tasks/';
const MAX_RUN_HISTORY = 20;

export const TASK_STATUSES = ['scheduled', 'running', 'done', 'failed', 'cancelled'];
export const TASK_PRIORITIES = ['high', 'medium', 'low'];
export const SCHEDULE_KINDS = ['once', 'recurring'];

// Interval presets (ms) offered by the UI for recurring tasks. Stored value is
// the raw millisecond interval, so custom intervals remain valid.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const INTERVAL_PRESETS = [
  { label: 'Every 15 minutes', ms: 15 * MINUTE },
  { label: 'Hourly', ms: HOUR },
  { label: 'Every 6 hours', ms: 6 * HOUR },
  { label: 'Daily', ms: DAY },
  { label: 'Weekly', ms: 7 * DAY },
];
const MIN_INTERVAL_MS = 5 * MINUTE; // never schedule tighter than the cron tick

const scheduleSchema = z
  .object({
    kind: z.enum(SCHEDULE_KINDS),
    // When the first (or only) run should happen. Null = "as soon as possible".
    startAt: z.string().datetime().nullable().default(null),
    // Recurring cadence in milliseconds.
    intervalMs: z.number().int().min(MIN_INTERVAL_MS).nullable().default(null),
    // Optional caps for recurring tasks: stop after N runs and/or after a date.
    maxOccurrences: z.number().int().min(1).max(10_000).nullable().default(null),
    untilDate: z.string().datetime().nullable().default(null),
  })
  .refine((s) => s.kind !== 'recurring' || s.intervalMs != null, {
    message: 'recurring schedules require intervalMs',
    path: ['intervalMs'],
  });

export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(8_000),
  project: z.string().trim().max(120).default('General'),
  repository: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'Use the "owner/name" form')
    .max(140)
    .nullable()
    .optional()
    .default(null),
  concepts: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  schedule: scheduleSchema,
});

function path(id) {
  return `${TASK_PREFIX}${id}.json`;
}

// The next moment a task should run given its schedule and how many times it has
// already run. Returns an ISO string, or null when the task is complete.
export function computeNextRun(schedule, { occurrenceCount = 0, from = Date.now() } = {}) {
  const start = schedule.startAt ? Date.parse(schedule.startAt) : from;
  if (schedule.kind === 'once') {
    return occurrenceCount >= 1 ? null : new Date(Math.max(start, from)).toISOString();
  }
  // recurring
  if (schedule.maxOccurrences != null && occurrenceCount >= schedule.maxOccurrences) return null;
  const candidate = occurrenceCount === 0 ? Math.max(start, from) : from + schedule.intervalMs;
  if (schedule.untilDate && candidate > Date.parse(schedule.untilDate)) return null;
  return new Date(candidate).toISOString();
}

// Attach derived flags the UI sorts/groups on, so the client never re-derives
// scheduling truth. `overdue`/`dueSoon` are relative to now.
export function withDerived(task, now = Date.now()) {
  const next = task.nextRunAt ? Date.parse(task.nextRunAt) : null;
  const active = task.status === 'scheduled' || task.status === 'running';
  return {
    ...task,
    isRecurring: task.schedule?.kind === 'recurring',
    overdue: active && next != null && next < now,
    dueSoon: active && next != null && next >= now && next - now < HOUR,
  };
}

function buildTask(input, { createdBy }) {
  const parsed = taskInputSchema.parse(input);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    ...parsed,
    status: 'scheduled',
    occurrenceCount: 0,
    nextRunAt: computeNextRun(parsed.schedule, { occurrenceCount: 0 }),
    lastRunAt: null,
    lastRunStatus: null,
    runs: [],
    createdBy: createdBy || null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function createTask(input, { createdBy } = {}) {
  const task = buildTask(input, { createdBy });
  await writePrivateJson(path(task.id), task, { allowOverwrite: false });
  return task;
}

export async function getTask(id) {
  const found = await readPrivateJson(path(id));
  return found?.data ?? null;
}

export async function listTasks() {
  const page = await listPrivate({ prefix: TASK_PREFIX, limit: 1000 });
  const tasks = [];
  for (const blob of page.blobs) {
    const item = await readPrivateJson(blob.pathname);
    if (item?.data) tasks.push(item.data);
  }
  // Newest first as a stable default; the UI re-sorts by the chosen flag.
  tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return tasks;
}

// A mutator returns this to reject the update outright, making mutateTask
// resolve to null. This is distinct from returning a falsy value, which means
// "no change needed" and leaves the record untouched.
const ABORT = Symbol('mutateTask.abort');

// Optimistic-concurrency update: read, apply patch, write with ifMatch. Retries
// on a lost race (the cron runner and the UI can touch the same task).
async function mutateTask(id, mutator) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const found = await readPrivateJson(path(id));
    if (!found?.data) return null;
    const next = mutator({ ...found.data });
    if (next === ABORT) return null;
    if (!next) return found.data;
    next.updatedAt = new Date().toISOString();
    try {
      await writePrivateJson(path(id), next, { allowOverwrite: true, ifMatch: found.blob.etag });
      return next;
    } catch (error) {
      if (error?.name !== 'BlobPreconditionFailedError' || attempt === 3) throw error;
    }
  }
  return null;
}

// Editable fields for the UI/agent. Schedule edits recompute nextRunAt so a
// re-enabled or rescheduled task becomes due correctly.
const patchSchema = taskInputSchema.partial().extend({
  status: z.enum(TASK_STATUSES).optional(),
});

export async function updateTask(id, patch) {
  const clean = patchSchema.parse(patch);
  return mutateTask(id, (task) => {
    const next = { ...task, ...clean };
    if (clean.schedule) {
      next.schedule = scheduleSchema.parse(clean.schedule);
      next.nextRunAt = computeNextRun(next.schedule, { occurrenceCount: next.occurrenceCount });
      if (next.nextRunAt && (next.status === 'done' || next.status === 'cancelled')) {
        next.status = 'scheduled';
      }
    }
    // Re-activating a finished task without a schedule change: recompute from now.
    if (clean.status === 'scheduled' && !clean.schedule) {
      next.nextRunAt = computeNextRun(next.schedule, { occurrenceCount: next.occurrenceCount });
    }
    if (clean.status === 'cancelled') next.nextRunAt = null;
    return next;
  });
}

export async function deleteTask(id) {
  await deletePrivate(path(id));
  return { deleted: true, id };
}

// Tasks whose nextRunAt is in the past and are still active. Ordered by priority
// then due time so the runner drains the most important, most overdue first.
export async function listDueTasks(now = Date.now()) {
  const tasks = await listTasks();
  const rank = { high: 0, medium: 1, low: 2 };
  return tasks
    .filter(
      (t) =>
        t.status === 'scheduled' &&
        t.nextRunAt != null &&
        Date.parse(t.nextRunAt) <= now,
    )
    .sort(
      (a, b) =>
        (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) ||
        Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt),
    );
}

// Atomically claim a task for execution so overlapping cron ticks can't double-run
// it. Returns the claimed task, or null if another worker got it first.
export async function claimTask(id) {
  return mutateTask(id, (task) => {
    if (task.status !== 'scheduled') return ABORT; // already claimed/finished
    task.status = 'running';
    return task;
  });
}

// Record a run result and advance the schedule. `ok` decides success vs failure;
// the schedule decides whether the task recurs or is now complete.
export async function recordRun(id, { ok, summary, inboxId = null, memoryKey = null }) {
  const finishedAt = new Date().toISOString();
  return mutateTask(id, (task) => {
    const occurrenceCount = task.occurrenceCount + 1;
    const nextRunAt = computeNextRun(task.schedule, { occurrenceCount, from: Date.now() });
    const run = {
      at: finishedAt,
      ok,
      summary: String(summary || '').slice(0, 1000),
      inboxId,
      memoryKey,
    };
    return {
      ...task,
      occurrenceCount,
      lastRunAt: finishedAt,
      lastRunStatus: ok ? `ok: ${run.summary.slice(0, 120)}` : `error: ${run.summary.slice(0, 120)}`,
      nextRunAt,
      // A failed run doesn't auto-retry-forever: if it can't recur it lands in
      // 'failed' for operator attention; otherwise it stays scheduled for its
      // next tick. A clean run with no next occurrence is 'done'.
      status: nextRunAt ? 'scheduled' : ok ? 'done' : 'failed',
      runs: [run, ...task.runs].slice(0, MAX_RUN_HISTORY),
    };
  });
}
