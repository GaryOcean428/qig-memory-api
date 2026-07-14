import { generateObject } from 'ai';
import { z } from 'zod';
import { listMemory, putMemory } from './memory-store';
import { sendInboxMessage } from './inbox-store';
import { collectAllRepoSignals } from './github-insights';
import { collectScienceArticles } from './science-insights';
import {
  DEFAULT_REVIEW_MODEL,
  getReviewerConfig,
  saveLatestReport,
  saveReviewerConfig,
} from './reviewer-config';

// The daily reviewer is the "don't smash credits" counterpart to helper_ask:
// it runs at most once per scheduled tick, makes a SINGLE model call, and
// broadcasts its findings to the inbox for local agents to consider. It never
// mutates anyone's memory beyond writing its own dated report record.

const MAX_MEMORY_RECORDS = 60;
const MAX_DIGEST_CHARS = 12_000;
const INSIGHT_TTL_DAYS = 14;

// Records that are pure machinery (kernel heartbeats/state, prior reviews) carry
// no lessons for pattern-mining, so we exclude them to keep the digest signal-rich.
const EXCLUDED_CATEGORIES = new Set(['kernel_agent', 'kernel_state', 'daily_review']);

const reportSchema = z.object({
  summary: z.string().describe('2-4 sentence overview of the current state of the memory corpus'),
  patterns: z
    .array(
      z.object({
        title: z.string(),
        severity: z.enum(['low', 'medium', 'high']),
        category: z.string().describe('e.g. bug, mistake, anti-pattern, workflow, knowledge-gap'),
        evidence: z.string().describe('what in the memories suggests this pattern'),
        recommendation: z.string(),
      }),
    )
    .max(8),
  repo_suggestions: z
    .array(
      z.object({
        repo: z.string(),
        observation: z.string(),
        suggestion: z.string(),
      }),
    )
    .max(8),
  science_links: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        relevance: z.string().describe('why this is worth an agent\u2019s attention'),
      }),
    )
    .max(8),
});

function buildMemoryDigest(records) {
  const useful = records.filter((r) => !r._error && !EXCLUDED_CATEGORIES.has(r.category));
  let digest = '';
  const used = [];
  for (const r of useful) {
    const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '');
    const line = `- [${r.category || 'uncategorized'}] ${r.key}: ${content.replace(/\s+/g, ' ').slice(0, 400)}\n`;
    if (digest.length + line.length > MAX_DIGEST_CHARS) break;
    digest += line;
    used.push(r.key);
  }
  return { digest, used };
}

const SYSTEM_PROMPT = `You are the QIG daily memory reviewer. You analyze an agent memory corpus plus optional
GitHub repo activity and recent science, then produce concise, actionable insights for a mesh of autonomous agents.
Focus on RECURRING patterns: common mistakes, repeated bugs, anti-patterns, and knowledge gaps — not one-off notes.
Be specific and cite evidence from the provided material. Only include repo_suggestions when repo signals are given,
and only include science_links drawn from the provided article list (never invent URLs). Keep every field tight.`;

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// Run the full review. `trigger` is 'cron' or 'manual' (used only for telemetry).
export async function runDailyReview({ trigger = 'cron' } = {}) {
  const startedAt = new Date().toISOString();
  const config = await getReviewerConfig();

  if (!config.enabled && trigger === 'cron') {
    return { ok: false, skipped: true, reason: 'disabled', trigger };
  }

  // Gather inputs in parallel: a page of memory, repo signals, science articles.
  const [memoryPage, repoSignals, scienceArticles] = await Promise.all([
    listMemory({ limit: MAX_MEMORY_RECORDS }),
    collectAllRepoSignals(config.repos),
    collectScienceArticles(config.scienceTopics),
  ]);

  const { digest, used } = buildMemoryDigest(memoryPage.records || []);

  // Credit guard: if there is nothing meaningful to analyze, skip the model call.
  if (digest.length < 80 && repoSignals.length === 0 && scienceArticles.length === 0) {
    const status = 'skipped: no material to review';
    await saveReviewerConfig({ lastRunAt: startedAt, lastRunStatus: status });
    return { ok: false, skipped: true, reason: 'no_material', trigger };
  }

  const model = config.model || DEFAULT_REVIEW_MODEL;
  const prompt = [
    'MEMORY CORPUS (sampled):',
    digest || '(none)',
    '',
    'GITHUB SIGNALS:',
    JSON.stringify(repoSignals, null, 2),
    '',
    'RECENT SCIENCE ARTICLES (choose only from these for science_links):',
    JSON.stringify(scienceArticles, null, 2),
  ].join('\n');

  let report;
  try {
    const { object } = await generateObject({
      model,
      schema: reportSchema,
      system: SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: 2000,
      timeout: 55_000,
    });
    report = object;
  } catch (error) {
    const status = `error: ${error.message?.slice(0, 160)}`;
    await saveReviewerConfig({ lastRunAt: startedAt, lastRunStatus: status });
    return { ok: false, error: error.message, trigger };
  }

  const finishedAt = new Date().toISOString();
  const dateKey = finishedAt.slice(0, 10);
  const fullReport = {
    ...report,
    trigger,
    model,
    generated_at: finishedAt,
    inputs: {
      memory_records_reviewed: used.length,
      repos_scanned: repoSignals.map((s) => s.repo),
      science_topics: config.scienceTopics,
      science_articles_found: scienceArticles.length,
    },
  };

  // Persist: a dated memory record (durable, searchable) + the latest-report
  // pointer the admin UI reads.
  await putMemory(`daily_review_${dateKey}`, {
    category: 'daily_review',
    content: JSON.stringify(fullReport),
    source: `daily-reviewer:${trigger}`,
  }).catch(() => {});
  await saveLatestReport(fullReport).catch(() => {});

  // Broadcast one consolidated insight to the qig namespace so every connected
  // agent can pull it via inbox_list / inbox_read. Expires after two weeks.
  let broadcastId = null;
  try {
    const sent = await sendInboxMessage({
      from: 'daily-reviewer',
      to: 'broadcast',
      namespace: 'qig',
      type: 'insight',
      subject: `Daily review ${dateKey}: ${report.patterns.length} pattern(s), ${report.science_links.length} link(s)`,
      payload: fullReport,
      expires_at: daysFromNow(INSIGHT_TTL_DAYS),
    });
    broadcastId = sent.id;
  } catch {
    /* inbox delivery is best-effort; the report is already persisted */
  }

  await saveReviewerConfig({
    lastRunAt: finishedAt,
    lastRunStatus: `ok: ${report.patterns.length} patterns, ${report.repo_suggestions.length} repo suggestions, ${report.science_links.length} links`,
  });

  return { ok: true, trigger, broadcastId, report: fullReport };
}
