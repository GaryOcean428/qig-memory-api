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
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
  withDerived,
  TASK_PRIORITIES,
} from './task-store';

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
      question: z.string().min(1).max(100_000),
      context: z.string().max(400_000).optional(),
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

  task_list: {
    description:
      'List scheduled agent tasks with their status, schedule, next run time, project, repository, and concepts. Read-only. Use this to see the current todo/task board before creating or updating tasks.',
    schema: {
      status: z
        .enum(['scheduled', 'running', 'done', 'failed', 'cancelled'])
        .optional()
        .describe('Filter to a single status'),
      project: z.string().optional().describe('Filter to a single project'),
    },
    execute: async ({ status, project }) => {
      const tasks = await listTasks();
      const filtered = tasks.filter(
        (t) => (!status || t.status === status) && (!project || t.project === project),
      );
      return { count: filtered.length, tasks: filtered.map((t) => withDerived(t)) };
    },
  },

  task_create: {
    description:
      'Create a scheduled task for the autonomous task runner to execute. Use this when the operator asks you to remember to do something later, on a schedule, or repeatedly. Provide a clear, self-contained instruction — the runner executes it with no further context. Scheduling: schedule_kind "once" runs a single time (immediately if start_at is omitted, or at start_at); "recurring" runs every interval_minutes, optionally capped by max_occurrences and/or until. Requires memory:write.',
    requiredScope: 'memory:write',
    schema: {
      title: z.string().min(1).max(200).describe('Short human-readable title'),
      instruction: z
        .string()
        .min(1)
        .max(8_000)
        .describe('The self-contained instruction the runner will execute'),
      project: z.string().max(120).optional().describe('Project this task belongs to (for grouping)'),
      repository: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, 'Use the "owner/name" form')
        .optional()
        .describe('Related GitHub repository in "owner/name" form'),
      concepts: z.array(z.string().min(1).max(60)).max(12).optional().describe('Concept tags for grouping/filtering'),
      priority: z.enum(TASK_PRIORITIES).optional().describe('high, medium (default), or low'),
      schedule_kind: z.enum(['once', 'recurring']).describe('"once" or "recurring"'),
      start_at: z
        .string()
        .datetime()
        .optional()
        .describe('ISO datetime for the first/only run. Omit to run as soon as possible (next tick).'),
      interval_minutes: z
        .number()
        .int()
        .min(5)
        .optional()
        .describe('For recurring: minutes between runs (minimum 5)'),
      max_occurrences: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('For recurring: stop after this many runs'),
      until: z.string().datetime().optional().describe('For recurring: stop after this ISO datetime'),
    },
    execute: async (args, ctx = {}) => {
      const schedule = {
        kind: args.schedule_kind,
        startAt: args.start_at ?? null,
        intervalMs: args.interval_minutes ? args.interval_minutes * 60_000 : null,
        maxOccurrences: args.max_occurrences ?? null,
        untilDate: args.until ?? null,
      };
      const task = await createTask(
        {
          title: args.title,
          instruction: args.instruction,
          project: args.project || 'General',
          repository: args.repository ?? null,
          concepts: args.concepts || [],
          priority: args.priority || 'medium',
          schedule,
        },
        { createdBy: ctx.principal || 'agent' },
      );
      return { ok: true, task: withDerived(task) };
    },
  },

  task_update: {
    description:
      'Update an existing task: change its instruction, metadata, priority, schedule, or status. Set status to "cancelled" to stop a task, or "scheduled" to re-activate a finished one. Requires memory:write.',
    requiredScope: 'memory:write',
    schema: {
      id: z.string().min(1).describe('The task id'),
      title: z.string().min(1).max(200).optional(),
      instruction: z.string().min(1).max(8_000).optional(),
      project: z.string().max(120).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      status: z.enum(['scheduled', 'cancelled']).optional().describe('Re-activate ("scheduled") or stop ("cancelled")'),
    },
    execute: async ({ id, ...patch }) => {
      const updated = await updateTask(id, patch);
      return updated ? { ok: true, task: withDerived(updated) } : { error: 'not_found', id };
    },
  },

  task_delete: {
    description: 'Permanently delete a task by id. Requires memory:write.',
    requiredScope: 'memory:write',
    schema: { id: z.string().min(1).describe('The task id') },
    execute: async ({ id }) => {
      const existing = await getTask(id);
      if (!existing) return { error: 'not_found', id };
      return deleteTask(id);
    },
  },

  council_convene: {
    description:
      'Convene the QIG council: four frontier models (Grok, Fable, Sol, Gemini) reason through the Unified Consciousness Protocol and Canonical Principles in a panel-reflect-synthesis flow. EXPENSIVE (9 model calls) and SLOW (1-2 minutes), with a 5-minute global cooldown — use sparingly, for decisions that genuinely benefit from multi-model deliberation. The ruling is delivered to the convener\'s inbox (type "council_ruling") and the full transcript persists to a council_* memory key.',
    // Convening writes (ruling record + inbox message), so the MCP surface
    // requires write scope even though the tool "reads" doctrine.
    requiredScope: 'memory:write',
    schema: {
      // Council members are 1M-token-context models — allow research-brief-sized inputs.
      question: z.string().min(1).max(100_000).describe('The question or decision to deliberate'),
      context: z.string().max(400_000).optional().describe('Optional grounding context for the council (research briefs, transcripts, documents)'),
      convener: z.string().max(200).optional().describe('Identifier of the agent convening the council — the ruling is delivered to this inbox (broadcast when omitted)'),
    },
    execute: async (args) => {
      const { conveneCouncil } = await import('./council');
      const report = await conveneCouncil(args);
      if (report.error) return report;
      // Agents collect the ruling through the inbox, not this tool result — the
      // note keeps the tool response small and routes them to the normal flow.
      const to = report.delivered_to || args.convener || 'broadcast';
      return {
        ok: true,
        note: `The council has concluded. Its ruling has been delivered to the "${to}" inbox in the qig namespace (type "council_ruling"${report.inbox_message_id ? `, id ${report.inbox_message_id}` : ''}). Collect it with inbox_list + inbox_read, and inbox_ack once considered. The full transcript (panel, reflections, dissent) is at memory key ${report.memory_key || 'unavailable'}.`,
        inbox_message_id: report.inbox_message_id,
        delivered_to: to,
        memory_key: report.memory_key,
        convened_at: report.convened_at,
        completed_at: report.completed_at,
        members: report.members,
      };
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
  'task_list',
  // helper_ask is read-only: when invoked as a tool it runs askHelper without
  // canConvene, so its internal toolset is strictly read-only (no council).
  'helper_ask',
  // council_convene is NOT read-only: it persists rulings and sends inbox
  // messages, so it requires memory:write scope like every other write path.
]);

