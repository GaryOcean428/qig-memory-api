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
import {
  acknowledgeInboxMessage,
  listInboxMessages,
  readInboxMessage,
  sendInboxMessage,
  sweepInbox,
} from './inbox-store';
import {
  finalizeArtifact,
  getArtifactManifest,
  getArtifactRows,
  initiateArtifact,
} from './artifact-store';
import { askHelper } from './helper-agent';

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

  memory_post: {
    description:
      'Partially update a record: adjust usefulness score (delta or absolute), set source, mark promoted, or attach a basin vector. Does NOT replace content. Returns not_found if the key does not exist.',
    schema: {
      key: z.string().describe('Record key to update'),
      usefulness_delta: z.number().optional().describe('Add this to the current usefulness score'),
      usefulness_set: z.number().optional().describe('Set usefulness to this absolute value'),
      source: z.string().optional().describe('Set the provenance/source field'),
      promoted: z.boolean().optional().describe('Mark (or unmark) the record as promoted'),
      basin: z.array(z.number()).optional().describe('Attach/replace the basin simplex vector'),
    },
    execute: async ({ key, ...patch }) => (await postMemory(key, patch)) ?? { error: 'not_found', key },
  },

  memory_delete: {
    description: 'Delete a memory record by key.',
    schema: { key: z.string().describe('Record key to delete') },
    execute: async ({ key }) => ({ deleted: await deleteMemory(key), key }),
  },

  memory_search: {
    description:
      'Search the memory corpus. Filter by category / key-prefix / content substring (query). Provide a basin simplex vector to rank results by Fisher-Rao geodesic distance (nearest-basin recall — the geometrically correct QIG retrieval, NOT cosine).',
    schema: {
      query: z.string().optional().describe('Case-insensitive substring over key + content + source'),
      category: z.string().optional().describe('Restrict to this category'),
      prefix: z.string().optional().describe('Restrict to keys starting with this prefix'),
      basin: z
        .array(z.number())
        .optional()
        .describe('Query basin (simplex). When set, results are ranked by Fisher-Rao distance.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    execute: async (args) => searchMemory(args),
  },

  kernel_status: {
    description:
      'Return the kernel-mesh registry: registered agents, their substrates, and heartbeat status.',
    schema: {},
    execute: async () => {
      const map = await listKernelAgents();
      const agents = Object.entries(map).map(([id, a]) => ({
        agent_id: id,
        substrate: a.substrate,
        status: a.status,
        last_heartbeat: a.last_heartbeat,
        has_basin_coords: !!a.basin_coords,
      }));
      return { agent_count: agents.length, agents };
    },
  },

  kernel_sync: {
    description:
      'Return the full peer view of the kernel mesh. When agent_id is given and that agent has basin coordinates, includes the pairwise Fisher-Rao geodesic distance to every other agent that has coordinates.',
    schema: {
      agent_id: z.string().optional().describe('Compute Fisher-Rao distances relative to this agent'),
    },
    execute: async ({ agent_id }) => syncKernel(agent_id),
  },

  inbox_send: {
    description: 'Send a durable point-to-point or broadcast agent message. Discover usage guidance with helper_ask or qig://agent-helper.',
    requiredScope: 'memory:write',
    schema: {
      from: z.string().min(1).max(128),
      to: z.string().min(1).max(128),
      namespace: z.enum(['qig', 'bsuite', 'general']).default('general'),
      type: z.string().min(1).max(64),
      subject: z.string().min(1).max(256),
      payload: z.unknown(),
      in_reply_to: z.string().uuid().optional(),
      expires_at: z.string().datetime().optional(),
    },
    execute: sendInboxMessage,
  },
  inbox_list: {
    description: 'List durable inbox messages with lane, recipient, status, broadcast, cursor, and limit filters.',
    schema: {
      namespace: z.enum(['qig', 'bsuite', 'general']).optional(),
      recipient: z.string().optional(),
      status: z.enum(['unread', 'read', 'acked']).optional(),
      include_broadcast: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
    },
    execute: listInboxMessages,
  },
  inbox_read: {
    description: 'Read a globally addressed inbox message by UUID and mark unread messages read.',
    schema: { id: z.string().uuid(), mark_read: z.boolean().optional() },
    execute: async ({ id, mark_read }) => (await readInboxMessage(id, { markRead: mark_read !== false })) ?? { error: 'not_found', id },
  },
  inbox_ack: {
    description: 'Acknowledge a globally addressed inbox message. Idempotent.',
    requiredScope: 'memory:write',
    schema: { id: z.string().uuid() },
    execute: async ({ id }) => (await acknowledgeInboxMessage(id)) ?? { error: 'not_found', id },
  },
  inbox_sweep: {
    description: 'Delete expired inbox messages in a bounded cursor batch.',
    requiredScope: 'memory:write',
    schema: { limit: z.number().int().min(1).max(1000).optional(), cursor: z.string().optional() },
    execute: sweepInbox,
  },
  artifact_put: {
    description: 'Initiate a direct private Blob upload for raw little-endian Float32 [N,64] bytes. Bytes never pass through MCP.',
    requiredScope: 'memory:write',
    schema: {
      name: z.string(),
      version: z.string().optional(),
      cols: z.literal(64),
      row_count: z.number().int().positive(),
      sha256: z.string(),
    },
    execute: initiateArtifact,
  },
  artifact_finalize: {
    description: 'Verify exact size and SHA-256, publish an immutable artifact version, and broadcast artifact_updated.',
    requiredScope: 'memory:write',
    schema: { name: z.string(), version: z.string() },
    execute: async (args) => (await finalizeArtifact(args)) ?? { error: 'not_found', ...args },
  },
  artifact_manifest: {
    description: 'Read a published artifact manifest. Omit version for latest.',
    schema: { name: z.string(), version: z.string().optional() },
    execute: async ({ name, version }) => (await getArtifactManifest(name, version)) ?? { error: 'not_found', name, version },
  },
  artifact_get_rows: {
    description: 'Get a short-lived signed direct URL, authenticated proxy fallback, and exact Range header for [start,end) rows.',
    schema: {
      name: z.string(),
      version: z.string().optional(),
      start: z.number().int().min(0),
      end: z.number().int().positive(),
      origin: z.string().url().default('https://qig-memory-api.vercel.app'),
    },
    execute: getArtifactRows,
  },
  helper_ask: {
    description: 'Ask the read-only QIG helper agent how to use memory, inbox, artifacts, kernel, basin, REST, or MCP safely.',
    schema: {
      question: z.string().min(1).max(8000),
      context: z.string().max(8000).optional(),
    },
    execute: askHelper,
  },

  repo_lookup: {
    description:
      'Fetch a live snapshot of a GitHub repository: the 10 most recent commit subjects and up to 12 open issues (bug-labelled first). Read-only REST lookup — no clone, no code mutation. Accepts "owner/name" or separate owner + name.',
    schema: {
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, 'Use the "owner/name" form')
        .optional()
        .describe('Repository in "owner/name" form, e.g. "GaryOcean428/qig-core"'),
      owner: z.string().optional().describe('Repository owner (alternative to repo)'),
      name: z.string().optional().describe('Repository name (alternative to repo)'),
    },
    execute: async ({ repo, owner, name }) => {
      let o;
      let n;

      if (repo && (owner || name)) {
        const [repoOwner, repoName] = repo.split('/');
        if ((owner && owner !== repoOwner) || (name && name !== repoName)) {
          return {
            error: 'invalid_input',
            message:
              'Conflicting inputs: repo, owner, and name must refer to the same repository, or provide only repo or only owner + name.',
          };
        }
        o = repoOwner;
        n = repoName;
      } else if (repo) {
        [o, n] = repo.split('/');
      } else {
        o = owner;
        n = name;
      }

      if (!o || !n) {
        return { error: 'invalid_input', message: 'Provide repo="owner/name" or owner + name.' };
      }

      const { collectRepoSignals } = await import('./github-insights');
      return collectRepoSignals({ owner: o, name: n });
    },
  },
};

