'use client';

import { useTasks } from '../../lib/use-tasks';
import { TaskBoard } from './task-board';

// Chat-side task panel. Wraps the shared TaskBoard against the SWR hook, which
// owns the session-gated server-action calls and cross-surface revalidation.
// `active` gates polling so a collapsed panel does no background work.
export function ChatTaskPanel({ active = true }) {
  const { tasks, isLoading, error, create, update, remove, runNow, refresh } = useTasks({ active });

  return (
    <TaskBoard
      tasks={tasks}
      isLoading={isLoading}
      error={error}
      onCreate={create}
      onUpdate={update}
      onDelete={remove}
      onRun={runNow}
      onRefresh={refresh}
      compact
    />
  );
}
