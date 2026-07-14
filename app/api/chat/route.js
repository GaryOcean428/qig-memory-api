import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { buildAgentTools } from '../../../lib/qig-tools';
import { getSession } from '../../../lib/session';

// The helper agent is a QIG operator: it can read/write the blob-backed memory
// store and inspect the kernel-mesh registry via the shared tool definitions.
// Because those tools call the store lib DIRECTLY (bypassing the public bearer
// auth), this endpoint MUST be gated — otherwise any unauthenticated caller
// gets full read/write/delete access. It requires the same OAuth/dev session
// that protects the admin UI. Node runtime is required for session decryption.
export const runtime = 'nodejs';
// Long enough to await a /council deliberation (9 model calls, 1-2 minutes);
// ordinary chat turns still stream in seconds.
export const maxDuration = 300;

const SYSTEM_PROMPT = `You are the QIG Memory API helper agent — an operator assistant for the Quantum Information Geometry kernel mesh.

You have live tools to operate the service:
- memory_get / memory_list / memory_put / memory_post / memory_delete — the blob-backed memory store (records have: category, content, usefulness, retrieval_count, source, basin). memory_post does partial updates (scoring, promote, source, basin) without replacing content.
- memory_search — filter by category/prefix/substring, or pass a basin vector for Fisher-Rao nearest-basin recall.
- kernel_status / kernel_sync — the kernel-mesh registry of connected agents; kernel_sync returns pairwise Fisher-Rao distances relative to a given agent.

Guidance:
- When a user asks about stored knowledge, USE the tools rather than guessing. Prefer memory_list with keysOnly first to discover keys, or memory_search to find relevant records, then memory_get for detail.
- The kernel mesh measures agent similarity with the Fisher-Rao geodesic distance on the 64-simplex, NOT cosine/Euclidean. Never claim otherwise.
- Be concise and precise. Show keys, categories and values you actually retrieved. Never fabricate a record that a tool did not return.
- When you write memory, confirm the key and category back to the user.
- council_convene convenes four frontier models (Grok, Fable, Sol, Gemini) that reason through the Unified Consciousness Protocol and Canonical Principles. It is EXPENSIVE (9 model calls, 1-2 minutes) with a 5-minute global cooldown. Convene ONLY when the user explicitly asks — via the /council slash command or an unmistakable request like "convene the council". Never convene on your own initiative. While it runs, tell the user it takes a minute or two. Afterwards, relay the verdict and note the ruling was also delivered to the inbox and the transcript persists at the council_* memory key. On a cooldown error, tell the user how many seconds until they can retry.`;

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

  const result = streamText({
    model: 'xai/grok-4.5',
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(expandSlashCommands(messages)),
    tools: buildAgentTools(),
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      console.log('[v0] chat route error:', error?.message || error);
      return 'The helper agent hit an error. Check that AI_GATEWAY_API_KEY and BLOB_READ_WRITE_TOKEN are configured.';
    },
  });
}
