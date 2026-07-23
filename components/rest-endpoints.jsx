import { StatusBadge } from '@bsuite/ui';

const METHOD_TONE = {
  GET: 'success',
  POST: 'info',
  PUT: 'warning',
  DELETE: 'destructive',
  ALL: 'neutral',
};

const ENDPOINTS = [
  { methods: ['GET'], path: '/api/memory', desc: 'List records (pagination, keys_only, prefix, category filters).' },
  { methods: ['GET', 'PUT', 'POST', 'DELETE'], path: '/api/memory/[key]', desc: 'Read, upsert, partial-update (scoring) and delete a record.' },
  { methods: ['GET', 'POST'], path: '/api/kernel', desc: 'Bootstrap doc, plus register / heartbeat / sync for the mesh.' },
  { methods: ['GET', 'POST'], path: '/api/coordize', desc: 'RETIRED — Modal GPU coordizer decommissioned. Always returns 410 Gone, no auth required.' },
  { methods: ['ALL'], path: '/api/mcp', desc: 'Streamable-HTTP MCP server exposing memory + kernel tools.' },
];

export function RestEndpoints() {
  return (
    <div id="rest" className="scroll-mt-24">
      <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
        REST Endpoints
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        The original REST API remains fully functional. All routes are bearer-token protected.
      </p>
      <ul className="mt-6 flex flex-col gap-3">
        {ENDPOINTS.map((ep) => (
          <li
            key={ep.path}
            className="elev-card elev-card-interactive rounded-xl border border-border bg-card p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              {ep.methods.map((m) => (
                <StatusBadge key={m} tone={METHOD_TONE[m] ?? 'neutral'}>
                  {m}
                </StatusBadge>
              ))}
              <code className="font-mono text-sm font-medium text-foreground">{ep.path}</code>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{ep.desc}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
