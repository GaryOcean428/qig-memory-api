import { NextResponse } from 'next/server';
import { authorize, unauthorizedReason } from '../../../../../lib/auth.js';
import { runTaskNow } from '../../../../../lib/task-runner.js';

// Manual "run now" — executes a task immediately regardless of its schedule.
// Write scope: it spends credits and produces side effects.
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req, { params }) {
  if (!(await authorize(req, 'memory:write', { allowOAuth: true }))) {
    return NextResponse.json({ error: 'unauthorized', reason: await unauthorizedReason() }, { status: 401 });
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
