import { z } from 'zod';
import { readPrivateJson, writePrivateJson } from './private-blob';
import { DEFAULT_MODEL } from './models';

// The daily-reviewer configuration is small operator state: which repos to scan,
// which science topics to track, and the run cadence bookkeeping. It lives in one
// private blob so both the cron job and the session-gated admin actions share a
// single source of truth (mirrors how inbox/artifact metadata is stored).
const CONFIG_PATH = 'reviewer/config.json';
const REPORT_PATH = 'reviewer/latest.json';

// The review model matches the helper agent's default so we depend on ONE model
// id and one resilience policy (lib/models.js). Declared as a LOCAL const — not
// `export { DEFAULT_MODEL as DEFAULT_REVIEW_MODEL } from './models'` — because a
// re-export creates no local binding and reviewerConfigSchema references it below.
export const DEFAULT_REVIEW_MODEL = DEFAULT_MODEL;

// Sensible QIG-relevant starting topics so the science scan is useful on day one
// even before an operator customizes it.
export const DEFAULT_SCIENCE_TOPICS = [
  'information geometry',
  'Fisher-Rao metric',
  'natural gradient optimization',
  'multi-agent coordination',
];

const repoSchema = z.object({
  owner: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, 'invalid GitHub owner'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, 'invalid GitHub repo name'),
  note: z.string().trim().max(200).optional().default(''),
});

export const reviewerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  repos: z.array(repoSchema).max(8).default([]),
  scienceTopics: z.array(z.string().trim().min(1).max(120)).max(8).default(DEFAULT_SCIENCE_TOPICS),
  model: z.string().trim().min(1).max(120).default(DEFAULT_REVIEW_MODEL),
  lastRunAt: z.string().datetime().nullable().default(null),
  lastRunStatus: z.string().max(200).nullable().default(null),
});

function withDefaults(raw) {
  // Parse-with-defaults so a partial or legacy blob still yields a complete config.
  return reviewerConfigSchema.parse({
    enabled: raw?.enabled ?? true,
    repos: Array.isArray(raw?.repos) ? raw.repos : [],
    scienceTopics: Array.isArray(raw?.scienceTopics) && raw.scienceTopics.length ? raw.scienceTopics : DEFAULT_SCIENCE_TOPICS,
    model: raw?.model || DEFAULT_REVIEW_MODEL,
    lastRunAt: raw?.lastRunAt ?? null,
    lastRunStatus: raw?.lastRunStatus ?? null,
  });
}

export async function getReviewerConfig() {
  const found = await readPrivateJson(CONFIG_PATH);
  return withDefaults(found?.data);
}

// Merge a validated patch over the current config and persist. Returns the saved config.
export async function saveReviewerConfig(patch = {}) {
  const current = await getReviewerConfig();
  const next = withDefaults({ ...current, ...patch });
  await writePrivateJson(CONFIG_PATH, next, { allowOverwrite: true });
  return next;
}

export async function getLatestReport() {
  const found = await readPrivateJson(REPORT_PATH);
  return found?.data ?? null;
}

export async function saveLatestReport(report) {
  await writePrivateJson(REPORT_PATH, report, { allowOverwrite: true });
  return report;
}
