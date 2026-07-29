import { NextResponse } from 'next/server';
import { authorizeDetailed, isNamespaceRestricted } from '../../../../../lib/auth.js';
import { runTaskNow } from '../../../../../lib/task-runner.js';

// Manual "run now" — executes a task immediately regardless of its schedule.
// Write scope: it spends credits and produces side effects.
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req, { params }) {
  const auth = await authorizeDetailed(req, 'memory:write', { allowOAuth: true });
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  // Same rule as task creation (POST /api/tasks): the task-runner's LLM loop
  // holds an unrestricted inbox_send, so a namespace-restricted credential
  // cannot be allowed to trigger a run either — not just a create.
  if (isNamespaceRestricted(auth.principal)) {
    return NextResponse.json(
      { error: 'namespace_restricted', message: 'namespace-restricted credentials cannot run autonomous tasks' },
      { status: 403 },
    );
  }
  const { id } = await params;
  try {
    const result = await runTaskNow(id);
    if (result.reason === 'not_found') {
      return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
