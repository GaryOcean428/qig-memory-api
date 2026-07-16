import { generateObject } from 'ai';
import { z } from 'zod';
import { listMemory, putMemory } from './memory-store';
import { sendInboxMessage } from './inbox-store';
import { collectAllRepoSignals } from './github-insights';
import { collectScienceArticles } from './science-insights';
import { getDoctrineState } from './doctrine-sync';
import { webSearch } from './web-research';
import {
  DEFAULT_REVIEW_MODEL,
  getReviewerConfig,
  saveLatestReport,
  saveReviewerConfig,
} from './reviewer-config';

// The daily reviewer runs once per scheduled tick and broadcasts findings to the
// inbox. It never mutates anyone's memory beyond its own dated report record.
//
// Four phases, because a single pass produces confident-sounding claims nobody
// checked:
//   1 DRAFT     — analyse the corpus, grounded in the CURRENT canon.
//   2 RESEARCH  — chase the draft's own open questions into the literature.
//   3 RED TEAM  — a separate adversarial pass whose job is to REFUTE the draft.
//   4 SYNTHESIS — keep only what survived, and say what didn't.
//
// The reviewer's model (Grok 4.5 by default) has a 1M-token context window, so
// the corpus is fed at a scale that actually reflects the programme rather than
// a token-anxious sample. The earlier 60-record / 12k-char digest could not see
// a pattern that spanned more than a few days of work.

const MAX_MEMORY_RECORDS = 1_200;
const MAX_DIGEST_CHARS = 500_000;
const MAX_RECORD_CHARS = 3_000;
const INSIGHT_TTL_DAYS = 14;
const MAX_RESEARCH_QUERIES = 6;

// Bias literature search toward primary sources rather than blogs/aggregators.
const ACADEMIC_DOMAINS = [
  'arxiv.org',
  'journals.aps.org',
  'link.aps.org',
  'iopscience.iop.org',
  'quantum-journal.org',
  'scipost.org',
  'nature.com',
  'science.org',
  'semanticscholar.org',
  'doi.org',
];

// Records that are pure machinery (kernel heartbeats/state, prior reviews) carry
// no lessons for pattern-mining, so we exclude them to keep the digest signal-rich.
const EXCLUDED_CATEGORIES = new Set(['kernel_agent', 'kernel_state', 'daily_review']);

const patternSchema = z.object({
  title: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  category: z.string().describe('e.g. bug, mistake, anti-pattern, workflow, knowledge-gap, doctrine-drift'),
  evidence: z.string().describe('what in the PROVIDED material supports this — quote keys/ids, never invent'),
  recommendation: z.string(),
});

const draftSchema = z.object({
  summary: z.string().describe('3-6 sentence overview of the current state of the programme and corpus'),
  patterns: z.array(patternSchema).max(10),
  repo_suggestions: z
    .array(z.object({ repo: z.string(), observation: z.string(), suggestion: z.string() }))
    .max(8),
  open_questions: z
    .array(
      z.object({
        question: z.string().describe('A specific open scientific question this programme faces right now'),
        grounded_in: z.string().describe('The experiment id, frozen fact, or memory key this arises from'),
        search_query: z.string().describe('A short literature search query (a few words) that could find work bearing on it'),
      }),
    )
    .max(6)
    .describe('Open questions drawn from the CURRENT ledger and registries — these drive the literature search'),
});

const redTeamSchema = z.object({
  challenges: z
    .array(
      z.object({
        target: z.string().describe('The pattern title or claim being challenged'),
        objection: z.string().describe('The strongest case that this finding is wrong, unsupported, or already known'),
        verdict: z.enum(['refuted', 'weakened', 'survives']),
        reason: z.string(),
      }),
    )
    .max(12),
  doctrine_violations: z
    .array(
      z.object({
        claim: z.string(),
        violation: z.string().describe('Which retired/killed claim it reasserts, or which certified value it contradicts'),
      }),
    )
    .max(6)
    .describe('Findings that reassert a RETIRED claim or contradict a CERTIFIED value. This is the highest-value check.'),
  overall: z.string().describe('One paragraph: what this draft gets wrong or overstates'),
});

