import { NextResponse } from 'next/server';

const VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';
const API_KEY = process.env.QIG_API_KEY || '';

function auth(req) {
  if (!API_KEY) return true;
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

const SANDBOX_API = 'https://api.vercel.com/v1/sandboxes';

// GET /api/sandbox - list active sandboxes
export async function GET(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!VERCEL_TOKEN) return NextResponse.json({ error: 'VERCEL_TOKEN not set' }, { status: 500 });

  const url = VERCEL_TEAM_ID ? `${SANDBOX_API}?teamId=${VERCEL_TEAM_ID}` : SANDBOX_API;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}` }
  });
  const data = await res.json();
  return NextResponse.json(data);
}

// POST /api/sandbox - create sandbox, exec command, or stop
// Body: { action: "create" } or { action: "exec", sandboxId, command, env?, cwd? } or { action: "stop", sandboxId }
export async function POST(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!VERCEL_TOKEN) return NextResponse.json({ error: 'VERCEL_TOKEN not set' }, { status: 500 });

  const body = await req.json();
  const teamQs = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : '';

  if (body.action === 'create') {
    const res = await fetch(`${SANDBOX_API}${teamQs}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VERCEL_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: body.name || 'qig-exec',
        template: body.template || 'node'
      })
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  }

  if (body.action === 'exec') {
    if (!body.sandboxId || !body.command) {
      return NextResponse.json({ error: 'sandboxId and command required' }, { status: 400 });
    }

    const cmdParts = body.command.split(' ');
    const res = await fetch(
      `${SANDBOX_API}/${body.sandboxId}/cmd${teamQs}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${VERCEL_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          command: cmdParts[0],
          args: cmdParts.slice(1),
          cwd: body.cwd || '/home/vercel-sandbox',
          env: body.env || {},
          wait: true
        })
      }
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  }

  if (body.action === 'stop') {
    if (!body.sandboxId) {
      return NextResponse.json({ error: 'sandboxId required' }, { status: 400 });
    }
    const res = await fetch(
      `${SANDBOX_API}/${body.sandboxId}/stop${teamQs}`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}` }
      }
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  }

  return NextResponse.json({ error: 'Unknown action. Use: create, exec, stop' }, { status: 400 });
}
