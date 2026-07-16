import { NextResponse } from 'next/server';
import { authorizeDetailed } from '../../../lib/auth.js';
import { createTask, listTasks, withDerived } from '../../../lib/task-store.js';

export const maxDuration = 60;

// Distinguishes unauthenticated (401) from authenticated-but-wrong-scope (403).
function denied(auth) {
  return NextResponse.json({ error: auth.error }, { status: auth.status });
}

// GET /api/tasks — list all scheduled tasks (read scope).
export async function GET(req) {
  const auth = await authorizeDetailed(req, 'memory:read', { allowOAuth: true });
  if (auth.error) return denied(auth);
  try {
    const tasks = await listTasks();
    return NextResponse.json({ count: tasks.length, tasks: tasks.map((t) => withDerived(t)) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST /api/tasks — create a task (write scope). Body is the task input shape.
export async function POST(req) {
  const auth = await authorizeDetailed(req, 'memory:write', { allowOAuth: true });
  if (auth.error) return denied(auth);
  const principal = auth.principal;
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
