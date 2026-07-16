import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { annotationsFor, toolDefs, READ_ONLY_TOOL_NAMES } from '../../../lib/qig-tools';
import { authenticate, hasScope, unauthorizedReason } from '../../../lib/auth.js';
import { currentPrincipal, withPrincipal } from '../../../lib/auth-context.js';
import { HELPER_GUIDE, HELPER_RESOURCE_URI } from '../../../lib/helper-agent.js';

// Streamable-HTTP MCP server exposing the QIG toolset. Built from the SAME
// `toolDefs` the helper agent uses, so the MCP surface and the in-app agent can
// never drift. The connector URL shown on the home page points here (/api/mcp).
//
// basePath "/api" => this handler serves the streamable-HTTP endpoint at /api/mcp.
const handler = createMcpHandler(
  (server) => {
    server.registerResource(
      'agent-helper',
      HELPER_RESOURCE_URI,
      {
        title: 'QIG Agent Helper',
        description: 'Canonical setup, tool-selection, namespace, artifact, geometry, security, and recovery guidance.',
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: HELPER_GUIDE }],
      }),
    );

    for (const [name, def] of Object.entries(toolDefs)) {
      server.registerTool(
        name,
        {
          title: def.title,
          description: def.description,
          inputSchema: z.object(def.schema),
          // Hosts use these to decide auto-permissions: a read-only tool can run
          // without a per-call prompt, a destructive one always prompts. Without
          // them every tool — even memory_get — prompts on every call, and
          // Claude's connector review rejects the server outright.
          annotations: annotationsFor(name),
        },
        async (args) => {
          try {
            const principal = currentPrincipal();
            // Explicit requiredScope wins; memory_delete is admin; anything not
            // in the read-only set mutates state and therefore needs write.
            const requiredScope =
              def.requiredScope ||
              (name === 'memory_delete'
                ? 'memory:admin'
                : READ_ONLY_TOOL_NAMES.has(name)
                  ? 'memory:read'
                  : 'memory:write');
            if (!hasScope(principal, requiredScope)) {
              throw new Error(`insufficient_scope: ${requiredScope} required`);
            }
            // Forward the caller identity for attribution (e.g. task createdBy).
            const label = principal?.label || principal?.sub || principal?.name || 'api';
            const result = await def.execute(args ?? {}, { principal: label });
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
      'QIG Memory API MCP server. Tools operate a blob-backed memory store and the Fisher-Rao kernel mesh registry, plus read-only GitHub and web research lookups.',
  },
  { basePath: '/api' },
);

// council_convene runs a 3-phase multi-model deliberation (1-2 minutes); the MCP
// surface must outlive it. All other tools remain fast.
export const maxDuration = 300;

// The MCP tools operate the SAME memory store as the REST API, so the endpoint
// must enforce the SAME bearer auth — otherwise it is a full bypass of the
// store's security. Clients send `Authorization: Bearer <token>` (an API key or
// an OAuth access token).
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
