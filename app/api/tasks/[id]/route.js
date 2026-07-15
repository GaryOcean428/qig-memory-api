import { NextResponse } from 'next/server';
import { authorizeDetailed } from '../../../../lib/auth.js';
import { deleteTask, getTask, updateTask, withDerived } from '../../../../lib/task-store.js';

export const maxDuration = 60;

// Distinguishes unauthenticated (401) from authenticated-but-wrong-scope (403).
function denied(auth) {
  return NextResponse.json({ error: auth.error }, { status: auth.status });
}

// GET /api/tasks/:id — read a single task (read scope).
export async function GET(req, { params }) {
  const auth = await authorizeDetailed(req, 'memory:read', { allowOAuth: true });
  if (auth.error) return denied(auth);
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
  return NextResponse.json({ task: withDerived(task) });
}

// PATCH /api/tasks/:id — update a task (write scope).
export async function PATCH(req, { params }) {
  const auth = await authorizeDetailed(req, 'memory:write', { allowOAuth: true });
  if (auth.error) return denied(auth);
  const { id } = await params;
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  try {
    const updated = await updateTask(id, body);
    if (!updated) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    return NextResponse.json({ ok: true, task: withDerived(updated) });
  } catch (error) {
    if (error?.name === 'ZodError') {
      return NextResponse.json({ error: 'invalid_patch', issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE /api/tasks/:id — remove a task (write scope).
export async function DELETE(req, { params }) {
  const auth = await authorizeDetailed(req, 'memory:write', { allowOAuth: true });
  if (auth.error) return denied(auth);
  const { id } = await params;
  const existing = await getTask(id);
  if (!existing) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
  await deleteTask(id);
  return NextResponse.json({ ok: true, deleted: true, id });
}
