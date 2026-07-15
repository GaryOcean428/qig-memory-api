'use client';

import { useMemo, useState } from 'react';
import { Plus, RefreshCw, ListTodo } from 'lucide-react';
import { cn } from '../../lib/utils';
import { TaskCard } from './task-card';
import { TaskForm } from './task-form';
import {
  GROUP_OPTIONS,
  SORT_OPTIONS,
  groupTasks,
  sortTasks,
  STATUS_ORDER,
} from '../../lib/task-ui';

const STATUS_FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
  ...STATUS_ORDER.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) })),
];

// Shared board used by both the chat side panel (compact) and the admin page
// (full). All create/update/delete/run flows come in as callbacks so the two
// surfaces share zero data-fetching logic beyond the useTasks hook upstream.
export function TaskBoard({
  tasks,
  isLoading,
  error,
  onCreate,
  onUpdate,
  onDelete,
  onRun,
  onRefresh,
  compact = false,
}) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [statusFilter, setStatusFilter] = useState('active');
  const [groupBy, setGroupBy] = useState('project');
  const [sortBy, setSortBy] = useState('smart');

  const visible = useMemo(() => {
    let list = tasks;
    if (statusFilter === 'active') {
      list = list.filter((t) => t.status === 'scheduled' || t.status === 'running');
    } else if (statusFilter !== 'all') {
      list = list.filter((t) => t.status === statusFilter);
    }
    return sortTasks(list, sortBy);
  }, [tasks, statusFilter, sortBy]);

  const groups = useMemo(() => groupTasks(visible, groupBy), [visible, groupBy]);

  async function handleSubmit(values) {
    const fn = editing ? (v) => onUpdate(editing.id, v) : onCreate;
    const res = await fn(values);
    if (res?.ok !== false) {
      setShowForm(false);
      setEditing(null);
    }
    return res;
  }

  function startCreate() {
    setEditing(null);
    setShowForm(true);
  }

  function startEdit(task) {
    setEditing(task);
    setShowForm(true);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ListTodo className="size-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Tasks</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {tasks.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh tasks"
            title="Refresh"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={startCreate}
            className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            New task
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
          className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-muted-foreground">
          Group
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
            aria-label="Group by"
            className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
          >
            {GROUP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          Sort
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            aria-label="Sort by"
            className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Failed to load tasks. Try refreshing.
          </p>
        ) : null}

        {!error && tasks.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <ListTodo className="size-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">No tasks yet.</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Create one here, or ask the helper agent in chat to schedule work for you.
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.key} className="flex flex-col gap-2">
              {groupBy !== 'none' ? (
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal">
                    {group.items.length}
                  </span>
                </h3>
              ) : null}
              <div className="flex flex-col gap-2">
                {group.items.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    compact={compact}
                    onEdit={() => startEdit(task)}
                    onDelete={() => onDelete(task.id)}
                    onRun={() => onRun(task.id)}
                    onCancel={() => onUpdate(task.id, { status: 'cancelled' })}
                    onReactivate={() => onUpdate(task.id, { status: 'scheduled' })}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {showForm ? (
        <TaskForm
          initialTask={editing}
          onSubmit={handleSubmit}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}
