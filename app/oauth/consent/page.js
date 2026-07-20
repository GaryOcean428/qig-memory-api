import { redirect } from 'next/navigation';
import { Button, Logo, StatusBadge } from '@bsuite/ui';
import { Check, ShieldCheck, Wrench } from 'lucide-react';
import { getSession } from '../../../lib/session';
import { getClient } from '../../../lib/mcp-oauth-store';

export const dynamic = 'force-dynamic';

export default async function OAuthConsentPage({ searchParams }) {
  const params = await searchParams;
  const session = await getSession();
  if (!session) redirect(`/api/auth/vercel/login?returnTo=${encodeURIComponent(`/oauth/consent?${new URLSearchParams(params).toString()}`)}`);

  const client = await getClient(params.client_id);
  if (!client || !params.redirect_uri || !client.redirect_uris.includes(params.redirect_uri)) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
        <section className="elev-card w-full max-w-lg rounded-2xl border border-border bg-card p-8 text-center">
          <h1 className="text-xl font-semibold text-foreground">Invalid authorization request</h1>
          <p className="mt-2 text-sm text-muted-foreground">The client or callback URL could not be verified.</p>
        </section>
      </main>
    );
  }

  const fields = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'consent_token'];
  const requestedScopes = String(params.scope || 'memory:read').split(/\s+/).filter(Boolean);
  const scopeDescriptions = {
    'memory:read': 'Read, list, and search memory records and inspect the kernel mesh.',
    'memory:write': 'Create and update memory records and scoring metadata.',
    'memory:delete': 'Delete memory records (correct stale entries, remove wrong ones).',
    'memory:admin': 'Mint API keys and perform cross-namespace administrative operations.',
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <section className="elev-card w-full max-w-lg rounded-2xl border border-border bg-card p-6 sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <Logo size="md" />
          <StatusBadge tone="info">OAuth</StatusBadge>
        </div>

        <div className="mt-8 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <ShieldCheck className="size-6" aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground text-balance">
          Allow {client.client_name} to access QIG Memory API?
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-pretty">
          Signed in as {session.user.email || session.user.username || session.user.name}. Review the requested permission before continuing.
        </p>

        <div className="mt-6 rounded-xl border border-border bg-muted/40 p-4">
          <div className="flex items-start gap-3">
            <Wrench className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Requested permissions</p>
              <ul className="mt-3 flex flex-col gap-3">
                {requestedScopes.map((scope) => (
                  <li key={scope} className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                    <span>
                      <code className="font-mono text-foreground">{scope}</code>
                      <span className="block">{scopeDescriptions[scope] || 'Access the requested QIG Memory capability.'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-4 border-t border-border pt-4 text-xs text-muted-foreground">
            Client trust:{' '}
            <span className="font-medium text-foreground">
              {client.trusted
                ? 'Full operator — read, write, delete, and administer (mint keys, cross-namespace)'
                : 'Agent — can read, write, and delete records (no key-minting or cross-namespace admin)'}
            </span>
          </div>
        </div>

        <p className="mt-5 break-all text-xs leading-relaxed text-muted-foreground">
          After approval, you will return to <span className="font-mono text-foreground">{new URL(params.redirect_uri).origin}</span>.
        </p>

        <form action="/api/oauth/authorize" method="post" className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          {fields.map((field) => params[field] ? <input key={field} type="hidden" name={field} value={params[field]} /> : null)}
          <Button type="submit" name="decision" value="deny" variant="secondary">Deny</Button>
          <Button type="submit" name="decision" value="allow">Allow access</Button>
        </form>
      </section>
    </main>
  );
}
