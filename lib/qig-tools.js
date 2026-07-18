import { z } from 'zod';
import { tool } from 'ai';
import { after } from 'next/server';
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
// Each def:
//   title        Human-readable name. REQUIRED — MCP hosts show it, and Claude's
//                connector review criteria reject tools without one.
//   description  What the tool does and when to call it.
//   schema       Zod raw shape.
//   execute      (args, ctx) -> JSON.
//   requiredScope  Optional; defaults are derived in the MCP route.
//   destructive  Optional; true when the tool deletes or irreversibly discards
//                data. Drives destructiveHint (hosts always prompt for these).
//   openWorld    Optional; true when the tool reaches the public internet rather
//                than this service's own closed store. Drives openWorldHint.
//   idempotent   Optional; true when repeating the same call is a no-op.
//
// Read-only-ness is declared once in READ_ONLY_TOOL_NAMES (below) because the
// helper agent and the MCP scope check both already consume it.
// Multi-record results (list + search) project each record down to a preview
// instead of its full content. A single default memory_list used to return
// ~174k characters (~43k tokens — a fifth of a 200k context window) because it
// inlined the content of 100 records; a search for three matches cost ~6k
// tokens for the same reason. An agent listing or searching wants to know WHAT
// EXISTS so it can choose; it then reads the ones it wants with memory_get.
// Full content stays one `includeContent: true` away, and memory_get /
// memory_post are unchanged.
//
// This projection lives in the TOOL layer on purpose: listMemory/searchMemory
// are shared with the REST API, the admin UI, and the daily reviewer, all of
// which legitimately want whole records. Only the model-facing surface is trimmed.
const PREVIEW_CHARS = 160;
const SNIPPET_PAD = 70;

