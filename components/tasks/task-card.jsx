'use client';

import { useState } from 'react';
import { StatusBadge } from '@bsuite/ui';
import {
  Play,
  Pencil,
  Trash2,
  Ban,
  RotateCcw,
  Repeat,
  Zap,
  Clock,
  FolderGit2,
  GitBranch,
  ChevronDown,
} from 'lucide-react';
import {
  statusTone,
  priorityTone,
  scheduleSummary,
  relativeTime,
  formatDateTime,
} from '../../lib/task-ui';
import { cn } from '../../lib/utils';

function IconAction({ label, icon: Icon, onClick, disabled, tone }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        tone === 'danger' && 'hover:text-destructive',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
  );
}

export function TaskCard({ task, busy, onRun, onEdit, onCancel, onReactivate, onDelete }) {
  const [open, setOpen] = useState(false);
  const finished = task.status === 'done' || task.status === 'cancelled';
  const lastRun = task.runs?.[0];

  return (
    <li className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Collapse task' : 'Expand task'}
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium leading-snug text-foreground text-pretty">{task.title}</p>
            <div className="flex shrink-0 items-center gap-1">
              {!finished ? (
                <IconAction label="Run now" icon={Play} onClick={() => onRun(task)} disabled={busy || task.status === 'running'} />
              ) : null}
              <IconAction label="Edit" icon={Pencil} onClick={() => onEdit(task)} disabled={busy} />
              {finished ? (
                <IconAction label="Re-activate" icon={RotateCcw} onClick={() => onReactivate(task)} disabled={busy} />
              ) : (
                <IconAction label="Cancel" icon={Ban} onClick={() => onCancel(task)} disabled={busy} />
              )}
              <IconAction label="Delete" icon={Trash2} tone="danger" onClick={() => onDelete(task)} disabled={busy} />
            </div>
          </div>

          {/* Flag row */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={statusTone(task.status)}>{task.status}</StatusBadge>
            <StatusBadge tone={priorityTone(task.priority)}>{task.priority}</StatusBadge>
            {task.overdue ? <StatusBadge tone="error">overdue</StatusBadge> : null}
            {task.dueSoon && !task.overdue ? <StatusBadge tone="warning">due soon</StatusBadge> : null}
            <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {task.isRecurring ? <Repeat className="size-3" /> : <Zap className="size-3" />}
              {scheduleSummary(task)}
            </span>
          </div>

          {/* Meta row */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <FolderGit2 className="size-3" />
              {task.project}
            </span>
            {task.repository ? (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3" />
                {task.repository}
              </span>
            ) : null}
            {task.nextRunAt && !finished ? (
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                next {relativeTime(task.nextRunAt)}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {open ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3 pl-7">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{task.instruction}</p>
          {task.concepts?.length ? (
            <div className="flex flex-wrap gap-1">
              {task.concepts.map((c) => (
                <span key={c} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {c}
                </span>
              ))}
            </div>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Runs</dt>
              <dd className="text-foreground">{task.occurrenceCount}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Last run</dt>
              <dd className="text-foreground">{formatDateTime(task.lastRunAt) || 'never'}</dd>
            </div>
          </dl>
          {lastRun ? (
            <p className={cn('text-[11px]', lastRun.ok ? 'text-muted-foreground' : 'text-destructive')}>
              <span className="font-medium">Last result:</span> {lastRun.summary}
            </p>
          ) : null}
          {task.createdBy ? (
            <p className="text-[11px] text-muted-foreground">Assigned by {task.createdBy}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
