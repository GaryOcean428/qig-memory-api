import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { toolDefs } from '../../../lib/qig-tools';
import { authenticate, hasScope, unauthorizedReason } from '../../../lib/auth.js';
import { currentPrincipal, withPrincipal } from '../../../lib/auth-context.js';

// Streamable-HTTP MCP server exposing the QIG toolset. Built from the SAME
// `toolDefs` the helper agent uses, so the MCP surface and the in-app agent can
// never drift. The connector URL shown on the home page points here (/api/mcp).
//
// basePath "/api" => this handler serves the streamable-HTTP endpoint at /api/mcp.
const handler = createMcpHandler(
  (server) => {
    for (const [name, def] of Object.entries(toolDefs)) {
      server.registerTool(
        name,
        {
          description: def.description,
          inputSchema: z.object(def.schema),
        },
        async (args) => {
          try {
            const principal = currentPrincipal();
            const requiredScope = name === 'memory_delete'
              ? 'memory:admin'
              : ['memory_put', 'memory_post'].includes(name)
                ? 'memory:write'
                : 'memory:read';
            if (!hasScope(principal, requiredScope)) {
              throw new Error(`insufficient_scope: ${requiredScope} required`);
            }
            const result = await def.execute(args ?? {});
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Error running ${name}: ${err?.message || err}` }],
            };
          }
        },
      );
    }
  },
  {
    serverInfo: { name: 'qig-memory-api', version: '0.2.0' },
    instructions:
      'QIG Memory API MCP server. Tools operate a blob-backed memory store and the Fisher-Rao kernel mesh registry.',
  },
  { basePath: '/api' },
);

export const maxDuration = 60;

// The MCP tools operate the SAME memory store as the REST API, so the endpoint
// must enforce the SAME bearer auth — otherwise it is a full bypass of the
// store's security. Clients send `Authorization: Bearer <QIG_API_KEY>`.
function withAuth(fn) {
  return async (req) => {
    const principal = await authenticate(req, { allowOAuth: true });
    if (!principal || !hasScope(principal, 'memory:read')) {
      const origin = new URL(req.url).origin;
      const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
      return new Response(
        JSON.stringify({ error: 'unauthorized', reason: await unauthorizedReason() }),
        {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': `Bearer resource_metadata="${metadataUrl}"`,
          },
        },
      );
    }
    return withPrincipal(principal, () => fn(req));
  };
}

const authedHandler = withAuth(handler);

export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };
