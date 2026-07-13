import { createMcpHandler } from 'mcp-handler';
import { toolDefs } from '../../../lib/qig-tools';

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
          inputSchema: def.schema,
        },
        async (args) => {
          try {
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

export { handler as GET, handler as POST, handler as DELETE };
