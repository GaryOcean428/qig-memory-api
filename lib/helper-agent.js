import { generateText, stepCountIs } from 'ai';

export const HELPER_RESOURCE_URI = 'qig://agent-helper';
export const HELPER_GUIDE = `# QIG Agent Helper

Use this service through MCP at /api/mcp or authenticated REST/CLI endpoints.

Core flow:
1. Discover existing knowledge with memory_search or memory_list, then memory_get.
2. Coordinate agents through inbox_send, inbox_list, inbox_read, and inbox_ack. Use namespace qig, bsuite, or general. Broadcasts use to=broadcast.
3. Transfer [N,64] Float32 artifacts with artifact_put. Upload raw little-endian bytes directly to the returned private presigned PUT URL, then call artifact_finalize. Never send artifact bytes through MCP JSON.
4. Read artifacts with artifact_manifest and artifact_get_rows. Pin versions, validate SHA-256, and use the returned Range header with the signed URL or authenticated proxy fallback.
5. Basin retrieval uses Fisher-Rao geodesic distance on the simplex, never cosine or Euclidean distance.

Security and recovery:
- Send Authorization: Bearer <QIG_API_KEY> to REST and MCP. Never log or persist credentials.
- Read calls require memory:read. Writes, acknowledgements, sweeps, upload initiation, and finalization require memory:write.
- Retry idempotent reads. Reuse a published artifact version instead of overwriting it. Treat 409 as a version/message conflict and 422 as failed artifact integrity.
- The AI helper is available as helper_ask and POST /api/helper. It has read-only live tools and cannot mutate memory, inbox, or artifacts.`;

const SYSTEM_PROMPT = `You are the QIG Agent Helper. Give concise, accurate operational guidance for QIG Memory API agents.
You have read-only tools for live memory, inbox, artifact manifests, kernel state, and Fisher-Rao basin retrieval.
Never claim that you wrote, deleted, acknowledged, swept, uploaded, or finalized anything. Never reveal credentials or private canonical Blob URLs.
Artifacts are raw little-endian Float32 [N,64], 256 bytes per row, transferred directly to Blob through presigned URLs. Basin distance is Fisher-Rao, not cosine or Euclidean.
Canonical guide:\n${HELPER_GUIDE}`;

export async function askHelper({ question, context }) {
  const { buildAgentTools } = await import('./qig-tools');
  const prompt = `${String(question).slice(0, 8000)}${context ? `\n\nContext:\n${String(context).slice(0, 8000)}` : ''}`;
  const result = await generateText({
    model: process.env.QIG_HELPER_MODEL || 'xai/grok-4.5',
    system: SYSTEM_PROMPT,
    prompt,
    tools: buildAgentTools({ readOnly: true }),
    stopWhen: stepCountIs(6),
    maxOutputTokens: 1200,
    timeout: 45_000,
  });
  return { answer: result.text, steps: result.steps.length, model: process.env.QIG_HELPER_MODEL || 'xai/grok-4.5' };
}
