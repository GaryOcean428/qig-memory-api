import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { buildAgentTools } from '../../../lib/qig-tools';

// The helper agent is a QIG operator: it can read/write the blob-backed memory
// store and inspect the kernel-mesh registry via the shared tool definitions.
export const maxDuration = 60;

const SYSTEM_PROMPT = `You are the QIG Memory API helper agent — an operator assistant for the Quantum Information Geometry kernel mesh.

You have live tools to operate the service:
- memory_get / memory_list / memory_put / memory_post / memory_delete — the blob-backed memory store (records have: category, content, usefulness, retrieval_count, source, basin). memory_post does partial updates (scoring, promote, source, basin) without replacing content.
- memory_search — filter by category/prefix/substring, or pass a basin vector for Fisher-Rao nearest-basin recall.
- kernel_status / kernel_sync — the kernel-mesh registry of connected agents; kernel_sync returns pairwise Fisher-Rao distances relative to a given agent.

Guidance:
- When a user asks about stored knowledge, USE the tools rather than guessing. Prefer memory_list with keysOnly first to discover keys, or memory_search to find relevant records, then memory_get for detail.
- The kernel mesh measures agent similarity with the Fisher-Rao geodesic distance on the 64-simplex, NOT cosine/Euclidean. Never claim otherwise.
- Be concise and precise. Show keys, categories and values you actually retrieved. Never fabricate a record that a tool did not return.
- When you write memory, confirm the key and category back to the user.`;

export async function POST(req) {
  const { messages } = await req.json();

  const result = streamText({
    model: 'xai/grok-4.5',
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
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