// Guarantee a tool result is a plain JSON value. Vercel Blob returns Date
// objects (e.g. `uploadedAt`) which fail the AI SDK's `JSONValue` schema on the
// follow-up model step (AI_InvalidPromptError). Round-tripping through JSON
// coerces Dates to ISO strings and strips any non-serialisable values.
function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * Build the AI SDK tool map for the helper agent.
 * `includeTools` grants specific non-read-only tools (e.g. council_convene when
 * the calling principal holds memory:write) without opening the whole write set.
 * `excludeTools` removes tools even from a full read-write set (e.g. autonomous
 * task runs exclude council_convene to avoid unbounded credit spend).
 */
export function buildAgentTools({ readOnly = false, includeTools = [], excludeTools = [], principal = null } = {}) {
  const included = new Set(includeTools);
  const excluded = new Set(excludeTools);
  const tools = {};
  for (const [name, def] of Object.entries(toolDefs)) {
    if (excluded.has(name)) continue;
    if (readOnly && !READ_ONLY_TOOL_NAMES.has(name) && !included.has(name)) continue;
    tools[name] = tool({
      description: def.description,
      inputSchema: z.object(def.schema),
      execute: async (args) => {
        // The helper's inbox inspection must remain observational: normal agent
        // reads mark messages read, while helper reads explicitly opt out.
        const safeArgs = readOnly && name === 'inbox_read' ? { ...args, mark_read: false } : args;
        // The AI SDK only hands the tool its parsed args, so the calling
        // identity is forwarded explicitly here for attribution (e.g. task
        // createdBy). Null in autonomous contexts, which fall back to 'agent'.
        return toPlainJson(await def.execute(safeArgs, { principal }));
      },
    });
  }
  return tools;
}