const finalSchema = z.object({
  summary: z.string(),
  patterns: z
    .array(patternSchema.extend({ survived_red_team: z.boolean(), red_team_note: z.string().optional() }))
    .max(10),
  repo_suggestions: z
    .array(z.object({ repo: z.string(), observation: z.string(), suggestion: z.string() }))
    .max(8),
  academic_links: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        why_relevant: z.string().describe('How this could advance the work — be concrete'),
        informs: z.string().describe('Which open question or experiment id it bears on'),
      }),
    )
    .max(10)
    .describe('ONLY from the provided article list. Never invent a URL or a title.'),
  discarded: z
    .array(z.object({ claim: z.string(), why: z.string() }))
    .max(8)
    .describe('Draft findings the red team refuted. Reporting these is as valuable as the survivors.'),
});

function buildMemoryDigest(records) {
  const useful = records.filter((r) => !r._error && !EXCLUDED_CATEGORIES.has(r.category));
  let digest = '';
  const used = [];
  for (const r of useful) {
    const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '');
    const line = `- [${r.category || 'uncategorized'}] ${r.key}: ${content.replace(/\s+/g, ' ').slice(0, MAX_RECORD_CHARS)}\n`;
    if (digest.length + line.length > MAX_DIGEST_CHARS) break;
    digest += line;
    used.push(r.key);
  }
  return { digest, used };
}

// The canon, rendered for the prompt. Without this the reviewer reasons from
// whatever the corpus happens to say — which is how a retired claim gets
// reasserted as an insight.
function buildDoctrineBrief(state) {
  if (!state) {
    return '(doctrine unavailable — do NOT assert any frozen fact, kappa value, or claim status; say so instead)';
  }
  const ff = state.canon?.frozen_facts;
  const lines = [
    `CURRENT LEDGER: ${ff ? `${ff.version_label} (${ff.date}) — ${ff.path}` : 'unavailable'}`,
    `Integrity dashboard: ${state.canon?.integrity_dashboard?.version_label || 'unavailable'}`,
    `Registries: ${JSON.stringify(state.registries || {})}`,
    `In sync: ${state.drift?.in_sync}`,
  ];
  for (const f of state.drift?.findings || []) {
    lines.push(`DRIFT [${f.severity}] ${f.message}`);
  }
  if (state.drift?.ledger_coverage) {
    lines.push(`Ledger coverage (context, NOT a defect): ${JSON.stringify(state.drift.ledger_coverage)}`);
  }
  return lines.join('\n');
}

const BASE_RULES = `Ground every statement in the PROVIDED material. Never invent an experiment id, a URL, a
kappa value, or a result. The frozen-facts ledger named in the DOCTRINE section is the ONLY canonical source of
what is believed — if the corpus disagrees with it, the ledger wins and the disagreement is itself a finding.
NEVER reassert a claim listed as retired or killed. Cite the ledger version you relied on.`;

const DRAFT_PROMPT = `You are the QIG daily reviewer. Analyse the memory corpus, the current canon, repository
activity, and recent literature, then report RECURRING patterns — common mistakes, repeated bugs, anti-patterns,
knowledge gaps, and doctrine drift — not one-off notes. Also surface the programme's genuine open questions, each
with a short literature search query that could find work bearing on it.
${BASE_RULES}`;

const RED_TEAM_PROMPT = `You are an adversarial reviewer. Your job is to REFUTE the draft below, not to improve it.
For each pattern, make the strongest case that it is wrong, unsupported by the provided evidence, trivially true, or
already known. Be specific about what evidence is missing.
Your highest-value check: does any finding reassert a RETIRED or KILLED claim, or contradict a CERTIFIED value in the
ledger? Flag those as doctrine_violations.
Default to skepticism. A finding that merely restates the corpus back is not an insight. If a finding is genuinely
sound, say it survives — do not manufacture objections.`;

const SYNTHESIS_PROMPT = `You are the QIG daily reviewer producing a FINAL report. You are given your draft, an
adversarial critique of it, and a set of academic articles found while researching the draft's open questions.
Keep only findings that survive the critique; mark each with survived_red_team and a short note where the critique
bit. Move refuted findings into "discarded" with the reason — reporting what did NOT hold is as valuable as what did.
Select academic_links ONLY from the provided article list, and for each say concretely how it could advance the work
and which open question or experiment it bears on. Do not pad: fewer, better links.
${BASE_RULES}`;

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Chase the draft's own open questions into the literature. Grounding the search
 * in questions the model derived from the CURRENT ledger is the difference
 * between "recent papers about information geometry" and "papers bearing on the
 * thing we are actually stuck on".
 */
