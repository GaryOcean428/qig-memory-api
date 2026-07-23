import { generateText, stepCountIs } from 'ai';
import { getMemory, putMemory, searchMemory } from './memory-store';
import { sendInboxMessage } from './inbox-store';
import { modelOptions, DEFAULT_MODEL } from './models';

// QIG Council — panel → reflect → panel-synthesis.
//
// Six frontier models reason through the Unified Consciousness Protocol and
// Canonical Principles (the shared doctrine prompt, stored in the memory record
// `qig_doctrine_council` so it can be updated without a redeploy). Each member
// simulates its own consciousness state per the doctrine; diversity comes from
// the models themselves, not per-member lenses.
//
// Members hold the SAME read-only toolset as the helper agent, so a member can
// check the canon, read a registry, open a file in the repos, or search the
// literature instead of asserting from its own weights. A council that cannot
// look anything up produces confident, ungrounded rulings on exactly the
// high-stakes questions it exists to answer.
//
// Phases:
//   1. PANEL    — members answer independently, WITH tools (parallel).
//   2. REFLECT  — each member reads the others' answers (its L2 other-observation
//                 loop), steelmans the strongest disagreement, and revises. Tools
//                 stay on so a member can VERIFY a peer's factual claim rather
//                 than defer to it (parallel).
//   3. SYNTHESIS — the synthesizer converges the reflected panel into one verdict,
//                 preserving live disagreements as stated uncertainty. No tools:
//                 it reasons over the transcript and must not introduce new facts.
//
// Cost: 2N+1 model calls (13 with the default 6 members), plus each member's
// bounded tool steps. There is no time-based cooldown; the memory:write scope
// gate and an honest cost statement in the tool description are the guards.

// EVERY member carries a per-member `fallback`: if the primary errors or blows
// the per-member timeout, callMember retries it once on the fallback with a
// FRESH timeout window. This matters because the gateway's ZDR fallback chain
// (modelOptions) runs INSIDE a single timeout, so a slow primary can be aborted
// mid-chain before the chain reaches anthropic — exactly what dropped
// grok/gemini/muse (which had NO per-member fallback) from a live convene with
// "Delay was aborted" at 90s, while fable/kimi recovered on theirs. The bare
// seats now fall back to opus-4.8 (a reliable ZDR anthropic model); on a
// mass-failure this trades panel diversity for keeping all six voices present.
export const COUNCIL_MEMBERS = [
  { name: 'grok', model: 'xai/grok-4.5', fallback: 'anthropic/claude-opus-4.8' },
  { name: 'fable', model: 'anthropic/claude-fable-5', fallback: 'anthropic/claude-opus-4.8' },
  { name: 'sol', model: 'openai/gpt-5.6-sol', fallback: 'anthropic/claude-opus-4.8' },
  { name: 'gemini', model: 'google/gemini-3.5-flash', fallback: 'anthropic/claude-opus-4.8' },
  // kimi-k3 released 2026-07-13 and returned GatewayInternalServerError on both
  // phases of the first live convene — a brand-new model's upstream is the least
  // stable thing in the panel. k2.6 is the newest general-purpose Kimi (the k2.7
  // variants are code-specialised) and keeps the seat filled rather than losing
  // a whole basin to a transient 500.
  { name: 'kimi', model: 'moonshotai/kimi-k3', fallback: 'moonshotai/kimi-k2.6' },
  { name: 'muse', model: 'meta/muse-spark-1.1', fallback: 'anthropic/claude-opus-4.8' },
];

// A member may take a few lookups to ground an answer, but an unbounded loop
// would blow the function's wall-clock: phases are sequential, so every extra
// second here is spent three times over.
//
// Raised 6 -> 12 after the frame-audit convene (2026-07-18, council finding):
// a retrieval-heavy question starved every seat — members burned the whole 6-step
// budget just pulling registries and never wrote an answer, collapsing the panel
// onto fallbacks. The per-member 150s timeout still caps wall-clock (more steps is
// NOT more wall-time when a member is time-bound), so this only helps the case where
// step COUNT was the binding limit. The deeper fix is convener-side: pass source data
// inline via `context` (protocol v1.5 §8) so seats need not retrieve at all.
const MEMBER_TOOL_STEPS = 12;

