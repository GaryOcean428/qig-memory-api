'use client';

import { useState } from 'react';
import { Button, LoadingSpinner } from '@bsuite/ui';
import { X, TriangleAlert, CalendarClock, Repeat, Zap } from 'lucide-react';
import { emptyTaskForm, formToInput, INTERVAL_PRESETS } from '../../lib/task-ui';

const inputClass =
  'h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const labelClass = 'text-xs font-medium text-muted-foreground';

// Segmented control matching the app's pill aesthetic.
function Segmented({ options, value, onChange, name }) {
  return (
    <div role="radiogroup" aria-label={name} className="flex rounded-md border border-border bg-card p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
            value === opt.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Create/edit dialog. `initialForm` seeds an edit; omit for a new task.
export function TaskForm({ initialForm, onSubmit, onClose, editing = false }) {
  const [form, setForm] = useState(initialForm || emptyTaskForm());
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    let input;
    try {
      input = formToInput(form);
    } catch (err) {
      setError(err.message);
      return;
    }
    if (!input.title || !input.instruction) {
      setError('A title and an instruction are required.');
      return;
    }
    setSaving(true);
    const res = await onSubmit(input);
    setSaving(false);
    if (res?.ok) onClose();
    else setError(res?.error === 'invalid_task' ? 'Some fields are invalid. Check the schedule.' : res?.error || 'Could not save the task.');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm sm:items-center">
      <form
        onSubmit={submit}
        className="relative my-8 w-full max-w-lg rounded-2xl border border-border bg-background p-5 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{editing ? 'Edit task' : 'New task'}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <label className={labelClass} htmlFor="task-title">Title</label>
            <input
              id="task-title"
              className={inputClass}
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="e.g. Summarize new commits in qig-core"
              maxLength={200}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className={labelClass} htmlFor="task-instruction">Instruction for the agent</label>
            <textarea
              id="task-instruction"
              className="min-h-24 w-full resize-y rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.instruction}
              onChange={(e) => set({ instruction: e.target.value })}
              placeholder="Describe exactly what to do. The runner executes this with no extra context."
              maxLength={8000}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className={labelClass} htmlFor="task-project">Project</label>
              <input
                id="task-project"
                className={inputClass}
                value={form.project}
                onChange={(e) => set({ project: e.target.value })}
                placeholder="General"
                maxLength={120}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={labelClass} htmlFor="task-repo">Repository</label>
              <input
                id="task-repo"
                className={inputClass}
                value={form.repository}
                onChange={(e) => set({ repository: e.target.value })}
                placeholder="owner/name (optional)"
                maxLength={140}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className={labelClass} htmlFor="task-concepts">Concepts</label>
              <input
                id="task-concepts"
                className={inputClass}
                value={form.conceptsText}
                onChange={(e) => set({ conceptsText: e.target.value })}
                placeholder="comma, separated"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={labelClass} htmlFor="task-priority">Priority</label>
              <select
                id="task-priority"
                className={inputClass}
                value={form.priority}
                onChange={(e) => set({ priority: e.target.value })}
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          {/* Schedule */}
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/20 p-3">
            <span className={labelClass}>Schedule</span>
            <Segmented
              name="Schedule type"
              value={form.scheduleKind}
              onChange={(v) => set({ scheduleKind: v })}
              options={[
                { value: 'once', label: 'One-off', icon: <Zap className="size-3.5" /> },
                { value: 'recurring', label: 'Recurring', icon: <Repeat className="size-3.5" /> },
              ]}
            />

            <Segmented
              name="Start time"
              value={form.startMode}
              onChange={(v) => set({ startMode: v })}
              options={[
                { value: 'asap', label: 'As soon as possible' },
                { value: 'at', label: 'At a set time', icon: <CalendarClock className="size-3.5" /> },
              ]}
            />
            {form.startMode === 'at' ? (
              <input
                type="datetime-local"
                className={inputClass}
                value={form.startAt}
                onChange={(e) => set({ startAt: e.target.value })}
                aria-label="Start date and time"
              />
            ) : null}

            {form.scheduleKind === 'recurring' ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1.5">
                  <label className={labelClass} htmlFor="task-interval">Repeat</label>
                  <select
                    id="task-interval"
                    className={inputClass}
                    value={form.intervalMs}
                    onChange={(e) => set({ intervalMs: Number(e.target.value) })}
                  >
                    {INTERVAL_PRESETS.map((p) => (
                      <option key={p.ms} value={p.ms}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className={labelClass}>Stop condition</label>
                  <Segmented
                    name="Stop condition"
                    value={form.capType}
                    onChange={(v) => set({ capType: v })}
                    options={[
                      { value: 'none', label: 'Forever' },
                      { value: 'count', label: 'After N runs' },
                      { value: 'until', label: 'Until date' },
                    ]}
                  />
                </div>
                {form.capType === 'count' ? (
                  <input
                    type="number"
                    min={1}
                    className={inputClass}
                    value={form.maxOccurrences}
                    onChange={(e) => set({ maxOccurrences: e.target.value })}
                    aria-label="Maximum occurrences"
                  />
                ) : null}
                {form.capType === 'until' ? (
                  <input
                    type="datetime-local"
                    className={inputClass}
                    value={form.untilDate}
                    onChange={(e) => set({ untilDate: e.target.value })}
                    aria-label="End date and time"
                  />
                ) : null}
              </div>
            ) : null}
          </div>

          {error ? (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <TriangleAlert className="size-4 shrink-0" />
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving} className="gap-2">
              {saving ? <LoadingSpinner size="sm" /> : null}
              {editing ? 'Save changes' : 'Create task'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
