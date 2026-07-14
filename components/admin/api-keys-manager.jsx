'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  StatusBadge,
  EmptyState,
  LoadingSpinner,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@bsuite/ui';
import { KeyRound, Plus, Trash2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { CopyButton } from '@/components/copy-button';
import {
  createApiKeyAction,
  revokeApiKeyAction,
} from '@/app/admin/actions';

const inputClass =
  'h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

export function ApiKeysManager({ initialKeys }) {
  const [keys, setKeys] = useState(initialKeys);
  const [label, setLabel] = useState('');
  const [newToken, setNewToken] = useState(null); // plaintext, shown once
  const [revoking, setRevoking] = useState(null); // key pending confirmation
  const [error, setError] = useState(null);
  const [isCreating, startCreate] = useTransition();
  const [isRevoking, startRevoke] = useTransition();

  function create() {
    setError(null);
    startCreate(async () => {
      const res = await createApiKeyAction(label);
      if (res?.token) {
        setNewToken(res.token);
        setKeys((prev) => [res.key, ...prev]);
        setLabel('');
      } else {
        setError('Could not create key. Please try again.');
      }
    });
  }

  function confirmRevoke() {
    if (!revoking) return;
    const id = revoking.id;
    startRevoke(async () => {
      const res = await revokeApiKeyAction(id);
      if (res.revoked) {
        setKeys((prev) => prev.filter((k) => k.id !== id));
        setRevoking(null);
      } else {
        setError('Could not revoke key. Please try again.');
        setRevoking(null);
      }
    });
  }

  return (
    <section className="mt-14">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-xl font-semibold tracking-tight text-foreground">API keys</h2>
      </div>
      <p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
        Bearer tokens for the REST API and MCP endpoint. Tokens are shown once at creation and
        stored only as a hash — copy yours immediately. Revoking a key takes effect instantly.
      </p>

      {/* Create */}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          className={inputClass}
          placeholder="Key label (e.g. hermes-local, ci-pipeline)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) create();
          }}
          aria-label="New key label"
        />
        <Button type="button" onClick={create} disabled={isCreating} className="shrink-0 gap-2">
          {isCreating ? <LoadingSpinner size="sm" /> : <Plus className="h-4 w-4" />}
          <span>Generate key</span>
        </Button>
      </div>

      {error && (
        <p className="mt-3 flex items-center gap-2 text-sm text-destructive">
          <TriangleAlert className="h-4 w-4" />
          {error}
        </p>
      )}

      {/* Key list */}
      <div className="mt-6">
        {keys.length === 0 ? (
          <EmptyState
            icon={<KeyRound className="h-6 w-6" />}
            title="No API keys yet"
            description="Generate a key above to authenticate agents, CLIs and MCP clients."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((k) => (
              <li
                key={k.id}
                className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground">{k.label}</span>
                    <StatusBadge tone="neutral">
                      <code className="font-mono text-xs">…{k.last4}</code>
                    </StatusBadge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Created {formatDate(k.created)}
                    {k.created_by ? ` · by ${k.created_by}` : ''}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRevoking(k)}
                  className="shrink-0 gap-2 text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  <span>Revoke</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Show-once token dialog */}
      <Dialog open={!!newToken} onOpenChange={(open) => !open && setNewToken(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Copy your new API key
            </DialogTitle>
            <DialogDescription>
              This is the only time the full token is shown. Store it somewhere safe — you can
              always revoke it and generate a new one.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-xl border border-border bg-muted/60 p-3">
            <code className="block break-all font-mono text-sm text-foreground">{newToken}</code>
          </div>

          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            Use it as a bearer token: <code className="font-mono">{'Authorization: Bearer <token>'}</code>
          </p>

          <DialogFooter>
            {newToken && (
              <CopyButton value={newToken} label="Copy token" copiedLabel="Copied" className="gap-2" />
            )}
            <Button type="button" variant="secondary" onClick={() => setNewToken(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation */}
      <Dialog open={!!revoking} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke this key?</DialogTitle>
            <DialogDescription>
              {revoking
                ? `"${revoking.label}" (…${revoking.last4}) will stop working immediately. Any agent or client using it will be denied.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmRevoke}
              disabled={isRevoking}
              className="gap-2"
            >
              {isRevoking ? <LoadingSpinner size="sm" /> : <Trash2 className="h-4 w-4" />}
              <span>Revoke key</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