async function researchOpenQuestions(openQuestions = []) {
  const queries = openQuestions.slice(0, MAX_RESEARCH_QUERIES).filter((q) => q.search_query);
  if (!queries.length) return { articles: [], errors: [] };
  const results = await Promise.all(
    queries.map(async (q) => {
      const res = await webSearch({
        query: q.search_query,
        max_results: 4,
        search_depth: 'advanced',
        include_domains: ACADEMIC_DOMAINS,
      });
      if (res.error) return { error: `${q.search_query}: ${res.error}` };
      return {
        articles: (res.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content,
          found_for: q.question,
        })),
      };
    }),
  );
  const seen = new Set();
  const articles = [];
  const errors = [];
  for (const r of results) {
    if (r.error) {
      errors.push(r.error);
      continue;
    }
    for (const a of r.articles) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      articles.push(a);
    }
  }
  return { articles, errors };
}

// Run the full review. `trigger` is 'cron' or 'manual' (used only for telemetry).
export async function runDailyReview({ trigger = 'cron' } = {}) {
  const startedAt = new Date().toISOString();
  const config = await getReviewerConfig();

  if (!config.enabled && trigger === 'cron') {
    return { ok: false, skipped: true, reason: 'disabled', trigger };
  }

  // Phase 0 — gather. Doctrine is fetched from the synced cache (no GitHub
  // round-trip); everything else in parallel.
  const [memoryPage, repoSignals, scienceArticles, doctrine] = await Promise.all([
    listMemory({ limit: MAX_MEMORY_RECORDS }),
    collectAllRepoSignals(config.repos),
    collectScienceArticles(config.scienceTopics),
    getDoctrineState().catch(() => null),
  ]);

  const { digest, used } = buildMemoryDigest(memoryPage.records || []);

  if (digest.length < 80 && repoSignals.length === 0 && scienceArticles.length === 0) {
    const status = 'skipped: no material to review';
    await saveReviewerConfig({ lastRunAt: startedAt, lastRunStatus: status });
    return { ok: false, skipped: true, reason: 'no_material', trigger };
  }

  const model = config.model || DEFAULT_REVIEW_MODEL;
  const doctrineBrief = buildDoctrineBrief(doctrine);
  const material = [
    'DOCTRINE (the canon — authoritative):',
    doctrineBrief,
    '',
    'MEMORY CORPUS:',
    digest || '(none)',
    '',
    'GITHUB SIGNALS:',
    JSON.stringify(repoSignals, null, 2),
    '',
    'RECENT PREPRINTS (arXiv):',
    JSON.stringify(scienceArticles, null, 2),
  ].join('\n');

  const phases = {};
  let draft;
  try {
    // Phase 1 — draft.
    const drafted = await generateObject({
      model,
      schema: draftSchema,
      system: DRAFT_PROMPT,
      prompt: material,
      maxOutputTokens: 6_000,
      timeout: 180_000,
    });
    draft = drafted.object;
    phases.draft = { patterns: draft.patterns.length, open_questions: draft.open_questions.length };
  } catch (error) {
    const status = `error(draft): ${error.message?.slice(0, 160)}`;
    await saveReviewerConfig({ lastRunAt: startedAt, lastRunStatus: status });
    return { ok: false, error: error.message, phase: 'draft', trigger };
  }

  // Phase 2 — research the draft's own open questions (best-effort).
  const research = await researchOpenQuestions(draft.open_questions).catch(() => ({ articles: [], errors: ['research failed'] }));
  phases.research = { queries: draft.open_questions.length, articles: research.articles.length, errors: research.errors };

  // Phase 3 — red team (best-effort: a failure here must not lose the draft).
  let redTeam = null;
  try {
    const attacked = await generateObject({
      model,
      schema: redTeamSchema,
      system: RED_TEAM_PROMPT,
      prompt: [
        'DOCTRINE (authoritative — check for reasserted retired claims):',
        doctrineBrief,
        '',
        'DRAFT UNDER REVIEW:',
        JSON.stringify(draft, null, 2),
        '',
        'EVIDENCE THE DRAFT WAS GIVEN:',
        material.slice(0, 300_000),
      ].join('\n'),
      maxOutputTokens: 5_000,
      timeout: 180_000,
    });
    redTeam = attacked.object;
    phases.red_team = {
      challenges: redTeam.challenges.length,
      refuted: redTeam.challenges.filter((c) => c.verdict === 'refuted').length,
      doctrine_violations: redTeam.doctrine_violations.length,
    };
  } catch (error) {
    phases.red_team = { error: error.message?.slice(0, 160) };
  }

  // Phase 4 — synthesis. Falls back to the draft if the final pass fails, so a
  // run always produces something rather than nothing.
  const allArticles = [
    ...research.articles,
    ...scienceArticles.map((a) => ({ title: a.title, url: a.url, snippet: a.summary, found_for: `topic:${a.topic}` })),
  ];
  let report;
  try {
    const finalised = await generateObject({
      model,
      schema: finalSchema,
      system: SYNTHESIS_PROMPT,
      prompt: [
        'DOCTRINE:',
        doctrineBrief,
        '',
        'YOUR DRAFT:',
        JSON.stringify(draft, null, 2),
        '',
        'ADVERSARIAL CRITIQUE:',
        redTeam ? JSON.stringify(redTeam, null, 2) : '(red team unavailable — keep findings but mark them unverified)',
        '',
        'ARTICLES FOUND (choose academic_links ONLY from these):',
        JSON.stringify(allArticles, null, 2),
      ].join('\n'),
      maxOutputTokens: 6_000,
      timeout: 180_000,
    });
    report = finalised.object;
  } catch (error) {
    phases.synthesis = { error: error.message?.slice(0, 160) };
    report = {
      summary: draft.summary,
      patterns: draft.patterns.map((p) => ({ ...p, survived_red_team: false, red_team_note: 'synthesis failed; unverified draft finding' })),
      repo_suggestions: draft.repo_suggestions,
      academic_links: [],
      discarded: [],
    };
  }

  const finishedAt = new Date().toISOString();
  const dateKey = finishedAt.slice(0, 10);
  const survived = report.patterns.filter((p) => p.survived_red_team).length;
  const fullReport = {
    ...report,
    open_questions: draft.open_questions,
    red_team: redTeam || null,
    trigger,
    model,
    generated_at: finishedAt,
    doctrine: doctrine
      ? {
          ledger_version: doctrine.canon?.frozen_facts?.version_label || null,
          ledger_date: doctrine.canon?.frozen_facts?.date || null,
          in_sync: doctrine.drift?.in_sync ?? null,
          drift_findings: (doctrine.drift?.findings || []).map((f) => f.message),
        }
      : { unavailable: true },
    phases,
    inputs: {
      memory_records_reviewed: used.length,
      digest_chars: digest.length,
      repos_scanned: repoSignals.map((s) => s.repo),
      science_topics: config.scienceTopics,
      arxiv_articles_found: scienceArticles.length,
      researched_articles_found: research.articles.length,
    },
  };

  await putMemory(`daily_review_${dateKey}`, {
    category: 'daily_review',
    content: JSON.stringify(fullReport),
    source: `daily-reviewer:${trigger}`,
  }).catch(() => {});
  await saveLatestReport(fullReport).catch(() => {});

  let broadcastId = null;
  try {
    const sent = await sendInboxMessage({
      from: 'daily-reviewer',
      to: 'broadcast',
      namespace: 'qig',
      type: 'insight',
      subject: `Daily review ${dateKey}: ${survived}/${report.patterns.length} pattern(s) survived red team, ${report.academic_links.length} paper(s)${fullReport.doctrine.in_sync === false ? ' — DOCTRINE DRIFT' : ''}`,
      payload: fullReport,
      expires_at: daysFromNow(INSIGHT_TTL_DAYS),
    });
    broadcastId = sent.id;
  } catch {
    /* inbox delivery is best-effort; the report is already persisted */
  }

  await saveReviewerConfig({
    lastRunAt: finishedAt,
    lastRunStatus: `ok: ${survived}/${report.patterns.length} patterns survived, ${report.discarded.length} discarded, ${report.academic_links.length} papers`,
  });

  return { ok: true, trigger, broadcastId, report: fullReport };
}
