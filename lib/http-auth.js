import { NextResponse } from 'next/server';
import { authorizeDetailed, unauthorizedReason } from './auth';

export async function requireApiScope(req, scope) {
  return authorizeDetailed(req, scope, { allowOAuth: true });
}

export async function deniedResponse(result) {
  const insufficient = result.error === 'insufficient_scope';
  return NextResponse.json(
    {
      error: result.error,
      reason: insufficient ? 'insufficient_scope' : await unauthorizedReason(),
      required_scope: result.requiredScope || undefined,
    },
    {
      status: result.status,
      headers: {
        'www-authenticate': insufficient
          ? `Bearer error="insufficient_scope", scope="${result.requiredScope}"`
          : 'Bearer',
      },
    },
  );
}

export function errorResponse(error) {
  if (error?.name === 'ZodError') {
    return NextResponse.json({ error: 'invalid_input', issues: error.issues }, { status: 400 });
  }
  if (error?.code === 'invalid_input') {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 400 });
  }
  if (error?.code === 'payload_too_large' || error?.code === 'artifact_too_large') {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 413 });
  }
  if (error?.code === 'integrity_failed') {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
  }
  if (error?.name === 'BlobPreconditionFailedError' || error?.code === 'conflict') {
    return NextResponse.json({ error: 'conflict', message: error.message }, { status: 409 });
  }
  return NextResponse.json({ error: 'internal_error', message: error?.message || String(error) }, { status: 500 });
}