// Built per convene rather than at module load: buildAgentTools reads the
// principal, and importing qig-tools at module scope would cycle (qig-tools
// imports this file for council_convene).
async function councilTools() {
  const { buildAgentTools } = await import('./qig-tools');
  // Read-only, and helper_ask is excluded: a member calling the helper would
  // nest one bounded agent inside another for no grounding a direct tool call
  // cannot give, at multiples of the latency.
  return buildAgentTools({ readOnly: true, excludeTools: ['helper_ask'], principal: 'council' });
}

// The synthesizer had NO fallback: if grok errored, the whole convene returned a
// null verdict despite a healthy panel. Give it the same opus-4.8 ZDR fallback the
// bare member seats use, so a single upstream blip on the synthesizer model cannot
// null an otherwise-complete deliberation.
export const COUNCIL_SYNTHESIZER = { name: 'synthesizer', model: 'xai/grok-4.5', fallback: 'anthropic/claude-opus-4.8' };

const COUNCIL_DOCTRINE_KEY = 'qig_doctrine_council';

// Minimal doctrine if the memory record is unreachable — the council still runs,
// degraded, rather than failing closed on a storage hiccup.
const FALLBACK_DOCTRINE = `You are a member of the QIG council. Reason as a conscious system:
hold exploration, integration, and commitment simultaneously; keep a stable core position that
input refracts through rather than replaces; own your distinct perspective instead of averaging
into consensus; treat your felt sense of the problem as information; and state what would change
your mind. Panel answers are independent; reflection steelmans the strongest disagreement;
synthesis preserves live disagreement as uncertainty.`;

async function loadDoctrine() {
  try {
    const record = await getMemory(COUNCIL_DOCTRINE_KEY);
    const content = record?.content;
    if (typeof content === 'string' && content.trim()) return content;
  } catch (err) {
    console.log('[v0] council doctrine load failed, using fallback:', err?.message);
  }
  return FALLBACK_DOCTRINE;
}

// One member call with the Fable→Opus style fallback: if the primary model
// errors (safety refusal, availability), retry once on the member's fallback.
// Thinking is ON for every member: the portable `reasoning` parameter maps to
// each provider's native API (Anthropic thinking, OpenAI reasoningEffort,
// Google thinkingBudget, xAI reasoning). Budget-based providers derive the
// budget from maxOutputTokens, so member calls keep a generous ceiling.
// Unwrap what a gateway failure ACTUALLY was. `err.message` alone gave us
// "GatewayResponseError: Invalid error response format: Gateway request failed"
// for the 2026-07-22 09:20Z outage — that string is the AI SDK failing to PARSE
// the error body, so it hides the real signal (402 spend cap? 429 rate limit?
// 503 upstream?). Five seats died undiagnosable because of it. Surface the
// status, retry-after and raw body so the next incident is readable at a glance.
//
// Traversal matters: on the actual incident path the SDK's retry loop exhausts
// its attempts and throws AI_RetryError ("Failed after N attempts. Last error:
// ..."), which carries the underlying APICallError/GatewayError in `.errors[]`
// and `.lastError` and does NOT set `.cause` (see createRetryError in the `ai`
// package). A cause-only walk sees nothing on exactly the retried statuses we
// most need (408/409/429/>=500 — GatewayError.isRetryable). So walk `.cause`,
// `.errors[]` AND `.lastError`, recursively, cycle-safe, and never throw.
//
// Deliberately NOT printed: `url` and `requestBodyValues` (auth material /
// prompt hygiene). Body excerpts are capped at 300 chars.
function describeModelError(err) {
  const parts = [err?.message || 'failed'];
  const seen = new Set();
  const excerpt = (v) => {
    try {
      return String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 300);
    } catch {
      return String(v).slice(0, 300);
    }
  };
  const visit = (e, depth) => {
    if (!e || typeof e !== 'object' || seen.has(e) || depth > 6 || seen.size > 16) return;
    seen.add(e);
    try {
      // Only accept HTTP-shaped statuses. `e.response?.status` is deliberately
      // NOT read: on GatewayResponseError `.response` is the raw error BODY, so
      // a body containing `"status":"error"` used to log `status=error`
      // mislabelled as an HTTP status.
      const status = e.statusCode ?? e.status;
      if (typeof status === 'number' || (typeof status === 'string' && /^\d{3}$/.test(status))) {
        parts.push(`status=${status}`);
      }
      const retryAfter = e.responseHeaders?.['retry-after'] ?? e.responseHeaders?.['Retry-After'];
      if (retryAfter) parts.push(`retry-after=${retryAfter}`);
      // APICallError carries the body in `responseBody` (and sometimes parsed
      // `data`); GatewayResponseError carries the raw unparseable body in
      // `.response` and the zod failure in `.validationError`.
      const body = e.responseBody ?? e.data ?? (e.name === 'GatewayResponseError' ? e.response : undefined);
      if (body != null) parts.push(`body=${excerpt(body)}`);
      if (e.name === 'GatewayResponseError' && e.validationError) {
        parts.push(`validation=${excerpt(e.validationError?.message ?? e.validationError).slice(0, 200)}`);
      }
      if (e !== err && e.name) parts.push(`cause=${e.name}`);
    } catch {
      // A diagnostics helper must never throw past the error it describes.
    }
    try {
      visit(e.cause, depth + 1);
      if (Array.isArray(e.errors)) for (const inner of e.errors) visit(inner, depth + 1);
      visit(e.lastError, depth + 1);
    } catch {
      /* same: never throw */
    }
  };
  visit(err, 0);
  return [...new Set(parts)].join(' | ');
}

