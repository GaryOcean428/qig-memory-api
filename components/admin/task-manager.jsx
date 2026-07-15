'use client';

import { useTasks } from '../../lib/use-tasks';
import { TaskBoard } from '../tasks/task-board';
import {
  listTasksAction,
  createTaskAction,
  updateTaskAction,
  deleteTaskAction,
  runTaskNowAction,
} from '../../app/admin/actions';

// Admin task board. Same shared TaskBoard as the chat panel, but full-width and
// seeded with server-rendered data so it paints instantly, then keeps fresh via
// SWR. All mutations run through the session-gated actions.
export function TaskManager({ initialTasks = [] }) {
  const { tasks, isLoading, error, mutate } = useTasks(listTasksAction, {
    fallbackData: initialTasks,
    refreshInterval: 20_000,
  });

  async function onCreate(values) {
    const res = await createTaskAction(values);
    if (res?.ok !== false) await mutate();
    return res;
  }

  async function onUpdate(id, patch) {
    const res = await updateTaskAction(id, patch);
    if (res?.ok !== false) await mutate();
    return res;
  }

  async function onDelete(id) {
    await deleteTaskAction(id);
    await mutate();
  }

  async function onRun(id) {
    const res = await runTaskNowAction(id);
    await mutate();
    return res;
  }

  return (
    <section className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
      <div className="h-[36rem]">
        <TaskBoard
          tasks={tasks}
          isLoading={isLoading}
          error={error}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onRun={onRun}
          onRefresh={() => mutate()}
        />
      </div>
    </section>
  );
}
