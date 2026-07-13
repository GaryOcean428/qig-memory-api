import { z } from 'zod';
import { tool } from 'ai';
import {
  getMemory,
  putMemory,
  listMemory,
  deleteMemory,
  getKernelRegistry,
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
      'List memory records. Use keysOnly for a fast key index; optionally filter by category or key prefix.',
    schema: {
      category: z.string().optional().describe('Only return records in this category'),
      prefix: z.string().optional().describe('Only return keys starting with this prefix'),
      limit: z.number().int().min(1).max(1000).optional().describe('Page size (default 100)'),
      keysOnly: z.boolean().optional().describe('Skip content fetch and return keys only'),
    },
    execute: async (args) => listMemory(args),
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

/** Build the AI SDK tool map for the helper agent. */
export function buildAgentTools() {
  const tools = {};
  for (const [name, def] of Object.entries(toolDefs)) {
    tools[name] = tool({
      description: def.description,
      inputSchema: z.object(def.schema),
      execute: def.execute,
    });
  }
  return tools;
}