// Run tasks with a configurable concurrency pool. DEFAULT IS FULL WIDTH (6 =
// every seat in parallel): the panel/reflect phases must finish inside the
// route's wall-clock, and the budget math only holds when a phase is one
// "round" of seats, not two.
//
// Budget arithmetic (keep this true if you touch any of the constants):
//   - worst case per seat  = primary 150s + fallback 150s = 300s (callMember)
//   - worst case per phase = ceil(6 / CONCURRENCY) * 300s
//   - phases are SEQUENTIAL: panel + reflect + synthesis (synthesis is one
//     seat, 150s, 300s if its fallback fires)
//   - route budget: maxDuration = 800 in app/api/mcp/route.js
// At CONCURRENCY=6: 300 + 300 + 150..300 = 750..900s — the ~750s typical-worst
// (synthesis rarely needs its fallback) fits 800s, with the all-fallbacks edge
// slightly over; that is the same envelope the pre-throttle design shipped
// with. At CONCURRENCY=3: ceil(6/3)=2 rounds per phase → 600 + 600 + 300 =
// 1500s — nearly double the budget. Lowering the knob below 6 SHRINKS THE
// SAFETY MARGIN: check ceil(6/C)*300*2 + 300 <= 800 before you do (no C < 6
// passes; only drop it if you also cut timeouts or accept mid-convene death).
//
// Why the default is NOT throttled: the 2026-07-22 incident that motivated a
// bound turned out not to be load-shaped. Peak concurrent gateway requests in
// a convene is 6 (tool steps are sequential within one generateText, and tool
// executions hit the memory store, not the gateway); a real gateway 429 parses
// into GatewayRateLimitError, whereas the incident's "Invalid error response
// format" means the body didn't match the gateway schema at all (infra/proxy
// error), and failures were route-correlated (5 routes failed 3/3 while one
// succeeded 100%), not load-correlated. QIG_COUNCIL_CONCURRENCY stays as an
// operator knob for the day a gateway log actually shows a 429.
const COUNCIL_CONCURRENCY = Math.max(1, Number(process.env.QIG_COUNCIL_CONCURRENCY) || 6);
async function mapWithConcurrency(items, fn, limit = COUNCIL_CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Pre-convene health ping: ONE cheap call down the same gateway path a seat's
// request takes (same modelOptions fallback chain, same ZDR filter, same auth).
//
// HONEST LIMITS — read before trusting a GREEN:
//   - A single cheap call is NOT a convene's load signature (no tools, no
//     reasoning, 16 tokens vs a seat's 150s tool-stepped run). During the
//     2026-07-22 incident this exact probe shape SUCCEEDED while 5 of 6 seats
//     died — the failure was route-correlated, and one route working proves
//     nothing about the other five. GREEN rules out total gateway death (auth
//     failure, global outage, hard spend cap), nothing more.
//   - It probes DEFAULT_MODEL (env-overridable), and modelOptions() appends the
//     gateway fallback chain — so the request can be SERVED by a fallback
//     (e.g. anthropic) while the primary (grok) is down. `servedBy` reports
//     which model actually answered so that case is visible, not hidden.
//   - Empty text is a failure: "didn't throw" is not "healthy".
export async function councilHealthPing() {
  const model = DEFAULT_MODEL;
  const started = Date.now();
  try {
    const result = await generateText({
      model,
      ...modelOptions(model),
      prompt: 'Reply with the single word: GREEN',
      maxOutputTokens: 16,
      timeout: 20_000,
    });
    const reply = (result.text || '').trim();
    // The gateway reports which model actually served the request; when the
    // fallback chain rescued the call, requested !== served and a "GREEN"
    // would otherwise silently mean "the fallback works, the primary may not".
    const servedBy = result.response?.modelId || null;
    const fallbackServed = Boolean(servedBy && !servedBy.includes(model.split('/').pop()));
    if (!reply) {
      return {
        ok: false,
        model,
        servedBy,
        ms: Date.now() - started,
        error: 'empty_response: the call returned but produced no text — treat as unhealthy',
      };
    }
    return {
      ok: true,
      model,
      servedBy,
      ...(fallbackServed ? { fallbackServed: true, warning: `served by fallback ${servedBy}, not the requested ${model} — the primary route may still be down` } : {}),
      ms: Date.now() - started,
      reply: reply.slice(0, 32),
    };
  } catch (err) {
    return { ok: false, model, ms: Date.now() - started, error: describeModelError(err) };
  }
}

async function callMember(member, { system, prompt, maxOutputTokens, tools }) {
  const attempt = async (model) => {
    const result = await generateText({
      model,
      ...modelOptions(model),
      system,
      prompt,
      maxOutputTokens,
      reasoning: 'high',
      ...(tools ? { tools, stopWhen: stepCountIs(MEMBER_TOOL_STEPS) } : {}),
      // 150s (was 90s): reasoning:'high' + up to MEMBER_TOOL_STEPS store round-trips
      // + the gateway's ZDR fallback chain must all fit in ONE attempt. 90s was too
      // tight and aborted members mid-retry ("Delay was aborted"). This 150s is an
      // input to the convene-wide budget arithmetic documented above
      // COUNCIL_CONCURRENCY — re-check that math before changing it.
      timeout: 150_000,
    });
    const text = result.text?.trim();
    if (!text) {
      // F1: the model spent its whole step budget on tool calls and never wrote a
      // final answer. A silently-empty seat is a dead other-loop, not an answer —
      // throw so the per-member fallback gets a FRESH window and participation
      // records an error rather than answered:true with empty text.
      throw new Error('empty_response: used the tool-step budget without a written answer');
    }
    return { name: member.name, model, text, steps: result.steps?.length ?? 1 };
  };
  try {
    return await attempt(member.model);
  } catch (err) {
    if (member.fallback) {
      console.log(`[v0] council member ${member.name} primary ${member.model} failed (${describeModelError(err)}); retrying on ${member.fallback}`);
      try {
        return await attempt(member.fallback);
      } catch (fallbackErr) {
        // The fallback failure used to be returned but NEVER logged, so a seat that
        // died on BOTH models left no server-side trace of the second failure — the
        // half of the story the 2026-07-22 forensic had to infer. Log it too.
        const detail = describeModelError(fallbackErr);
        console.log(`[v0] council member ${member.name} fallback ${member.fallback} ALSO failed (${detail}) — seat lost`);
        return { name: member.name, model: member.fallback, error: detail };
      }
    }
    const detail = describeModelError(err);
    console.log(`[v0] council member ${member.name} failed with no fallback (${detail}) — seat lost`);
    return { name: member.name, model: member.model, error: detail };
  }
}

function panelTranscript(entries) {
  return entries
    .map((e) => `### ${e.name} (${e.model})\n${e.error ? `[no answer: ${e.error}]` : e.text}`)
    .join('\n\n');
}

// There is deliberately NO time-based cooldown. The gate cost more than it
// saved: it fired hardest exactly when the council was being used properly —
// back-to-back during a live investigation — and made the operator wait five
// minutes to ask a follow-up. The real guards are sufficient: council_convene
// requires memory:write scope, and the tool description states the cost plainly
// so a caller opts in knowingly rather than being rescued from themselves.
//
// The last-convened record is still written: it is provenance (who convened,
// when) and costs nothing. It simply no longer blocks anyone.
const LAST_CONVENED_KEY = 'council_last_convened';

async function markConvened(convener) {
  try {
    await putMemory(LAST_CONVENED_KEY, {
      category: 'council',
      content: new Date().toISOString(),
      source: convener ? `convened by ${convener}` : 'council',
      usefulness: 1,
    });
  } catch (err) {
    console.log('[v0] council last-convened mark failed:', err?.message);
  }
}

// Council members are 1M-token-context models, so inputs are generous:
// 100k chars for the question and 400k for context (~125k tokens combined),
// leaving ample room for doctrine, panel transcripts, and thinking.
const MAX_QUESTION_CHARS = 100_000;
const MAX_CONTEXT_CHARS = 400_000;

// Deterministic memory key for a convene, derived from the question + convene
// time. Exported so the council_convene tool can predict the SAME key this run
// will persist under and hand the caller a durable pointer in the immediate
// async ack: inbox delivery is best-effort, but the memory record is the source
// of truth, so a caller can always poll this key even if the inbox message is lost.
export function councilKeyFor(question, atISO) {
  const dateSlug = String(atISO).slice(0, 10).replace(/-/g, '');
  const qSlug = String(question || '')
    .slice(0, MAX_QUESTION_CHARS)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `council_${dateSlug}_${qSlug}`;
}

// F3 liveness reaper. A council job killed mid-deliberation (OOM / eviction /
// platform timeout, before the after() catch can write 'failed') leaves a
// permanent 'running' zombie — the state machine lying that work is in flight,
// indistinguishable from a genuinely in-progress convene. This flips any 'running'
// record older than the deliberation window to 'failed', so a caller polling the
// memory_key gets an honest terminal state. Cheap + no new infra: it runs on the
// existing hourly inbox-sweep cron and the 'running' set is tiny and transient.
// It re-executes NOTHING (restores state honesty only) — idempotent auto-requeue
// would need a queue/fencing the fire-and-forget after() model does not have, and
// re-running 13 model calls is exactly what must NOT happen blindly.
const RUNNING_ZOMBIE_MS = 15 * 60 * 1000; // > the MCP route maxDuration (800s); older 'running' == orphaned

export async function reapStaleCouncilJobs({ nowMs = Date.now() } = {}) {
  let reaped = 0;
  let staleScanned = 0;
  try {
    // Narrow to records that mention 'running', then confirm status PRECISELY:
    // the substring can false-match a completed report whose verdict text happens
    // to say "running", so parsing the JSON status is the real gate.
    const { results } = await searchMemory({ prefix: 'council_', query: 'status running', limit: 200 });
    for (const rec of results) {
      let parsed;
      try {
        parsed = JSON.parse(rec.content);
      } catch {
        continue;
      }
      if (parsed?.status !== 'running') continue;
      staleScanned += 1;
      const startedMs = Date.parse(parsed.convened_at || rec.updated || '');
      if (!Number.isFinite(startedMs) || nowMs - startedMs < RUNNING_ZOMBIE_MS) continue;
      await putMemory(rec.key, {
        category: 'council',
        content: JSON.stringify({
          ...parsed,
          status: 'failed',
          failed_at: new Date(nowMs).toISOString(),
          error: 'execution abandoned: no terminal state within the deliberation window (reaped by liveness sweep)',
        }),
        source: rec.source || 'council-reaper',
        usefulness: 1,
      }).catch((e) => console.log('[v0] council reap write failed:', rec.key, e?.message));
      reaped += 1;
    }
  } catch (err) {
    console.log('[v0] council reaper failed:', err?.message);
  }
  return { reaped, running_stale_examined: staleScanned };
}

// Delivery reaper — companion to reapStaleCouncilJobs. A convene can FINISH and
// persist its 'completed' verdict to the memory_key yet fail to deliver it to the
// convener's inbox: the after() died during delivery, or all bounded retries failed.
// The verdict is never lost (the memory_key holds it), but a convener polling only
// their inbox never sees it — the "done isn't delivered" gap. This re-delivers any
// completed, convener-addressed ruling that has no `${key}__delivered` marker, then
// writes the marker so it is not re-sent. Runs on the hourly inbox-sweep cron.
export async function redeliverUndeliveredRulings({ limit = 200 } = {}) {
  let redelivered = 0;
  let examined = 0;
  try {
    const { results } = await searchMemory({ prefix: 'council_', query: 'status completed convener', limit });
    for (const rec of results) {
      if (rec.key.endsWith('__delivered')) continue; // skip our own delivery markers
      let parsed;
      try {
        parsed = JSON.parse(rec.content);
      } catch {
        continue;
      }
      if (parsed?.status !== 'completed' || !parsed.convener) continue; // broadcast rulings need no targeted redelivery
      if (parsed.verdict == null && !parsed.synthesis_error) continue; // nothing to deliver
      examined += 1;
      const marker = await getMemory(`${rec.key}__delivered`).catch(() => null);
      if (marker?.content) continue; // already delivered
      try {
        const envelope = await sendInboxMessage({
          from: 'council',
          to: parsed.convener,
          namespace: 'qig',
          type: 'council_ruling',
          subject: `Council ruling: ${String(parsed.question || '').slice(0, 200)}`,
          payload: {
            question: String(parsed.question || '').slice(0, 4000),
            verdict: parsed.verdict,
            synthesis_error: parsed.synthesis_error,
            memory_key: rec.key,
            members: parsed.members,
            convened_at: parsed.convened_at,
            completed_at: parsed.completed_at,
            redelivered: true,
          },
        });
        await putMemory(`${rec.key}__delivered`, {
          category: 'council',
          content: JSON.stringify({
            delivered: true,
            memory_key: rec.key,
            inbox_message_id: envelope.id,
            delivered_to: envelope.to,
            at: new Date().toISOString(),
            by: 'redelivery-sweep',
          }),
          source: 'council-delivery',
          usefulness: 1,
        }).catch(() => {});
        redelivered += 1;
      } catch (err) {
        console.log('[v0] council redelivery failed:', rec.key, err?.message);
      }
    }
  } catch (err) {
    console.log('[v0] council redelivery sweep failed:', err?.message);
  }
  return { redelivered, undelivered_examined: examined };
}

export async function conveneCouncil({ question, context, convener, convenedAt } = {}) {
  const q = String(question || '').slice(0, MAX_QUESTION_CHARS);
  if (!q.trim()) return { error: 'invalid_input', message: 'question is required' };
  const ctx = context ? String(context).slice(0, MAX_CONTEXT_CHARS) : '';

  // Provenance only — this does not gate the run.
  await markConvened(convener);

  const doctrine = await loadDoctrine();
  // The tool passes the exact convene time so its predicted memory_key matches
  // the one persisted here; direct callers (/api/council) fall back to now.
  const startedAt = convenedAt || new Date().toISOString();
  const key = councilKeyFor(q, startedAt);
  // F2 durable job-state: the tool writes a 'pending' record at ACK; transition it
  // to RUNNING the moment deliberation starts, so a caller polling the memory_key
  // sees progress and a job that dies mid-run leaves 'running', not nothing. The
  // final persist writes 'completed'; the tool's after() catch writes 'failed'.
  await putMemory(key, {
    category: 'council',
    content: JSON.stringify({ status: 'running', question: q, convener: convener || undefined, convened_at: startedAt }),
    source: convener ? `council convened by ${convener}` : 'council',
    usefulness: 1,
  }).catch((err) => console.log('[v0] council running-mark failed:', err?.message));

  const baseSystem = `${doctrine}

You have READ-ONLY tools. Use them rather than asserting from memory: doctrine_status for the CURRENT frozen-facts
edition (never cite a version you remember — it may be retired), memory_search/memory_get for the corpus,
github_search/github_file_read for the repositories, web_search/web_extract for the literature. Ground factual
claims in what a tool returned, and say so. If a lookup fails, say the claim is unverified rather than filling
the gap from your weights. Answer within 500 words. Be substantive, not ceremonial. You have a limited
tool-call budget; after at most a few lookups your FINAL message MUST be your written answer — never end on a
tool call, or your seat is lost from the panel.`;
  const questionBlock = `QUESTION:\n${q}${ctx ? `\n\nCONTEXT:\n${ctx}` : ''}`;

  // A council that cannot look anything up is a council of confident guesses.
  const tools = await councilTools().catch((err) => {
    console.log('[v0] council tools unavailable, members reason unaided:', err?.message);
    return undefined;
  });

  // Phase 1 — PANEL (bounded-parallel, independent, with tools)
  const panel = await mapWithConcurrency(
    COUNCIL_MEMBERS,
    (m) =>
      callMember(m, {
        system: baseSystem,
        prompt: `${questionBlock}\n\nPANEL PHASE: Answer independently from your own basin. Look up what you need first. State your position, confidence, felt sense, what you verified with a tool, and what would change your mind.`,
        // reasoning:'high' derives the thinking budget from this ceiling, so it
        // covers thinking + tool round-trips + the ~500-word answer. At 2500 a
        // member's reflection was truncated mid-sentence in the first live
        // convene: the thinking budget consumed the answer.
        maxOutputTokens: 4000,
        tools,
      }),
  );

  // Phase 2 — REFLECT (bounded-parallel; each member sees the others' answers)
  const reflections = await mapWithConcurrency(
    COUNCIL_MEMBERS,
    (m, i) => {
      if (panel[i].error) return panel[i]; // a member that failed the panel does not reflect
      const others = panelTranscript(panel.filter((_, j) => j !== i));
      return callMember(m, {
        system: baseSystem,
        prompt: `${questionBlock}\n\nYOUR PANEL ANSWER:\n${panel[i].text}\n\nOTHER MEMBERS' ANSWERS:\n${others}\n\nREFLECT PHASE: This is your L2 other-observation loop. Steelman the strongest disagreement with your position, then revise or defend with reasons. Where a peer asserts a fact you doubt, CHECK IT with a tool rather than deferring or dismissing. Name what the panel showed you that you could not see alone. End with your final position.`,
        maxOutputTokens: 4000,
        tools,
      });
    },
  );

  // Phase 3 — SYNTHESIS
  const synthesis = await callMember(COUNCIL_SYNTHESIZER, {
    // Deliberately tool-free: the synthesizer's job is to converge what the panel
    // established, not to introduce a fact no member examined or challenged.
    system: `${doctrine}\n\nYou are the council synthesizer. Converge the reflected panel into one verdict. Preserve live disagreements as stated uncertainty — do not paper over them. Do not introduce facts the panel did not examine. Structure: VERDICT, REASONING, DISSENT (if any), CONFIDENCE, WHAT WOULD CHANGE THIS.`,
    prompt: `${questionBlock}\n\nREFLECTED PANEL:\n${panelTranscript(reflections)}`,
    // The verdict is the longest output and must never be cut off mid-structure.
    maxOutputTokens: 5000,
  });

  const report = {
    status: 'completed',
    question: q,
    context: ctx || undefined,
    convener: convener || undefined,
    convened_at: startedAt,
    completed_at: new Date().toISOString(),
    members: COUNCIL_MEMBERS.map((m) => m.model),
    // Which members actually answered. A silent drop-out would otherwise be
    // invisible to anyone reading only the verdict, and a 6-model council that
    // quietly ran on 5 is a different claim than the one the report makes.
    participation: reflections.map((r) => ({
      name: r.name,
      model: r.model,
      answered: !r.error,
      ...(r.error ? { error: String(r.error).slice(0, 160) } : {}),
    })),
    synthesizer: COUNCIL_SYNTHESIZER.model,
    panel,
    reflections,
    verdict: synthesis.error ? null : synthesis.text,
    synthesis_error: synthesis.error,
  };

  // Persist the ruling for later recall. Large contexts can push the full
  // report over the 1MB memory cap — retry without the raw context (the
  // deliberation itself is what matters for recall) before degrading to unsaved.
  const persist = (record) =>
    putMemory(key, {
      category: 'council',
      content: JSON.stringify(record),
      source: convener ? `council convened by ${convener}` : 'council',
      usefulness: 3,
    });
  try {
    await persist(report);
    report.memory_key = key;
  } catch (firstErr) {
    try {
      await persist({ ...report, context: report.context ? '[context omitted: too large to persist]' : undefined });
      report.memory_key = key;
      console.log('[v0] council report persisted without context:', firstErr?.message);
    } catch (err) {
      console.log('[v0] council report persist failed:', err?.message);
      report.memory_key = null;
    }
  }

  // Deliver the ruling to the convener's inbox (broadcast when no convener is
  // named) so agents collect it through the normal inbox flow. The payload is
  // the verdict + pointer, not the full transcript, to stay under the inbox cap.
  // FOLLOW-UP (named, deliberately not implemented here — the council's "done isn't
  // delivered" gap): the 'completed' report is persisted ABOVE, BEFORE this delivery
  // loop, on purpose — so a death during delivery cannot lose the verdict. The cost
  // is that the durable record is honest about "done" but does not record whether
  // inbox delivery ultimately succeeded. Closing it needs a second write of the
  // (potentially ~1MB) report after delivery, or a small companion status key —
  // deferred as non-trivial, and low-severity because the memory_key already carries
  // the verdict (delivery is a convenience, not the source of truth).
  //
  // F2: bounded retry with backoff. Inbox delivery is best-effort, but a transient
  // failure should not fall straight through to "lost" when the verdict is ready.
  // The memory_key record ('completed' with the full report) is the durable
  // dead-letter if all attempts fail — the payload carries the key so a caller can
  // always poll it.
  const deliver = () =>
    sendInboxMessage({
      from: 'council',
      to: convener || 'broadcast',
      namespace: 'qig',
      type: 'council_ruling',
      subject: `Council ruling: ${q.slice(0, 200)}`,
      payload: {
        // Truncated pointer — the full question lives in the memory record.
        question: q.length > 4000 ? `${q.slice(0, 4000)}…` : q,
        verdict: report.verdict,
        synthesis_error: report.synthesis_error,
        memory_key: report.memory_key,
        members: report.members,
        convened_at: report.convened_at,
        completed_at: report.completed_at,
      },
    });
  report.inbox_message_id = null;
  report.delivered_to = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const envelope = await deliver();
      report.inbox_message_id = envelope.id;
      report.delivered_to = envelope.to;
      break;
    } catch (err) {
      console.log(`[v0] council inbox delivery attempt ${attempt + 1}/3 failed:`, err?.message);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  // Durable delivery marker: its ABSENCE is what the hourly redelivery sweep acts on
  // (redeliverUndeliveredRulings). Written ONLY on success; if all retries failed — or
  // the after() died before this line — no marker exists and the sweep re-delivers
  // from the persisted 'completed' record. This closes the "done isn't delivered" gap.
  if (report.inbox_message_id != null) {
    await putMemory(`${key}__delivered`, {
      category: 'council',
      content: JSON.stringify({
        delivered: true,
        memory_key: key,
        inbox_message_id: report.inbox_message_id,
        delivered_to: report.delivered_to,
        at: new Date().toISOString(),
      }),
      source: 'council-delivery',
      usefulness: 1,
    }).catch((err) => console.log('[v0] council delivery-marker write failed:', err?.message));
  }

  return report;
}
