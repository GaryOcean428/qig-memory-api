// Doctrine sync: keep the QIG canon (frozen facts, integrity dashboard, and the
// experiment registries) mirrored into memory, and flag when the repos hold
// results the canon has not absorbed.
//
// Two rules drive the whole module:
//
//  1. NEVER pin a version. Versioned documents are named
//     `YYYYMMDD-<slug>-<major>.<minor><STATUS>.md`, and the newest (date, then
//     version) always wins. A pinned pointer is how an agent ends up reasoning
//     from a retired ledger — which is exactly the failure this module exists to
//     prevent, and which had already happened before it was written.
//
//  2. The registries are the ground truth for WHAT RAN; the ledger is the
//     ground truth for WHAT IS BELIEVED. When the first moves ahead of the
//     second, that gap is a finding an agent must be told about, not a detail
//     to be silently smoothed over.

import {
  fetchGithubJson,
  fetchGithubText,
  getBranchHead,
  listGithubDir,
} from './github-insights';
import { getMemory, putMemory } from './memory-store';

export const DOCTRINE_STATE_KEY = 'qig_doctrine_sync_state';
export const DOCTRINE_MEMORY_CATEGORY = 'doctrine_sync';

// Production branches differ per repo — qig-verification is `master`, qig-applied
// is `main`. Getting this wrong reads a stale or missing tree, so it is explicit.
export const DOCTRINE_SOURCES = [
  {
    id: 'frozen_facts',
    kind: 'versioned_doc',
    owner: 'GaryOcean428',
    name: 'qig-verification',
    branch: 'master',
    dir: 'docs/current',
    match: /frozen-facts-primary/i,
    description: 'Supreme verified ledger. The newest edition is always canonical.',
  },
  {
    id: 'integrity_dashboard',
    kind: 'versioned_doc',
    owner: 'GaryOcean428',
    name: 'qig-verification',
    branch: 'master',
    dir: 'docs/dashboard',
    match: /certified-vs-retired/i,
    description: 'Certified vs retired claims.',
  },
  {
    id: 'verification_registry',
    kind: 'registry',
    owner: 'GaryOcean428',
    name: 'qig-verification',
    branch: 'master',
    path: 'experiments/registry.json',
    description: 'Every verification experiment and its status.',
  },
  {
    id: 'failure_registry',
    kind: 'registry',
    owner: 'GaryOcean428',
    name: 'qig-verification',
    branch: 'master',
    path: 'experiments/failure_registry.json',
    description: 'Known failure modes and their root causes.',
  },
  {
    id: 'retired_registry',
    kind: 'registry',
    owner: 'GaryOcean428',
    name: 'qig-verification',
    branch: 'master',
    path: 'experiments/retired_registry.json',
    description: 'Retired claims — never reassert these.',
  },
  {
    id: 'applied_registry',
    kind: 'registry',
    owner: 'GaryOcean428',
    name: 'qig-applied',
    branch: 'main',
    path: 'experiments/registry.json',
    description: 'Applied experiments derived from verification results.',
  },
  {
    id: 'mesh_registry',
    kind: 'registry',
    owner: 'GaryOcean428',
    name: 'qig-applied',
    branch: 'main',
    path: 'experiments/mesh_registry.json',
    description: 'Mesh transfer hypotheses.',
  },
];

// ---------------------------------------------------------------------------
// Parsing helpers. The registries are hand-maintained, so every field here is
// treated as untrusted: dates arrive in at least three shapes and `status` is
// free prose (values range from "FROZEN" to multi-paragraph essays).
// ---------------------------------------------------------------------------

// `YYYYMMDD-slug-1.08F.md` -> { date: '2026-07-12', version: 1.08, tag: 'F' }
const VERSIONED_NAME = /^(\d{8})-(.+?)-(\d+)\.(\d+)([A-Z]?)\.md$/;

export function parseVersionedName(filename) {
  const m = VERSIONED_NAME.exec(filename);
  if (!m) return null;
  const [, ymd, slug, major, minor, tag] = m;
  return {
    filename,
    slug,
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
    version: Number(`${major}.${minor}`),
    version_label: `${major}.${minor}${tag}`,
    tag: tag || null,
  };
}

