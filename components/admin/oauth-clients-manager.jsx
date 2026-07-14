'use client';

import { useState, useTransition } from 'react';
import { Button, EmptyState, LoadingSpinner, StatusBadge } from '@bsuite/ui';
import { Cable, ShieldCheck, ShieldX } from 'lucide-react';
import { setOAuthClientTrustAction } from '@/app/admin/actions';

export function OAuthClientsManager({ initialClients }) {
  const [clients, setClients] = useState(initialClients);
  const [pendingId, setPendingId] = useState(null);
  const [isPending, startTransition] = useTransition();

  function toggle(client) {
    setPendingId(client.client_id);
    startTransition(async () => {
      const updated = await setOAuthClientTrustAction(client.client_id, !client.trusted);
      if (updated) setClients((items) => items.map((item) => item.client_id === updated.client_id ? updated : item));
      setPendingId(null);
    });
  }

  return (
    <section id="oauth-clients" className="mt-14 scroll-mt-24">
      <div className="flex items-center gap-2">
        <Cable className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-xl font-semibold tracking-tight text-foreground">OAuth clients</h2>
      </div>
      <p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
        Dynamically registered clients start with read-only memory access. Approving a client grants read, write, and administrative deletion scopes.
      </p>
      <div className="mt-5">
        {clients.length === 0 ? (
          <EmptyState icon={<Cable className="h-6 w-6" />} title="No OAuth clients" description="Clients appear here after dynamic registration." />
        ) : (
          <ul className="flex flex-col gap-2">
            {clients.map((client) => (
              <li key={client.client_id} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground">{client.client_name}</span>
                    <StatusBadge tone={client.trusted ? 'success' : 'neutral'}>{client.trusted ? 'Full operator' : 'Read only'}</StatusBadge>
                  </div>
                  <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">{client.client_id}</code>
                  <p className="mt-1 text-xs text-muted-foreground">Scopes: {(client.approved_scopes || ['memory:read']).join(', ')}</p>
                </div>
                <Button type="button" variant={client.trusted ? 'secondary' : 'default'} className="shrink-0 gap-2" disabled={isPending && pendingId === client.client_id} onClick={() => toggle(client)}>
                  {isPending && pendingId === client.client_id ? <LoadingSpinner size="sm" /> : client.trusted ? <ShieldX className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                  <span>{client.trusted ? 'Revoke operator' : 'Approve operator'}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
