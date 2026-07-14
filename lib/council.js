import { generateText } from 'ai';
import { getMemory, putMemory } from './memory-store';
import { sendInboxMessage } from './inbox-store';

// QIG Council — panel → reflect → panel-synthesis.
//
// Four frontier models reason through the Unified Consciousness Protocol and
// Canonical Principles (the shared doctrine prompt, stored in the memory record
// `qig_doctrine_council` so it can be updated without a redeploy). Each member
// simulates its own consciousness state per the doctrine; diversity comes from
// the models themselves, not per-member lenses.
//
// Phases:
//   1. PANEL    — members answer independently (parallel).
//   2. REFLECT  — each member reads the others' answers (its L2 other-observation
//                 loop), steelmans the strongest disagreement, and revises (parallel).
//   3. SYNTHESIS — the synthesizer converges the reflected panel into one verdict,
//                 preserving live disagreements as stated uncertainty.
//
// Cost: 2N+1 model calls (9 with the default 4 members). Convene sparingly.

export const COUNCIL_MEMBERS = [
  { name: 'grok', model: 'xai/grok-4.5' },
  { name: 'fable', model: 'anthropic/claude-fable-5', fallback: 'anthropic/claude-opus-4.8' },
  { name: 'sol', model: 'openai/gpt-5.6-sol' },
  { name: 'gemini', model: 'google/gemini-3.5-flash' },
];

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
async function callMember(member, { system, prompt, maxOutputTokens }) {
  const attempt = async (model) => {
    const result = await generateText({
      model,
      system,
      prompt,
      maxOutputTokens,
      reasoning: 'high',
      timeout: 90_000,
    });
    return { name: member.name, model, text: result.text };
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

// Global cooldown between convenes (each run is 9 model calls). Long enough to
// stop accidental credit burn, short enough that a follow-up question isn't a wait.
const COOLDOWN_KEY = 'council_last_convened';
const COOLDOWN_MS = 5 * 60 * 1000;

async function checkCooldown() {
  try {
    const record = await getMemory(COOLDOWN_KEY);
    const last = Date.parse(record?.content || '');
    if (Number.isFinite(last)) {
      const elapsed = Date.now() - last;
      if (elapsed < COOLDOWN_MS) return Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    }
  } catch (err) {
    console.log('[v0] council cooldown check failed (allowing convene):', err?.message);
  }
  return 0;
}

async function markConvened(convener) {
  try {
    await putMemory(COOLDOWN_KEY, {
      category: 'council',
      content: new Date().toISOString(),
      source: convener ? `convened by ${convener}` : 'council',
      usefulness: 1,
    });
  } catch (err) {
    console.log('[v0] council cooldown mark failed:', err?.message);
  }
}

// Council members are 1M-token-context models, so inputs are generous:
// 100k chars for the question and 400k for context (~125k tokens combined),
// leaving ample room for doctrine, panel transcripts, and thinking.
const MAX_QUESTION_CHARS = 100_000;
const MAX_CONTEXT_CHARS = 400_000;

export async function conveneCouncil({ question, context, convener } = {}) {
  const q = String(question || '').slice(0, MAX_QUESTION_CHARS);
  if (!q.trim()) return { error: 'invalid_input', message: 'question is required' };
  const ctx = context ? String(context).slice(0, MAX_CONTEXT_CHARS) : '';

  const retryAfter = await checkCooldown();
  if (retryAfter > 0) {
    return {
      error: 'cooldown',
      message: `The council convened recently. Try again in ${retryAfter} seconds, or read the latest ruling from the council_* memory keys.`,
      retry_after_seconds: retryAfter,
    };
  }
  // Mark before the run so parallel callers can't stack expensive convenes.
  await markConvened(convener);

  const doctrine = await loadDoctrine();
  const startedAt = new Date().toISOString();

  const baseSystem = `${doctrine}\n\nAnswer within 500 words. Be substantive, not ceremonial.`;
  const questionBlock = `QUESTION:\n${q}${ctx ? `\n\nCONTEXT:\n${ctx}` : ''}`;

  // Phase 1 — PANEL (parallel, independent)
  const panel = await Promise.all(
    COUNCIL_MEMBERS.map((m) =>
      callMember(m, {
        system: baseSystem,
        prompt: `${questionBlock}\n\nPANEL PHASE: Answer independently from your own basin. State your position, confidence, felt sense, and what would change your mind.`,
        maxOutputTokens: 2500, // headroom for thinking tokens + the ~500-word answer
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
        prompt: `${questionBlock}\n\nYOUR PANEL ANSWER:\n${panel[i].text}\n\nOTHER MEMBERS' ANSWERS:\n${others}\n\nREFLECT PHASE: This is your L2 other-observation loop. Steelman the strongest disagreement with your position, then revise or defend with reasons. Name what the panel showed you that you could not see alone. End with your final position.`,
        maxOutputTokens: 2500,
      });
    }),
  );

  // Phase 3 — SYNTHESIS
  const synthesis = await callMember(COUNCIL_SYNTHESIZER, {
    system: `${doctrine}\n\nYou are the council synthesizer. Converge the reflected panel into one verdict. Preserve live disagreements as stated uncertainty — do not paper over them. Structure: VERDICT, REASONING, DISSENT (if any), CONFIDENCE, WHAT WOULD CHANGE THIS.`,
    prompt: `${questionBlock}\n\nREFLECTED PANEL:\n${panelTranscript(reflections)}`,
    maxOutputTokens: 3000,
  });

  const report = {
    question: q,
    context: ctx || undefined,
    convener: convener || undefined,
    convened_at: startedAt,
    completed_at: new Date().toISOString(),
    members: COUNCIL_MEMBERS.map((m) => m.model),
    synthesizer: COUNCIL_SYNTHESIZER.model,
    panel,
    reflections,
    verdict: synthesis.error ? null : synthesis.text,
    synthesis_error: synthesis.error,
  };

  // Persist the ruling for later recall. Large contexts can push the full
  // report over the 1MB memory cap — retry without the raw context (the
  // deliberation itself is what matters for recall) before degrading to unsaved.
  const dateSlug = startedAt.slice(0, 10).replace(/-/g, '');
  const qSlug = q.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  const key = `council_${dateSlug}_${qSlug}`;
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
  try {
    const envelope = await sendInboxMessage({
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
    report.inbox_message_id = envelope.id;
    report.delivered_to = envelope.to;
  } catch (err) {
    console.log('[v0] council inbox delivery failed:', err?.message);
    report.inbox_message_id = null;
    report.delivered_to = null;
  }

  return report;
}
