'use client';

import { useEffect, useMemo, useState } from 'react';
import { StatusBadge } from '@bsuite/ui';
import { Plug, Terminal } from 'lucide-react';
import { CopyButton } from '@/components/copy-button';

const FALLBACK_ORIGIN = 'https://qig-memory-api.vercel.app';

const PLATFORMS = [
  'Claude Code',
  'Grok Build',
  'Cursor',
  'Codex CLI',
  'grok.com Connectors',
  'claude.ai',
];

export function McpConnector() {
  // Render the canonical production URL on the server, then swap to the live
  // origin after mount. Initialising from window here would desync SSR/CSR
  // markup and trip a hydration mismatch, so we start from the fallback.
  const [origin, setOrigin] = useState(FALLBACK_ORIGIN);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setOrigin(window.location.origin);
    }
  }, []);

  const mcpUrl = `${origin}/api/mcp`;

  const mcpJson = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            'qig-memory': {
              url: mcpUrl,
              description: 'QIG Persistent Memory + Kernel Mesh for Pantheon agents',
            },
          },
        },
        null,
        2,
      ),
    [mcpUrl],
  );

  return (
    <div
      id="connect"
      className="elev-card scroll-mt-24 rounded-2xl border border-border bg-card p-6 sm:p-8"
    >
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Plug className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              Connect via MCP
            </h2>
            <StatusBadge tone="success">Live</StatusBadge>
          </div>
          <p className="mt-1.5 text-pretty text-sm leading-relaxed text-muted-foreground">
            A Model Context Protocol server exposing the memory store and kernel mesh as tools.
            Drop the URL into any MCP-capable client.
          </p>
        </div>
      </div>

      {/* Supported platforms */}
      <div className="mt-6 flex flex-wrap gap-2">
        {PLATFORMS.map((p) => (
          <StatusBadge key={p} tone="info">
            {p}
          </StatusBadge>
        ))}
      </div>

      {/* Direct HTTP URL */}
      <div className="mt-8">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <span>Direct HTTP URL — for agents &amp; CLIs</span>
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 truncate rounded-xl border border-border bg-muted/60 px-4 py-3 font-mono text-sm text-foreground">
            {mcpUrl}
          </code>
          <CopyButton value={mcpUrl} label="Copy URL" className="shrink-0 gap-2" />
        </div>
      </div>

      {/* .mcp.json */}
      <div className="mt-8">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-sm font-medium text-foreground">.mcp.json</span>
          <CopyButton
            value={mcpJson}
            label="Copy config"
            variant="outline"
            size="sm"
            className="gap-2"
          />
        </div>
        <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-muted/60 p-4 font-mono text-sm leading-relaxed text-foreground">
          <code>{mcpJson}</code>
        </pre>
      </div>
    </div>
  );
}
