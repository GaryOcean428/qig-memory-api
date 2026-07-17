import { getSession } from '../../../../lib/session';
import { deleteThread, listThreads, mergeLocalThreads, saveThread } from '../../../../lib/chat-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Chat history is session-scoped, exactly like /api/chat itself. It is NOT part
// of the bearer surface: these are a human operator's conversations, not agent
// memory, so an agent token must never be able to read them.
async function requireUser() {
  const session = await getSession();
  const userId = session?.user?.id || session?.user?.email || session?.user?.username || null;
  return userId ? { userId } : null;
}

function unauthorized() {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

export async function GET() {
  const auth = await requireUser();
  if (!auth) return unauthorized();
  try {
    return Response.json({ threads: await listThreads(auth.userId) });
  } catch (error) {
    console.log('[v0] chat history list failed:', error?.message);
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}

// PUT saves ONE thread. Per-thread writes are the point: a whole-history save
// from a stale device would delete threads created elsewhere.
export async function PUT(request) {
  const auth = await requireUser();
  if (!auth) return unauthorized();
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_input' }, { status: 400 });
  }

  try {
    // `migrate` carries a browser's localStorage threads on first load.
    if (Array.isArray(body?.migrate)) {
      return Response.json(await mergeLocalThreads(auth.userId, body.migrate));
    }
    if (!body?.thread?.id) return Response.json({ error: 'invalid_input' }, { status: 400 });
    return Response.json({ thread: await saveThread(auth.userId, body.thread) });
  } catch (error) {
    if (error.code === 'invalid_input') return Response.json({ error: 'invalid_input' }, { status: 400 });
    if (error.code === 'payload_too_large') {
      return Response.json({ error: 'payload_too_large', message: error.message }, { status: 413 });
    }
    console.log('[v0] chat history save failed:', error?.message);
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const auth = await requireUser();
  if (!auth) return unauthorized();
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'invalid_input' }, { status: 400 });
  try {
    return Response.json(await deleteThread(auth.userId, id));
  } catch (error) {
    if (error.code === 'invalid_input') return Response.json({ error: 'invalid_input' }, { status: 400 });
    console.log('[v0] chat history delete failed:', error?.message);
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
