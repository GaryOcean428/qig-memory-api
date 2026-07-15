import { NextResponse } from 'next/server';
import { authorize, authenticate, unauthorizedReason } from '../../../lib/auth.js';
import { createTask, listTasks, withDerived } from '../../../lib/task-store.js';

export const maxDuration = 60;

// GET /api/tasks — list all scheduled tasks (read scope).
export async function GET(req) {
  if (!(await authorize(req, 'memory:read', { allowOAuth: true }))) {
    return NextResponse.json({ error: 'unauthorized', reason: await unauthorizedReason() }, { status: 401 });
  }
  try {
    const tasks = await listTasks();
    return NextResponse.json({ count: tasks.length, tasks: tasks.map((t) => withDerived(t)) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST /api/tasks — create a task (write scope). Body is the task input shape.
export async function POST(req) {
  const principal = await authenticate(req, { allowOAuth: true });
  if (!(await authorize(req, 'memory:write', { allowOAuth: true }))) {
    return NextResponse.json({ error: 'unauthorized', reason: await unauthorizedReason() }, { status: 401 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  try {
    const createdBy = principal?.label || principal?.sub || principal?.name || 'api';
    const task = await createTask(body, { createdBy });
    return NextResponse.json({ ok: true, task: withDerived(task) }, { status: 201 });
  } catch (error) {
    if (error?.name === 'ZodError') {
      return NextResponse.json({ error: 'invalid_task', issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
