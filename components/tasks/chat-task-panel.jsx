'use client';

import { useTasks } from '../../lib/use-tasks';
import { TaskBoard } from './task-board';
import {
  listTasksAction,
  createTaskAction,
  updateTaskAction,
  deleteTaskAction,
  runTaskNowAction,
} from '../../app/admin/actions';

// Chat-side task panel. Wraps the shared TaskBoard, wiring it to the session-
// gated server actions and the SWR hook for optimistic-ish refreshes. Poll
// interval is short because autonomous runs flip status between cron ticks.
export function ChatTaskPanel() {
  const { tasks, isLoading, error, mutate } = useTasks(listTasksAction, { refreshInterval: 15_000 });

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
    <TaskBoard
      tasks={tasks}
      isLoading={isLoading}
      error={error}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onDelete={onDelete}
      onRun={onRun}
      onRefresh={() => mutate()}
      compact
    />
  );
}
