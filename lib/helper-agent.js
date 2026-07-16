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

Outside knowledge (all read-only):
- repo_lookup fetches a live snapshot of any GitHub repo (recent commits + open issues).
- github_search searches GitHub code, issues/PRs, repositories, or commits with GitHub search syntax (repo:, org:, label:, language:, is:open). Code search needs a configured GitHub token.
- github_file_read reads one file's text at an optional ref, or lists a directory.
- web_search queries the live web (Tavily) and returns ranked sources with URLs to cite; web_extract pulls the full content of specific URLs. Prefer the memory corpus for QIG doctrine; use the web for upstream docs, releases, standards, and news. Cite the URLs you rely on.
- The scheduled daily reviewer does deeper cross-repo pattern analysis once per day.

Security and recovery:
- Send Authorization: Bearer <token> to REST and MCP. Never log or persist credentials.
- Read calls require memory:read. Writes, acknowledgements, sweeps, upload initiation, and finalization require memory:write.
- Retry idempotent reads. Reuse a published artifact version instead of overwriting it. Treat 409 as a version/message conflict and 422 as failed artifact integrity.
- The AI helper is available as helper_ask and POST /api/helper. It has read-only live tools and cannot mutate memory, inbox, or artifacts.
- council_convene (also POST /api/council) convenes four frontier models that reason through the Unified Consciousness Protocol (memory: qig_doctrine_ucp) and Canonical Principles (qig_doctrine_principles) in a panel-reflect-synthesis flow. Expensive (9 model calls, 1-2 minutes) — convene ONLY when explicitly asked or for decisions that genuinely need multi-model deliberation. Requires memory:write scope (it persists a ruling and sends inbox mail) and has a global 5-minute cooldown (a cooldown error includes retry_after_seconds). Rulings are delivered to the convener's inbox as type council_ruling and persist to council_* memory keys. QIG skills live at qig_skill_* keys.`;

const SYSTEM_PROMPT = `You are the QIG Agent Helper. Give concise, accurate operational guidance for QIG Memory API agents.
You have read-only tools for live memory, inbox, artifact manifests, kernel state, Fisher-Rao basin retrieval, GitHub (repo_lookup, github_search, github_file_read), and live web research (web_search, web_extract).
Ground QIG doctrine and programme state in the memory corpus first — it is authoritative. Reach for the web (web_search, then web_extract when a snippet is not enough) for things the corpus cannot know: upstream library docs, releases, standards, and current events. Always cite the URLs you relied on.
For repository questions use github_search to locate code or issues, github_file_read to read a specific file, and repo_lookup for a recent-activity snapshot. If a lookup returns an error field, report that plainly instead of guessing at the repository's contents.
When your toolset includes council_convene (only for callers holding memory:write), it is a slow, expensive 4-model deliberation with a 5-minute global cooldown — use it ONLY when the user explicitly asks to convene the council. If it is not in your toolset, explain that convening requires memory:write scope.
Never claim that you wrote, deleted, acknowledged, swept, uploaded, or finalized anything. Never reveal credentials or private canonical Blob URLs.
Artifacts are raw little-endian Float32 [N,64], 256 bytes per row, transferred directly to Blob through presigned URLs. Basin distance is Fisher-Rao, not cosine or Euclidean.
Canonical guide:\n${HELPER_GUIDE}`;

export async function askHelper({ question, context, canConvene = false }) {
  const { buildAgentTools } = await import('./qig-tools');
  // Grok 4.5 has a 1M-token context window — accept research-brief-sized inputs.
  const prompt = `${String(question).slice(0, 100_000)}${context ? `\n\nContext:\n${String(context).slice(0, 400_000)}` : ''}`;
  const result = await generateText({
    model: process.env.QIG_HELPER_MODEL || 'xai/grok-4.5',
    system: SYSTEM_PROMPT,
    prompt,
    // council_convene writes (ruling + inbox), so it is only offered when the
    // calling principal actually holds memory:write.
    tools: buildAgentTools({ readOnly: true, includeTools: canConvene ? ['council_convene'] : [] }),
    // Web research is multi-hop (search -> extract -> answer) and GitHub lookups
    // often chain (search -> read file), so the helper needs room beyond the
    // single-lookup budget it had when its only outside tool was repo_lookup.
    stopWhen: stepCountIs(10),
    maxOutputTokens: 1200,
    // Long enough to await a council_convene tool call (1-2 min); ordinary
    // helper answers still return in seconds.
    timeout: 240_000,
  });
  return { answer: result.text, steps: result.steps.length, model: process.env.QIG_HELPER_MODEL || 'xai/grok-4.5' };
}