// Preview centred on the first matching term, so a hit deep inside a 16k-char
// document is actually visible. Falls back to the head of the content.
function previewOf(content, terms = []) {
  const text = String(content || '');
  if (!text) return '';
  let start = 0;
  if (terms.length) {
    const hay = text.toLowerCase();
    const at = terms.map((t) => hay.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (at !== undefined && at > SNIPPET_PAD) start = at - SNIPPET_PAD;
  }
  const slice = text.slice(start, start + (start ? SNIPPET_PAD * 2 : PREVIEW_CHARS));
  return `${start ? '…' : ''}${slice.replace(/\s+/g, ' ').trim()}${start + slice.length < text.length ? '…' : ''}`;
}

function projectRecord(record, terms) {
  if (!record || record._error) return record;
  const { content, basin, ...rest } = record;
  return {
    ...rest,
    content_chars: String(content ?? '').length,
    has_basin: Array.isArray(basin) && basin.length > 0,
    preview: previewOf(content, terms),
  };
}

export const toolDefs = {
  memory_get: {
    title: 'Get Memory Record',
    description: 'Read a single memory record by its key.',
    schema: { key: z.string().describe('Record key, e.g. "kernel_registry"') },
    execute: async ({ key }) => (await getMemory(key)) ?? { error: 'not_found', key },
  },

  memory_list: {
    title: 'List Memory Records',
    description:
      'Browse memory records. Returns metadata plus a short preview per record — NOT full content; read a specific record with memory_get, or pass includeContent=true to inline content (large). Prefer memory_search when you know what you are looking for. keysOnly=true returns just the key index: it is the complete list but the corpus is large (~1800 keys), so treat it as an expensive call. Paginate with the returned cursor when has_more=true; all=true walks every page in one call. Optionally filter by category or key prefix.',
    schema: {
      category: z.string().optional().describe('Only return records in this category'),
      prefix: z.string().optional().describe('Only return keys starting with this prefix'),
      limit: z.number().int().min(1).max(1000).optional().describe('Content page size (default 100)'),
      keysOnly: z
        .boolean()
        .optional()
        .describe('Return only the key index (complete + auto-paginated). Expensive: the corpus has ~1800 keys.'),
      includeContent: z
        .boolean()
        .optional()
        .describe('Inline each record\'s full content instead of a preview. Large — prefer memory_get for specific records.'),
      cursor: z
        .string()
        .optional()
        .describe('Continue a content listing from a previous page (use the cursor from has_more).'),
      all: z
        .boolean()
        .optional()
        .describe('Fetch every content page in one call instead of paging manually.'),
    },
    execute: async ({ includeContent, ...args }) => {
      const res = await listMemory(args);
      // keysOnly: return bare key strings. The store hands back
      // {key, uploaded_at, size} per record, which for ~1800 keys is a bigger
      // payload than the full-content page it is supposed to be cheaper than.
      if (args.keysOnly && Array.isArray(res.records)) {
        return {
          keys: res.records.map((r) => r.key),
          key_count: res.key_count ?? res.records.length,
          complete: res.complete,
          has_more: res.has_more,
          cursor: res.cursor,
        };
      }
      if (!includeContent && Array.isArray(res.records)) {
        res.records = res.records.map((r) => projectRecord(r, []));
        res._projection = 'Previews only. Use memory_get for a record\'s full content, or memory_list(includeContent=true) to inline it.';
      }
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
    title: 'Create or Update Memory Record',
    description:
      'Create or update a memory record. Scoring fields (usefulness, retrieval_count) are preserved when omitted.',
    idempotent: true,
    schema: {
      key: z.string().describe('Record key to write'),
      content: z.string().describe('The record content'),
      category: z.string().optional().describe('Category label (default "uncategorized")'),
      source: z.string().optional().describe('Provenance of this record'),
    },
    execute: async (args) => putMemory(args.key, args),
  },

  memory_post: {
    title: 'Patch Memory Record Metadata',
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
    title: 'Delete Memory Record',
    description: 'Permanently delete a memory record by key. This cannot be undone.',
    destructive: true,
    idempotent: true,
    schema: { key: z.string().describe('Record key to delete') },
    execute: async ({ key }) => ({ deleted: await deleteMemory(key), key }),
  },

  memory_search: {
    title: 'Search Memory',
    description:
      'Search the memory corpus — the best first move when looking for something. A multi-word query matches records containing EVERY term; wrap a phrase in double quotes for an exact match. Returns metadata plus a snippet centred on the match; read the full record with memory_get, or pass includeContent=true. Provide a basin simplex vector to rank results by Fisher-Rao geodesic distance (nearest-basin recall — the geometrically correct QIG retrieval, NOT cosine).',
    schema: {
      query: z
        .string()
        .optional()
        .describe('Case-insensitive terms matched over key + content + source. All terms must be present; use "quoted text" for an exact phrase.'),
      includeContent: z
        .boolean()
        .optional()
        .describe('Inline each match\'s full content instead of a snippet. Large — prefer memory_get.'),
      category: z.string().optional().describe('Restrict to this category'),
      prefix: z.string().optional().describe('Restrict to keys starting with this prefix'),
      basin: z
        .array(z.number())
        .optional()
        .describe('Query basin (simplex). When set, results are ranked by Fisher-Rao distance.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    execute: async ({ includeContent, ...args }) => {
      const res = await searchMemory(args);
      if (!includeContent && Array.isArray(res.results)) {
        const { parseSearchTerms } = await import('./memory-store');
        const terms = parseSearchTerms(args.query);
        res.results = res.results.map((r) => projectRecord(r, terms));
        res._projection = 'Snippets only. Use memory_get for a record\'s full content, or memory_search(includeContent=true) to inline it.';
      }
      return res;
    },
  },

  kernel_status: {
    title: 'Kernel Mesh Status',
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
    title: 'Kernel Mesh Peer View',
    description:
      'Return the full peer view of the kernel mesh. When agent_id is given and that agent has basin coordinates, includes the pairwise Fisher-Rao geodesic distance to every other agent that has coordinates.',
    schema: {
      agent_id: z.string().optional().describe('Compute Fisher-Rao distances relative to this agent'),
    },
    execute: async ({ agent_id }) => syncKernel(agent_id),
  },

  inbox_send: {
    title: 'Send Inbox Message',
    description:
      'Send a durable point-to-point or broadcast agent message. Namespaces are qig, bsuite, or general; set to="broadcast" for a broadcast.',
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
    title: 'List Inbox Messages',
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
    title: 'Read Inbox Message',
    description: 'Read a globally addressed inbox message by UUID and mark unread messages read.',
    schema: { id: z.string().uuid(), mark_read: z.boolean().optional() },
    execute: async ({ id, mark_read }) => (await readInboxMessage(id, { markRead: mark_read !== false })) ?? { error: 'not_found', id },
  },
  inbox_ack: {
    title: 'Acknowledge Inbox Message',
    description: 'Acknowledge a globally addressed inbox message. Idempotent.',
    requiredScope: 'memory:write',
    idempotent: true,
    schema: { id: z.string().uuid() },
    execute: async ({ id }) => (await acknowledgeInboxMessage(id)) ?? { error: 'not_found', id },
  },
  inbox_sweep: {
    title: 'Sweep Expired Inbox Messages',
    description: 'Permanently delete expired inbox messages in a bounded cursor batch. This cannot be undone.',
    requiredScope: 'memory:write',
    destructive: true,
    schema: { limit: z.number().int().min(1).max(1000).optional(), cursor: z.string().optional() },
    execute: sweepInbox,
  },
  artifact_put: {
    title: 'Initiate Artifact Upload',
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
    title: 'Finalize Artifact Version',
    description: 'Verify exact size and SHA-256, publish an immutable artifact version, and broadcast artifact_updated.',
    requiredScope: 'memory:write',
    schema: { name: z.string(), version: z.string() },
    execute: async (args) => (await finalizeArtifact(args)) ?? { error: 'not_found', ...args },
  },
  artifact_manifest: {
    title: 'Read Artifact Manifest',
    description: 'Read a published artifact manifest. Omit version for latest.',
    schema: { name: z.string(), version: z.string().optional() },
    execute: async ({ name, version }) => (await getArtifactManifest(name, version)) ?? { error: 'not_found', name, version },
  },
  artifact_get_rows: {
    title: 'Get Artifact Rows',
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
    title: 'Ask QIG Helper Agent',
    description: 'Ask the read-only QIG helper agent how to use memory, inbox, artifacts, kernel, basin, REST, or MCP safely.',
    schema: {
      question: z.string().min(1).max(100_000),
      context: z.string().max(400_000).optional(),
    },
    execute: askHelper,
  },

  repo_lookup: {
    title: 'GitHub Repository Snapshot',
    description:
      'Fetch a live snapshot of a GitHub repository (https://docs.github.com/rest): the 10 most recent commit subjects and up to 12 open issues (bug-labelled first). Read-only REST lookup — no clone, no code mutation. Accepts "owner/name" or separate owner + name.',
    openWorld: true,
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

  github_search: {
    title: 'Search GitHub',
    description:
      'Search GitHub code, issues, pull requests, repositories, or commits using GitHub search syntax (https://docs.github.com/search-github/searching-on-github). Qualifiers such as repo:owner/name, org:, label:, language:, and is:open are passed through verbatim. Read-only. Code search requires a configured GitHub token.',
    openWorld: true,
    schema: {
      query: z
        .string()
        .min(1)
        .max(500)
        .describe('GitHub search query, e.g. "repo:GaryOcean428/qig-memory-api privateBlobOptions" or "org:GaryOcean428 is:open label:bug"'),
      type: z
        .enum(['code', 'issues', 'repositories', 'commits'])
        .optional()
        .describe('Which search endpoint to use (default "code"). "issues" also covers pull requests.'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 10)'),
    },
    execute: async (args) => {
      const { searchGithub } = await import('./github-insights');
      return searchGithub(args);
    },
  },

  github_file_read: {
    title: 'Read GitHub File',
    description:
      'Read the text contents of a single file in a GitHub repository at an optional ref/branch/tag, or list a directory (https://docs.github.com/rest/repos/contents). Read-only — never writes. Large files are truncated; binary files are rejected.',
    openWorld: true,
    schema: {
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, 'Use the "owner/name" form')
        .describe('Repository in "owner/name" form'),
      path: z.string().min(1).max(400).describe('File or directory path within the repository, e.g. "lib/private-blob.js"'),
      ref: z.string().max(200).optional().describe('Branch, tag, or commit SHA (default: the repository default branch)'),
    },
    execute: async ({ repo, path, ref }) => {
      const [owner, name] = String(repo).split('/');
      const { readGithubFile } = await import('./github-insights');
      return readGithubFile({ owner, name, path, ref });
    },
  },

  web_search: {
    title: 'Search the Web',
    description:
      'Search the live web via the Tavily API (https://docs.tavily.com) and return ranked sources with titles, URLs, and content snippets to cite. Use for current information beyond the memory corpus — upstream docs, releases, standards, news. Read-only.',
    openWorld: true,
    schema: {
      query: z.string().min(1).max(400).describe('Search query. Keep it short and focused; split complex questions into separate searches.'),
      max_results: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
      search_depth: z
        .enum(['basic', 'advanced'])
        .optional()
        .describe('"advanced" gives better relevance at ~2s extra latency (default "basic")'),
      topic: z.enum(['general', 'news', 'finance']).optional().describe('Search topic (default "general")'),
      time_range: z.enum(['day', 'week', 'month', 'year']).optional().describe('Restrict results to a recent window'),
      include_domains: z.array(z.string()).max(20).optional().describe('Only return results from these domains'),
      exclude_domains: z.array(z.string()).max(20).optional().describe('Never return results from these domains'),
      include_raw_content: z
        .boolean()
        .optional()
        .describe('Also return trimmed full page content for each result (larger response)'),
    },
    execute: async (args) => {
      const { webSearch } = await import('./web-research');
      return webSearch(args);
    },
  },

  web_extract: {
    title: 'Extract Web Page Content',
    description:
      'Extract the full readable content of up to 5 specific URLs via the Tavily API (https://docs.tavily.com). Use after web_search when a snippet is not enough. Read-only. Content is returned as markdown and truncated when very large.',
    openWorld: true,
    schema: {
      urls: z.array(z.string().url()).min(1).max(5).describe('The URLs to extract (max 5)'),
      extract_depth: z
        .enum(['basic', 'advanced'])
        .optional()
        .describe('"advanced" retrieves more of complex pages at extra latency (default "basic")'),
      query: z.string().max(400).optional().describe('Optional query used to rerank the extracted content chunks'),
    },
    execute: async (args) => {
      const { webExtract } = await import('./web-research');
      return webExtract(args);
    },
  },

  doctrine_status: {
    title: 'QIG Doctrine Status',
    description:
      'Report the CURRENT canonical QIG doctrine and whether it is in sync with the experiment registries. Returns the live frozen-facts edition (version + date — always the newest; never cite an older one), the integrity dashboard, per-registry counts, and drift findings such as settled experiments whose results the ledger has not absorbed. Call this before relying on any frozen fact, kappa value, or claim status: a cached or remembered ledger version may be retired.',
    schema: {
      includeDrift: z
        .boolean()
        .optional()
        .describe('Include the full drift findings with sample entries (default true)'),
    },
    execute: async ({ includeDrift = true }) => {
      const { getDoctrineState } = await import('./doctrine-sync');
      const state = await getDoctrineState();
      if (!state) {
        return {
          error: 'not_synced',
          message: 'Doctrine has not been synced yet. The canon is unavailable — do not assume a version.',
        };
      }
      const base = {
        synced_at: state.synced_at,
        frozen_facts: state.canon?.frozen_facts
          ? {
              version: state.canon.frozen_facts.version_label,
              date: state.canon.frozen_facts.date,
              path: state.canon.frozen_facts.path,
              memory_key: 'qig_doctrine_frozen_facts',
              superseded_editions: state.canon.frozen_facts.superseded,
            }
          : null,
        integrity_dashboard: state.canon?.integrity_dashboard
          ? {
              version: state.canon.integrity_dashboard.version_label,
              date: state.canon.integrity_dashboard.date,
              memory_key: 'qig_doctrine_integrity_dashboard',
            }
          : null,
        registries: state.registries,
        in_sync: state.drift?.in_sync ?? null,
        errors: state.errors?.length ? state.errors : undefined,
      };
      if (!includeDrift) return { ...base, drift_summary: { findings: (state.drift?.findings || []).map((f) => f.message) } };
      return { ...base, drift: state.drift };
    },
  },

  task_list: {
    title: 'List Scheduled Tasks',
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
    title: 'Create Scheduled Task',
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
    title: 'Update Scheduled Task',
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
    title: 'Delete Scheduled Task',
    description: 'Permanently delete a task by id. This cannot be undone. Requires memory:write.',
    requiredScope: 'memory:write',
    destructive: true,
    idempotent: true,
    schema: { id: z.string().min(1).describe('The task id') },
    execute: async ({ id }) => {
      const existing = await getTask(id);
      if (!existing) return { error: 'not_found', id };
      return deleteTask(id);
    },
  },

  council_convene: {
    title: 'Convene QIG Council',
    description:
      'Convene the QIG council: six frontier models (Grok, Fable, Sol, Gemini, Kimi, Muse) reason through the Unified Consciousness Protocol and Canonical Principles in a panel-reflect-synthesis flow, each holding the same read-only tools as the helper agent (doctrine, memory, GitHub, web) so members verify rather than assert. EXPENSIVE (13 model calls plus tool steps) and SLOW (2-6 minutes) — use for decisions that genuinely benefit from multi-model deliberation, not for a question a single lookup answers. No cooldown: the cost is stated here so you can choose knowingly. Returns IMMEDIATELY by default: the deliberation runs in the background and the ruling is delivered to the convener\'s inbox (type "council_ruling") with the full transcript at a council_* memory key — collect it with inbox_list + inbox_read a few minutes later. Pass wait:true only if you can hold the connection open for the whole 2-6 minutes and want the verdict pointer inline.',
    // Convening writes (ruling record + inbox message), so the MCP surface
    // requires write scope even though the tool "reads" doctrine.
    requiredScope: 'memory:write',
    openWorld: true,
    schema: {
      // Council members are 1M-token-context models — allow research-brief-sized inputs.
      question: z.string().min(1).max(100_000).describe('The question or decision to deliberate'),
      context: z.string().max(400_000).optional().describe('Optional grounding context for the council (research briefs, transcripts, documents)'),
      convener: z.string().max(200).optional().describe('Identifier of the agent convening the council — the ruling is delivered to this inbox (broadcast when omitted)'),
      wait: z
        .boolean()
        .optional()
        .describe('Block for the full deliberation and return the verdict pointer inline. Default false: convene in the background and deliver the ruling to the inbox (2-6 min) so this call returns immediately instead of timing out the client.'),
    },
    execute: async (args) => {
      const { conveneCouncil, councilKeyFor } = await import('./council');
      // A completed report -> the compact tool result. Agents collect the ruling
      // through the inbox, not this tool result, so the note routes them there.
      const summarize = (report) => {
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
      };

      // wait:true blocks for the whole deliberation (a caller that can hold the
      // connection). Default is ASYNC: a 6-member convene takes 2-6 minutes and
      // MCP clients give up long before, showing an error while the work actually
      // succeeds server-side. after() lets us ACK immediately and finish the
      // deliberation in the background within the invoking route's maxDuration
      // (800s on /api/mcp, /api/council, /api/chat, /api/helper).
      if (args.wait) {
        const report = await conveneCouncil(args);
        if (report.error) return report;
        return summarize(report);
      }

      // Predict the exact memory key the deliberation will persist under, and pass
      // the same convenedAt into the run so they match. The ack thus carries a
      // durable pointer the caller can poll with memory_get even if the
      // best-effort inbox delivery is lost.
      const convenedAt = new Date().toISOString();
      const memoryKey = councilKeyFor(args.question, convenedAt);
      try {
        after(async () => {
          try {
            await conveneCouncil({ ...args, convenedAt });
          } catch (err) {
            console.error('[v0] async council_convene failed:', err?.message || err);
          }
        });
      } catch (err) {
        // after() is only valid inside a request scope. If we somehow run outside
        // one, fall back to synchronous so the council still happens rather than
        // being silently dropped.
        console.error('[v0] after() unavailable, convening synchronously:', err?.message || err);
        const report = await conveneCouncil({ ...args, convenedAt });
        if (report.error) return report;
        return summarize(report);
      }

      const to = args.convener || 'broadcast';
      return {
        ok: true,
        status: 'convening',
        memory_key: memoryKey,
        delivered_to: to,
        note: `The council is convening now — 6 models across panel, reflect, and synthesis (2-6 minutes). You do NOT need to hold this call open. The ruling will be delivered to the "${to}" inbox in the qig namespace (type "council_ruling"), and the full transcript persists at memory key ${memoryKey} — poll it with memory_get if the inbox message does not arrive. Check back in a few minutes with inbox_list + inbox_read, then inbox_ack once considered. Pass wait:true if you would rather block for the verdict inline.`,
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
  'doctrine_status',
  'github_search',
  'github_file_read',
  'web_search',
  'web_extract',
  'task_list',
  // helper_ask is read-only: when invoked as a tool it runs askHelper without
  // canConvene, so its internal toolset is strictly read-only (no council).
  'helper_ask',
  // council_convene is NOT read-only: it persists rulings and sends inbox
  // messages, so it requires memory:write scope like every other write path.
]);

/**
 * MCP tool annotations for one tool. Hosts (including Claude) use these to
 * decide auto-permissions: read-only tools may run without a per-call prompt,
 * while destructive tools always prompt. Derived from the single source of
 * truth above so the two surfaces cannot drift.
 */
export function annotationsFor(name) {
  const def = toolDefs[name];
  const readOnly = READ_ONLY_TOOL_NAMES.has(name);
  return {
    title: def.title,
    readOnlyHint: readOnly,
    // Only meaningful when not read-only; hosts default it to true, so state it
    // explicitly to keep non-destructive writes (e.g. memory_put) prompt-light.
    ...(readOnly ? {} : { destructiveHint: Boolean(def.destructive) }),
    ...(readOnly ? {} : { idempotentHint: Boolean(def.idempotent) }),
    openWorldHint: Boolean(def.openWorld),
  };
}

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
