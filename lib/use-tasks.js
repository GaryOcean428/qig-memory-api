'use client';

import useSWR from 'swr';
import {
  listTasksAction,
  createTaskAction,
  updateTaskAction,
  deleteTaskAction,
  runTaskNowAction,
} from '@/app/admin/actions';

// Single SWR-backed source of task state, shared by the chat panel and the admin
// board. Both mount this hook against the same 'tasks' key, so a mutation in one
// surface revalidates the other. Polls so autonomous cron runs surface live.
export function useTasks() {
  const { data, error, isLoading, mutate } = useSWR('tasks', () => listTasksAction(), {
    refreshInterval: 20_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });

  async function create(input) {
    const res = await createTaskAction(input);
    if (res?.ok) await mutate();
    return res;
  }
  async function update(id, patch) {
    const res = await updateTaskAction(id, patch);
    if (res?.ok) await mutate();
    return res;
  }
  async function remove(id) {
    const res = await deleteTaskAction(id);
    await mutate();
    return res;
  }
  async function runNow(id) {
    const res = await runTaskNowAction(id);
    await mutate();
    return res;
  }

  return {
    tasks: data || [],
    isLoading,
    error,
    refresh: mutate,
    create,
    update,
    remove,
    runNow,
  };
}
