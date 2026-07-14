import { NextResponse } from 'next/server';
import { conveneCouncil, COUNCIL_MEMBERS, COUNCIL_SYNTHESIZER } from '../../../lib/council';
import { deniedResponse, errorResponse, requireApiScope } from '../../../lib/http-auth';

// The council runs 9 sequential-ish model calls across 3 phases; give it room.
export const maxDuration = 300;

export async function GET(req) {
  const authorization = await requireApiScope(req, 'memory:read');
  if (authorization.error) return deniedResponse(authorization);
  return NextResponse.json({
    members: COUNCIL_MEMBERS.map((m) => ({ name: m.name, model: m.model, fallback: m.fallback })),
    synthesizer: COUNCIL_SYNTHESIZER,
    phases: ['panel', 'reflect', 'synthesis'],
    doctrine_key: 'qig_doctrine_council',
    note: 'POST { question, context?, convener? }. Expensive (9 model calls) — convene sparingly.',
  });
}

export async function POST(req) {
  const authorization = await requireApiScope(req, 'memory:read');
  if (authorization.error) return deniedResponse(authorization);
  try {
    const body = await req.json();
    if (!body.question || typeof body.question !== 'string') {
      return NextResponse.json({ error: 'invalid_input', message: 'question is required' }, { status: 400 });
    }
    return NextResponse.json(await conveneCouncil(body));
  } catch (error) {
    return errorResponse(error);
  }
}
