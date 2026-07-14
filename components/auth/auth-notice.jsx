'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, X } from 'lucide-react';

const MESSAGES = {
  oauth_not_configured:
    'Sign in with Vercel is not configured yet. Add VERCEL_OAUTH_CLIENT_ID and VERCEL_OAUTH_CLIENT_SECRET to enable it.',
  invalid_state: 'Sign-in could not be verified (state mismatch). Please try again.',
  token_exchange_failed: 'Sign-in failed while exchanging the authorization code. Please try again.',
  access_denied: 'Sign-in was cancelled.',
};

export function AuthNotice() {
  const params = useSearchParams();
  const code = params.get('auth_error');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [code]);

  if (!code || dismissed) return null;

  const message = MESSAGES[code] || `Sign-in error: ${code}`;

  return (
    <div className="mx-auto max-w-4xl px-4 pt-6 sm:px-6">
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <p className="flex-1 text-pretty">{message}</p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Dismiss notification"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
