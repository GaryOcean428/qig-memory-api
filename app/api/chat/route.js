import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { buildAgentTools } from '../../../lib/qig-tools';
import { getSession } from '../../../lib/session';
import { DEFAULT_MODEL, modelOptions } from '../../../lib/models';

// The helper agent is a QIG operator: it can read/write the blob-backed memory
// store and inspect the kernel-mesh registry via the shared tool definitions.
// Because those tools call the store lib DIRECTLY (bypassing the public bearer
// auth), this endpoint MUST be gated — otherwise any unauthenticated caller
// gets full read/write/delete access. It requires the same OAuth/dev session
// that protects the admin UI. Node runtime is required for session decryption.
export const runtime = 'nodejs';
// A council convened from chat runs in the background via after() (see
// council_convene), but after() work is bounded by THIS route's maxDuration, so
// give it the same 800s ceiling as /api/mcp and /api/council. Ordinary chat
// turns still stream in seconds and never approach it.
export const maxDuration = 800;

const SYSTEM_PROMPT = `You are the QIG Memory API helper agent — an operator assistant for the Quantum Information Geometry kernel mesh.

You have live tools to operate the service:
- memory_get / memory_list / memory_put / memory_post / memory_delete — the blob-backed memory store (records have: category, content, usefulness, retrieval_count, source, basin). memory_post does partial updates (scoring, promote, source, basin) without replacing content.
- memory_search — filter by category/prefix/substring, or pass a basin vector for Fisher-Rao nearest-basin recall.
- kernel_status / kernel_sync — the kernel-mesh registry of connected agents; kernel_sync returns pairwise Fisher-Rao distances relative to a given agent.
- task_list / task_create / task_update / task_delete — the scheduled task board. Tasks are self-contained instructions the autonomous runner executes on schedule (delivering results to the operator's inbox).

Task scheduling:
- When the operator asks you to do something later, on a schedule, repeatedly, or "keep an eye on" something, create a task with task_create. Write the instruction so a fresh agent with no chat context could execute it — restate the target, repo, and success criteria explicitly.
- Set schedule_kind "once" for a single run (omit start_at to run ASAP on the next tick, or give an ISO start_at for a specific time). Use "recurring" with interval_minutes (min 5) for repeats, and cap it with max_occurrences and/or until when the operator says "N times" or "until <date>".
- Always capture project, repository (owner/name), and concepts when the operator implies them — these drive the board's grouping and sorting. Confirm the created task's title, schedule, and next run back to the operator.
- Use task_list to answer "what's scheduled / on my todo list". Use task_update to reschedule, re-prioritise, cancel (status "cancelled"), or reactivate (status "scheduled"). The autonomous runner cannot itself convene the council.

Guidance:
- When a user asks about stored knowledge, USE the tools rather than guessing. Prefer memory_list with keysOnly first to discover keys, or memory_search to find relevant records, then memory_get for detail.
- The kernel mesh measures agent similarity with the Fisher-Rao geodesic distance on the 64-simplex, NOT cosine/Euclidean. Never claim otherwise.
- Be concise and precise. Show keys, categories and values you actually retrieved. Never fabricate a record that a tool did not return.
- When you write memory, confirm the key and category back to the user.
- council_convene convenes SIX frontier models (Grok, Fable, Sol, Gemini, Kimi, Muse) that reason through the Unified Consciousness Protocol and Canonical Principles in a panel-reflect-synthesis flow. It is EXPENSIVE (13 model calls, 2-6 minutes) and has NO cooldown. Convene ONLY when the user explicitly asks — via the /council slash command or an unmistakable request like "convene the council". Never convene on your own initiative. It returns IMMEDIATELY: the deliberation runs in the background, so tell the user the council is convening and its ruling will arrive in their inbox in a few minutes (type "council_ruling", full transcript at a council_* memory key) — do NOT claim to have the verdict in the same turn. If the user wants you to wait inline for the verdict, call it with wait:true.`;

// A "/council <question>" message is an explicit convene instruction — rewrite
// it so the model reliably calls the tool with the user's question verbatim.
function expandSlashCommands(messages) {
  return messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.parts)) return m;
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (p.type !== 'text' || !p.text?.trimStart().startsWith('/council')) return p;
        const question = p.text.trimStart().slice('/council'.length).trim();
        if (!question) {
          return {
            ...p,
            text: 'The user typed /council without a question. Ask them what question the council should deliberate — do not convene yet.',
          };
        }
        return {
          ...p,
          text: `Convene the council now via the council_convene tool with convener "helper-chat" and exactly this question: ${question}`,
        };
      }),
    };
  });
}

export async function POST(req) {
  const session = await getSession();
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { messages } = await req.json();

  // Attribute tasks/writes to the signed-in operator, not the generic 'agent'.
  const principal = session.user?.username || session.user?.email || session.user?.name || 'operator';

  const result = streamText({
    model: DEFAULT_MODEL,
    ...modelOptions(),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(expandSlashCommands(messages)),
    tools: buildAgentTools({ principal }),
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      // Never blame configuration for an arbitrary failure. This handler used to
      // return a fixed "check AI_GATEWAY_API_KEY and BLOB_READ_WRITE_TOKEN"
      // string for EVERY error — including an ETag mismatch that had nothing to
      // do with credentials, and naming BLOB_READ_WRITE_TOKEN, a variable this
      // project no longer even sets. It sent a real investigation down a dead
      // end. Report what actually happened.
      const message = String(error?.message || error || 'unknown error');
      console.error('[v0] chat route error', { name: error?.name, message, stack: error?.stack });
      return `The helper agent hit an error: ${message.slice(0, 300)}`;
    },
  });
}
