import { NextResponse } from 'next/server';

const PLATFORM_TOKEN = process.env.PLATFORM_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID || '';
const API_KEY = process.env.QIG_API_KEY || '';

function auth(req) {
  if (!API_KEY) return true;
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

const SANDBOX_API = 'https://api.vercel.com/v1/sandboxes';

function teamQs() {
  return VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : '';
}

function headers(json = false) {
  const h = { 'Authorization': `Bearer ${PLATFORM_TOKEN}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// GET /api/sandbox - list active sandboxes
export async function GET(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!PLATFORM_TOKEN) return NextResponse.json({ error: 'PLATFORM_TOKEN not set' }, { status: 500 });

  const res = await fetch(`${SANDBOX_API}${teamQs()}`, {
    headers: headers()
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

// POST /api/sandbox
// Actions:
//   create  - { action: "create", runtime?: "python3.13"|"node24" }
//   exec    - { action: "exec", sandboxId, command, args?:[], env?:{}, cwd? }
//   stop    - { action: "stop", sandboxId }
//   snapshot - { action: "snapshot", sandboxId }
export async function POST(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!PLATFORM_TOKEN) return NextResponse.json({ error: 'PLATFORM_TOKEN not set' }, { status: 500 });

  const body = await req.json();

  // --- CREATE ---
  if (body.action === 'create') {
    const payload = {
      runtime: body.runtime || 'python3.13',
      projectId: VERCEL_PROJECT_ID || undefined,
      timeout: body.timeout || '600000',
      networkPolicy: { mode: 'allow-all' }
    };
    const res = await fetch(`${SANDBOX_API}${teamQs()}`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  }

  // --- EXEC ---
  if (body.action === 'exec') {
    if (!body.sandboxId || !body.command) {
      return NextResponse.json({ error: 'sandboxId and command required' }, { status: 400 });
    }

    // Support both pre-split args and string command
    let cmd, args;
    if (body.args) {
      cmd = body.command;
      args = body.args;
    } else {
      const parts = body.command.split(' ');
      cmd = parts[0];
      args = parts.slice(1);
    }

    const res = await fetch(
      `${SANDBOX_API}/${body.sandboxId}/cmd${teamQs()}`,
      {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          command: cmd,
          args: args,
          cwd: body.cwd || '/home/vercel-sandbox',
          env: body.env || {},
          wait: body.wait !== false
        })
      }
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  }

  // --- STOP ---
  if (body.action === 'stop') {
    if (!body.sandboxId) {
      return NextResponse.json({ error: 'sandboxId required' }, { status: 400 });
    }
    const res = await fetch(
      `${SANDBOX_API}/${body.sandboxId}/stop${teamQs()}`,
      {
        method: 'POST',
        headers: headers()
      }
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  }

  // --- SNAPSHOT ---
  if (body.action === 'snapshot') {
    if (!body.sandboxId) {
      return NextResponse.json({ error: 'sandboxId required' }, { status: 400 });
    }
    const res = await fetch(
      `${SANDBOX_API}/${body.sandboxId}/snapshot${teamQs()}`,
      {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ expiration: body.expiration || '86400' })
      }
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  }

  return NextResponse.json({
    error: 'Unknown action',
    available: ['create', 'exec', 'stop', 'snapshot']
  }, { status: 400 });
}