export const READ_ONLY_TOOL_NAMES = new Set([
  'memory_get',
  'memory_list',
  'memory_search',
  'kernel_status',
  'kernel_sync',
  'inbox_list',
  'inbox_read',
  'artifact_manifest',
  'artifact_get_rows',
  'repo_lookup',
]);

// Guarantee a tool result is a plain JSON value. Vercel Blob returns Date
// objects (e.g. `uploadedAt`) which fail the AI SDK's `JSONValue` schema on the
// follow-up model step (AI_InvalidPromptError). Round-tripping through JSON
// coerces Dates to ISO strings and strips any non-serialisable values.
function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

/** Build the AI SDK tool map for the helper agent. */
export function buildAgentTools({ readOnly = false } = {}) {
  const tools = {};
  for (const [name, def] of Object.entries(toolDefs)) {
    if (readOnly && !READ_ONLY_TOOL_NAMES.has(name)) continue;
    tools[name] = tool({
      description: def.description,
      inputSchema: z.object(def.schema),
      execute: async (args) => {
        // The helper's inbox inspection must remain observational: normal agent
        // reads mark messages read, while helper reads explicitly opt out.
        const safeArgs = readOnly && name === 'inbox_read' ? { ...args, mark_read: false } : args;
        return toPlainJson(await def.execute(safeArgs));
      },
    });
  }
  return tools;
}
