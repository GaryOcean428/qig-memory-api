'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  StatusBadge,
} from '@bsuite/ui';
import { Check, Copy, KeyRound, LockKeyhole, Plug, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
import { CopyButton } from '@/components/copy-button';
import {
  BROWSER_KEY_EVENT,
  BROWSER_KEY_STORAGE,
  forgetBrowserApiKey,
  readBrowserApiKey,
} from '@/lib/browser-api-key';

const PROD_URL = process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL;
const FALLBACK_ORIGIN = PROD_URL ? `https://${PROD_URL}` : 'https://qig-memory-api.vercel.app';
const PLATFORMS = ['Claude Code', 'Grok Build', 'Cursor', 'Codex CLI', 'grok.com Connectors', 'claude.ai'];

function SecureCopyButton({ value, label, hasCredential, onMissing, variant = 'primary', size = 'md' }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!hasCredential) {
      onMissing();
      return;
    }
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Button type="button" variant={variant} size={size} onClick={copy} className="shrink-0 gap-2">
      {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function McpConnector() {
  const [origin, setOrigin] = useState(FALLBACK_ORIGIN);
  const [mode, setMode] = useState('oauth');
  const [remembered, setRemembered] = useState(null);
  const [missingKey, setMissingKey] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    setRemembered(readBrowserApiKey());
    const sync = (event) => {
      if (event.type === 'storage' && event.key !== BROWSER_KEY_STORAGE) return;
      setRemembered(readBrowserApiKey());
    };
    window.addEventListener('storage', sync);
    window.addEventListener(BROWSER_KEY_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(BROWSER_KEY_EVENT, sync);
    };
  }, []);

  const mcpUrl = `${origin}/api/mcp`;
  const token = remembered?.token || '';
  const isOAuth = mode === 'oauth';

  const mcpJson = useMemo(() => {
    const server = { type: 'http', url: mcpUrl };
    if (!isOAuth && token) server.headers = { Authorization: `Bearer ${token}` };
    return JSON.stringify({ mcpServers: { 'qig-memory': server } }, null, 2);
  }, [isOAuth, mcpUrl, token]);

  const cliCommand = isOAuth
    ? `claude mcp add --transport http qig-memory ${mcpUrl}`
    : `claude mcp add --transport http qig-memory ${mcpUrl} --header "Authorization: Bearer ${token}"`;
  const canCopyAuthenticated = isOAuth || Boolean(token);

  function forget() {
    forgetBrowserApiKey();
    setRemembered(null);
  }

  return (
    <div id="connect" className="elev-card scroll-mt-24 rounded-2xl border border-border bg-card p-6 sm:p-8">
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Plug className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">Connect via MCP</h2>
            <StatusBadge tone="success">Live</StatusBadge>
          </div>
          <p className="mt-1.5 max-w-3xl text-pretty text-sm leading-relaxed text-muted-foreground">
            Add the Streamable HTTP server using interactive OAuth or a generated bearer key. OAuth-capable clients open Vercel sign-in automatically; API-key commands include your remembered token.
          </p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {PLATFORMS.map((platform) => <StatusBadge key={platform} tone="info">{platform}</StatusBadge>)}
      </div>

      <div className="mt-8 rounded-xl border border-border bg-muted/30 p-1">
        <div className="grid grid-cols-2 gap-1" role="tablist" aria-label="Authentication method">
          <button
            type="button"
            role="tab"
            aria-selected={isOAuth}
            onClick={() => setMode('oauth')}
            className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${isOAuth ? 'bg-card text-foreground elev-card' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" /> OAuth
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isOAuth}
            onClick={() => setMode('api-key')}
            className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${!isOAuth ? 'bg-card text-foreground elev-card' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" /> API key
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border bg-background p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-primary">{isOAuth ? <LockKeyhole className="h-5 w-5" /> : <KeyRound className="h-5 w-5" />}</span>
          <div>
            <p className="text-sm font-medium text-foreground">{isOAuth ? 'Interactive OAuth' : 'Generated bearer key'}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {isOAuth
                ? 'Recommended. Your client discovers this server’s OAuth endpoints, opens Vercel sign-in, and stores its own scoped token.'
                : token
                  ? `Ready — browser key ending in …${remembered.last4}. Commands below include the full token.`
                  : 'No key is remembered in this browser. Generate one before copying API-key commands.'}
            </p>
          </div>
        </div>
        {!isOAuth && (token ? (
          <Button type="button" variant="ghost" size="sm" onClick={forget} className="shrink-0 gap-2 text-muted-foreground">
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Forget key
          </Button>
        ) : (
          <a href="/admin#api-keys" className="inline-flex h-8 shrink-0 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground">Generate key</a>
        ))}
      </div>

      <div className="mt-8">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span>Direct HTTP URL</span>
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 truncate rounded-xl border border-border bg-muted/60 px-4 py-3 font-mono text-sm text-foreground">{mcpUrl}</code>
          <CopyButton value={mcpUrl} label="Copy URL" className="shrink-0 gap-2" />
        </div>
      </div>

      <div className="mt-8">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span>Add to Claude Code</span>
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl border border-border bg-muted/60 px-4 py-3 font-mono text-sm text-foreground">{cliCommand}</code>
          <SecureCopyButton value={cliCommand} label="Copy command" hasCredential={canCopyAuthenticated} onMissing={() => setMissingKey(true)} />
        </div>
      </div>

      <div className="mt-8">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-sm font-medium text-foreground">.mcp.json</span>
          <SecureCopyButton value={mcpJson} label="Copy config" variant="outline" size="sm" hasCredential={canCopyAuthenticated} onMissing={() => setMissingKey(true)} />
        </div>
        <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-muted/60 p-4 font-mono text-sm leading-relaxed text-foreground"><code>{mcpJson}</code></pre>
      </div>

      <Dialog open={missingKey} onOpenChange={setMissingKey}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary" /> Generate an API key first</DialogTitle>
            <DialogDescription>
              API-key commands must contain a valid bearer token. Sign in, generate a key, then return here; the latest token will be remembered in this browser automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setMissingKey(false)}>Cancel</Button>
            <a href="/admin#api-keys" className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">Go to API keys</a>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
