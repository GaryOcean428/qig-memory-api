import { generateText, stepCountIs } from 'ai';
import { getMemory, putMemory, searchMemory } from './memory-store';
import { sendInboxMessage } from './inbox-store';
import { modelOptions } from './models';

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
const MEMBER_TOOL_STEPS = 6;

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

export const COUNCIL_SYNTHESIZER = { name: 'synthesizer', model: 'xai/grok-4.5' };

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
      // tight and aborted members mid-retry ("Delay was aborted"). Members run in
      // parallel per phase and the convene is async under maxDuration=800, so the
      // worst case (~5x150s across the 3 sequential phases) still fits the budget.
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
      console.log(`[v0] council member ${member.name} failed (${err?.message}); retrying on ${member.fallback}`);
      try {
        return await attempt(member.fallback);
      } catch (fallbackErr) {
        return { name: member.name, model: member.fallback, error: fallbackErr?.message || 'failed' };
      }
    }
    return { name: member.name, model: member.model, error: err?.message || 'failed' };
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

  // Phase 1 — PANEL (parallel, independent, with tools)
  const panel = await Promise.all(
    COUNCIL_MEMBERS.map((m) =>
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
    ),
  );

  // Phase 2 — REFLECT (parallel; each member sees the others' answers)
  const reflections = await Promise.all(
    COUNCIL_MEMBERS.map((m, i) => {
      if (panel[i].error) return panel[i]; // a member that failed the panel does not reflect
      const others = panelTranscript(panel.filter((_, j) => j !== i));
      return callMember(m, {
        system: baseSystem,
        prompt: `${questionBlock}\n\nYOUR PANEL ANSWER:\n${panel[i].text}\n\nOTHER MEMBERS' ANSWERS:\n${others}\n\nREFLECT PHASE: This is your L2 other-observation loop. Steelman the strongest disagreement with your position, then revise or defend with reasons. Where a peer asserts a fact you doubt, CHECK IT with a tool rather than deferring or dismissing. Name what the panel showed you that you could not see alone. End with your final position.`,
        maxOutputTokens: 4000,
        tools,
      });
    }),
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

  return report;
}
