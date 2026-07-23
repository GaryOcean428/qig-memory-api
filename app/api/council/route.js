import { NextResponse } from 'next/server';
import { conveneCouncil, COUNCIL_MEMBERS, COUNCIL_SYNTHESIZER } from '../../../lib/council';
import { deniedResponse, errorResponse, requireApiScope } from '../../../lib/http-auth';

// The council runs 13 model calls (2N+1 with the default 6 members) across 3
// SEQUENTIAL phases (panel -> reflect -> synthesis); give it room. Full budget
// arithmetic (and why 800 can still be exceeded in the all-fallbacks worst
// case, and what protects the route when it is) lives in lib/council.js next
// to CONVENE_MAX_DURATION_S / MEMBER_TIMEOUT_MS / the deadline-aware guard in
// callMember — this literal MUST stay equal to CONVENE_MAX_DURATION_S there
// (Next.js requires maxDuration to be a literal number in the route file, so
// it cannot simply import the constant).
export const maxDuration = 800;

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
  // Convening writes (council_* ruling + inbox delivery), so it needs write scope.
  const authorization = await requireApiScope(req, 'memory:write');
  if (authorization.error) return deniedResponse(authorization);
  try {
    const body = await req.json();
    if (!body.question || typeof body.question !== 'string') {
      return NextResponse.json({ error: 'invalid_input', message: 'question is required' }, { status: 400 });
    }
    const result = await conveneCouncil(body);
    if (result.error) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