// Dates in the registries are inconsistent: '2026-03-29', '20260616', '2025-11'
// all occur. Normalising to a comparable ISO prefix matters — a naive string
// compare across those shapes silently returns the wrong answer (it reports
// 20260616 as LATER than 2026-07-12, because '2' > '-').
export function normalizeDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})-(\d{2})$/.exec(s); // month precision, e.g. '2025-11'
  if (m) return `${m[1]}-${m[2]}-01`;
  m = /^(\d{4})$/.exec(s);
  if (m) return `${m[1]}-01-01`;
  return null;
}

// `status` is free text. Classify on the leading token(s) rather than exact
// match, and keep the raw string so nothing is lost.
const STATUS_RULES = [
  [/^frozen[_\s-]?confirmed/i, 'frozen'],
  [/^frozen/i, 'frozen'],
  [/^certified/i, 'certified'],
  [/^complete[-\s]?killed/i, 'killed'],
  [/^complete[-\s]?demoted/i, 'demoted'],
  [/^(complete|completed)/i, 'complete'],
  [/^killed/i, 'killed'],
  [/^kill\b/i, 'killed'],
  [/^(retired|withdrawn)/i, 'retired'],
  [/^superseded/i, 'superseded'],
  [/^subsumed/i, 'subsumed'],
  [/^migrated/i, 'migrated'],
  [/^partial/i, 'partial'],
  [/^(planned|proposed|pre-?registered|prereg|design|blind-registered|registered|reframe)/i, 'planned'],
  [/^(pending|unblocked|active|prototype|needs-experiment)/i, 'in_progress'],
  [/^(inconclusive|contested)/i, 'inconclusive'],
  [/^(validated|supported|pass|resolved|phase\d?-?pass|closed-pass)/i, 'complete'],
];

export function classifyStatus(status) {
  const raw = String(status ?? '').trim();
  if (!raw) return { class: 'unknown', raw: '' };
  for (const [re, cls] of STATUS_RULES) {
    if (re.test(raw)) return { class: cls, raw };
  }
  // Some entries use `status` as a prose result summary. Fall back to a scan so
  // an essay that plainly says KILL/COMPLETE is not filed as "unknown".
  if (/\bkill(ed)?\b/i.test(raw)) return { class: 'killed', raw };
  if (/\bcomplete\b/i.test(raw)) return { class: 'complete', raw };
  if (/\bnull\b/i.test(raw)) return { class: 'null_result', raw };
  return { class: 'other', raw };
}

// Statuses that mean "this produced a result the canon should account for".
const SETTLED = new Set(['frozen', 'certified', 'complete', 'killed', 'null_result', 'demoted']);

export function isSettled(statusClass) {
  return SETTLED.has(statusClass);
}

