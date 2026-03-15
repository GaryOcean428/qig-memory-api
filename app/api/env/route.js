import { NextResponse } from 'next/server';

const API_KEY = process.env.QIG_API_KEY || '';

const ALLOWED_VARS = [
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
  'MODAL_INFERENCE_URL',
  'MODAL_HARVEST_URL',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_TOKEN',
];

function auth(req) {
  if (!API_KEY) return true;
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${API_KEY}`;
}

export async function GET(req) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  const requested = (url.searchParams.get('keys') || '').split(',').filter(Boolean);
  if (requested.length === 0) {
    return NextResponse.json({ available: ALLOWED_VARS.filter(k => !!process.env[k]) });
  }
  const result = {};
  for (const key of requested) {
    if (ALLOWED_VARS.includes(key)) {
      result[key] = process.env[key] || null;
    }
  }
  return NextResponse.json(result);
}
