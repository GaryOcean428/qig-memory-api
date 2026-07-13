import { z } from 'zod';
import { tool } from 'ai';
import {
  getMemory,
  putMemory,
  postMemory,
  listMemory,
  searchMemory,
  deleteMemory,
  listKernelAgents,
  syncKernel,
} from './memory-store';

// Single source of truth for the QIG toolset. Both the helper-agent
// (AI SDK `tool`) and the MCP server (`server.registerTool`) are built from
// these definitions so the two surfaces never drift apart.
//
// Each def: { description, schema (Zod raw shape), execute(args) -> JSON }.
export const toolDefs = {
  memory_get: {
    description: 'Read a single memory record by its key.',
    schema: { key: z.string().describe('Record key, e.g. "kernel_registry"') },
    execute: async ({ key }) => (await getMemory(key)) ?? { error: 'not_found', key },
  },

  memory_list: {
    description:
      'List memory records. To safely enumerate EVERYTHING, use keysOnly=true — it returns the complete, auto-paginated key index in a single call (no cursor loop, no missed records). For full content, results are paginated: when the response has has_more=true, call again with the returned cursor to get the next page, or pass all=true to fetch every page at once. Optionally filter by category or key prefix.',
    schema: {
      category: z.string().optional().describe('Only return records in this category'),
      prefix: z.string().optional().describe('Only return keys starting with this prefix'),
      limit: z.number().int().min(1).max(1000).optional().describe('Content page size (default 100)'),
      keysOnly: z
        .boolean()
        .optional()
        .describe('Return the complete key index (auto-paginated). Best for enumerating all keys.'),
      cursor: z
        .string()
        .optional()
        .describe('Continue a content listing from a previous page (use the cursor from has_more).'),
      all: z
        .boolean()
        .optional()
        .describe('Fetch every content page in one call instead of paging manually.'),
    },
    execute: async (args) => {
      const res = await listMemory(args);
      // Inline, self-describing pagination signal shared by BOTH the MCP server
      // and the in-app agent. Agents routinely stop at the first page when
      // has_more is buried in metadata; an explicit next-step hint (with the
      // exact cursor to reuse) removes the guesswork.
      if (res.has_more) {
        res._pagination = {
          has_more: true,
          next_cursor: res.cursor,
          hint: `More records exist. Call memory_list again with cursor="${res.cursor}" (or pass all=true) to continue. For a full key index, use keysOnly=true.`,
        };
      }
      return res;
    },
  },

  memory_put: {
    description:
      'Create or update a memory record. Scoring fields (usefulness, retrieval_count) are preserved when omitted.',
    schema: {
      key: z.string().describe('Record key to write'),
      content: z.string().describe('The record content'),
      category: z.string().optional().describe('Category label (default "uncategorized")'),
      source: z.string().optional().describe('Provenance of this record'),
    },
    execute: async (args) => putMemory(args.key, args),
  },

  memory_delete: {
    description: 'Delete a memory record by key.',
    schema: { key: z.string().describe('Record key to delete') },
    execute: async ({ key }) => ({ deleted: await deleteMemory(key), key }),
  },

  kernel_status: {
    description:
      'Return the kernel-mesh registry: registered agents, their substrates, and heartbeat status.',
    schema: {},
    execute: async () => {
      const reg = await getKernelRegistry();
      const agents = Object.entries(reg.agents || {}).map(([id, a]) => ({
        agent_id: id,
        substrate: a.substrate,
        status: a.status,
        last_heartbeat: a.last_heartbeat,
        has_basin_coords: !!a.basin_coords,
      }));
      return { updated: reg.updated, agent_count: agents.length, agents };
    },
  },
};

// Guarantee a tool result is a plain JSON value. Vercel Blob returns Date
// objects (e.g. `uploadedAt`) which fail the AI SDK's `JSONValue` schema on the
// follow-up model step (AI_InvalidPromptError). Round-tripping through JSON
// coerces Dates to ISO strings and strips any non-serialisable values.
function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

/** Build the AI SDK tool map for the helper agent. */
export function buildAgentTools() {
  const tools = {};
  for (const [name, def] of Object.entries(toolDefs)) {
    tools[name] = tool({
      description: def.description,
      inputSchema: z.object(def.schema),
      execute: async (args) => toPlainJson(await def.execute(args)),
    });
  }
  return tools;
}