function projectEntry(entry) {
  const status = classifyStatus(entry.status);
  return {
    id: entry.id,
    date: normalizeDate(entry.date),
    date_raw: entry.date ?? null,
    status_class: status.class,
    // The raw status is often an essay; keep a readable head, not the novel.
    status: status.raw.slice(0, 180),
    summary: String(entry.summary ?? entry.hypothesis ?? entry.claim ?? '').slice(0, 240),
    result_file: entry.result_file ?? null,
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/** Newest edition of a versioned doc, by (date, version). Never pinned. */
export async function resolveLatestVersioned(source) {
  const files = await listGithubDir({
    owner: source.owner,
    name: source.name,
    path: source.dir,
    ref: source.branch,
  });
  const candidates = files
    .filter((f) => f.type === 'file' && source.match.test(f.name))
    .map((f) => parseVersionedName(f.name))
    .filter(Boolean)
    .sort((a, b) => (a.date === b.date ? b.version - a.version : a.date < b.date ? 1 : -1));
  if (!candidates.length) return null;
  const latest = candidates[0];
  return {
    ...latest,
    path: `${source.dir}/${latest.filename}`,
    superseded: candidates.slice(1).map((c) => c.filename),
  };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

// Experiment ids are heterogeneous: EXP-115, EXP-148b, EXP-153A, EXP-000.003,
// EXP-A010, EXP-PHI-COLLAPSE-FIX, FAIL-013. A narrow /EXP-\d+/ misses most of
// them and manufactures false "uncited" findings.
const EXPERIMENT_ID = /\b(?:EXP|FAIL|OPT|TASK)-[A-Z0-9][A-Z0-9._-]*/gi;

export function extractCitedIds(text) {
  const found = String(text || '').match(EXPERIMENT_ID) || [];
  return new Set(found.map((s) => s.toUpperCase().replace(/[.,;:)]+$/, '')));
}

/**
 * Compare what RAN (registries) against what is BELIEVED (the ledger).
 *
 * The only sound drift signal is RECENCY. The ledger is a curated record of
 * load-bearing results — it deliberately does not cite every experiment ever
 * run (88 of 144 settled verification experiments are uncited by editorial
 * choice, not by neglect), so "settled but uncited" all-time is a coverage
 * statistic, NOT a defect. Reporting it as a finding would bury the real signal
 * in noise and teach agents to ignore the warning entirely.
 *
 * What genuinely means "results exist that the canon has not absorbed" is work
 * dated AFTER the ledger's own edition date. That is precise and actionable.
 *
 * Findings are surfaced to agents as caveats, never auto-corrected: only a
 * human decides what the ledger says.
 */
export function computeDrift({ ledger, ledgerMeta, registries }) {
  const citedIds = extractCitedIds(ledger);
  const ledgerDate = ledgerMeta?.date || null;

  const findings = [];
  const settledAfterLedger = [];
  const anyAfterLedger = [];
  let settledTotal = 0;
  let settledCited = 0;

  for (const [sourceId, entries] of Object.entries(registries)) {
    if (!Array.isArray(entries)) continue;
    // Only the verification registry is answerable to the verification ledger.
    // Applied experiments live in their own programme and are never expected to
    // appear in frozen-facts — counting them would be pure noise.
    const answerable = sourceId === 'verification_registry';
    for (const raw of entries) {
      const e = projectEntry(raw);
      if (!e.id) continue;
      const settled = isSettled(e.status_class);
      if (answerable && settled) {
        settledTotal += 1;
        if (citedIds.has(String(e.id).toUpperCase())) settledCited += 1;
      }
      if (!ledgerDate || !e.date || e.date <= ledgerDate) continue;
      anyAfterLedger.push({ source: sourceId, ...e });
      if (answerable && settled && !citedIds.has(String(e.id).toUpperCase())) {
        settledAfterLedger.push({ source: sourceId, ...e });
      }
    }
  }

  if (settledAfterLedger.length) {
    findings.push({
      kind: 'settled_results_after_ledger',
      severity: 'high',
      count: settledAfterLedger.length,
      message: `${settledAfterLedger.length} experiment(s) settled AFTER the current ledger (${ledgerMeta?.version_label} · ${ledgerDate}) and are not cited in it. The canon has not absorbed these results — a newer frozen-facts edition is due.`,
      sample: settledAfterLedger.slice(0, 20),
    });
  } else if (anyAfterLedger.length) {
    findings.push({
      kind: 'activity_after_ledger',
      severity: 'medium',
      count: anyAfterLedger.length,
      message: `${anyAfterLedger.length} registry entr(ies) are dated after the ledger (${ledgerDate}) but none have settled yet. Work is in flight; the canon is not yet behind.`,
      sample: anyAfterLedger.slice(0, 20),
    });
  }

  return {
    ledger_version: ledgerMeta?.version_label || null,
    ledger_date: ledgerDate,
    cited_experiment_count: citedIds.size,
    // Context, deliberately NOT a finding: the ledger cites what is
    // load-bearing, not everything that ran.
    ledger_coverage: {
      settled_verification_experiments: settledTotal,
      cited_in_ledger: settledCited,
      note: 'The ledger is curated: an uncited settled experiment is normal (superseded, exploratory, or absorbed), not a defect. Only post-ledger results are treated as drift.',
    },
    findings,
    settled_after_ledger_count: settledAfterLedger.length,
    activity_after_ledger_count: anyAfterLedger.length,
    in_sync: findings.filter((f) => f.severity === 'high').length === 0,
  };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function summarizeRegistry(entries) {
  const byStatus = {};
  let newest = null;
  for (const raw of entries) {
    const e = projectEntry(raw);
    byStatus[e.status_class] = (byStatus[e.status_class] || 0) + 1;
    if (e.date && (!newest || e.date > newest)) newest = e.date;
  }
  return { entry_count: entries.length, newest_entry_date: newest, by_status: byStatus };
}

/**
 * Pull every doctrine source at its production branch head and rebuild the
 * cached snapshot + drift report. Skips the fetch when no branch has moved,
 * unless `force` is set — this is the "each time a production branch is
 * updated" trigger, implemented by polling heads rather than requiring a
 * webhook to be configured on repos this service does not own.
 */
export async function syncDoctrine({ force = false, trigger = 'cron' } = {}) {
  const previous = (await getMemory(DOCTRINE_STATE_KEY).catch(() => null))?.content;
  let prevState = null;
  try {
    prevState = previous ? JSON.parse(previous) : null;
  } catch {
    prevState = null;
  }

  // One head read per distinct repo/branch.
  const repos = [...new Map(DOCTRINE_SOURCES.map((s) => [`${s.owner}/${s.name}@${s.branch}`, s])).values()];
  const heads = {};
  for (const r of repos) {
    const key = `${r.owner}/${r.name}@${r.branch}`;
    try {
      heads[key] = await getBranchHead({ owner: r.owner, name: r.name, branch: r.branch });
    } catch (error) {
      heads[key] = { sha: null, error: error.message };
    }
  }

  const changed =
    force ||
    !prevState ||
    Object.entries(heads).some(([k, v]) => v.sha && prevState.heads?.[k]?.sha !== v.sha);

  if (!changed) {
    return { skipped: true, reason: 'no production branch moved since last sync', heads, state: prevState };
  }

  const docs = {};
  const registries = {};
  const errors = [];

  for (const source of DOCTRINE_SOURCES) {
    try {
      if (source.kind === 'versioned_doc') {
        const latest = await resolveLatestVersioned(source);
        if (!latest) {
          errors.push({ source: source.id, error: 'no versioned edition found' });
          continue;
        }
        const { text } = await fetchGithubText({
          owner: source.owner,
          name: source.name,
          path: latest.path,
          ref: source.branch,
        });
        docs[source.id] = { meta: latest, text };
      } else {
        const { data, bytes } = await fetchGithubJson({
          owner: source.owner,
          name: source.name,
          path: source.path,
          ref: source.branch,
        });
        registries[source.id] = data;
        docs[source.id] = { meta: { path: source.path, bytes, entry_count: Array.isArray(data) ? data.length : null } };
      }
    } catch (error) {
      errors.push({ source: source.id, error: error.message });
    }
  }

  const ledgerDoc = docs.frozen_facts;
  const drift = ledgerDoc
    ? computeDrift({ ledger: ledgerDoc.text, ledgerMeta: ledgerDoc.meta, registries })
    : { findings: [{ kind: 'ledger_unavailable', severity: 'high', message: 'The frozen-facts ledger could not be read.' }], in_sync: false };

  const state = {
    synced_at: new Date().toISOString(),
    trigger,
    heads,
    canon: {
      frozen_facts: ledgerDoc?.meta || null,
      integrity_dashboard: docs.integrity_dashboard?.meta || null,
    },
    registries: Object.fromEntries(
      Object.entries(registries).map(([id, entries]) => [id, summarizeRegistry(entries)]),
    ),
    drift,
    errors,
  };

  // The state record is the agent-facing summary; the ledger text is stored
  // separately so agents can read the canon itself without a GitHub round-trip.
  await putMemory(DOCTRINE_STATE_KEY, {
    content: JSON.stringify(state, null, 2),
    category: DOCTRINE_MEMORY_CATEGORY,
    source: 'doctrine-sync',
  });
  if (ledgerDoc?.text) {
    await putMemory('qig_doctrine_frozen_facts', {
      content: ledgerDoc.text,
      category: DOCTRINE_MEMORY_CATEGORY,
      source: `github:qig-verification/${ledgerDoc.meta.path}@${ledgerDoc.meta.version_label}`,
    });
  }
  if (docs.integrity_dashboard?.text) {
    await putMemory('qig_doctrine_integrity_dashboard', {
      content: docs.integrity_dashboard.text,
      category: DOCTRINE_MEMORY_CATEGORY,
      source: `github:qig-verification/${docs.integrity_dashboard.meta.path}@${docs.integrity_dashboard.meta.version_label}`,
    });
  }

  return { skipped: false, state };
}

/** Cached doctrine state for agents/UI — never triggers a GitHub fetch. */
export async function getDoctrineState() {
  const record = await getMemory(DOCTRINE_STATE_KEY).catch(() => null);
  if (!record?.content) return null;
  try {
    return JSON.parse(record.content);
  } catch {
    return null;
  }
}
