'use client';

import { useTasks } from '../../lib/use-tasks';
import { TaskBoard } from '../tasks/task-board';

// Admin task board. Same shared TaskBoard as the chat panel, but full-width and
// seeded with server-rendered data so it paints instantly, then keeps fresh via
// SWR. All mutations run through the hook's session-gated actions.
export function TaskManager({ initialTasks = [] }) {
  const { tasks, isLoading, error, create, update, remove, runNow, refresh } = useTasks({
    fallbackData: initialTasks,
  });

  return (
    <section className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
      <div className="h-[36rem]">
        <TaskBoard
          tasks={tasks}
          isLoading={isLoading}
          error={error}
          onCreate={create}
          onUpdate={update}
          onDelete={remove}
          onRun={runNow}
          onRefresh={refresh}
        />
      </div>
    </section>
  );
}
