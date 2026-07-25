// ---------------------------------------------------------------------------
// Failure pattern extraction — scans task_run_* records for failures and
// extracts reusable learned_pattern records. These patterns are then boosted
// in searchMemory when a query matches a known trigger, surfacing past
// solutions at the moment they're needed.
//
// Schema for learned_pattern records:
//   { trigger, failure, fix, confidence, occurrences, last_seen, source_keys }
// ---------------------------------------------------------------------------

import { listMemory, putMemory, getMemory } from './memory-store';

const LEARNED_PATTERN_CATEGORY = 'learned_pattern';
const TASK_RUN_PREFIX = 'task_run_';
const MAX_PATTERNS_PER_RUN = 10;
const MIN_CONFIDENCE = 0.5;

// Failure indicators in task_run content.
const FAILURE_INDICATORS = [
  'error', 'failed', 'failure', 'exception', 'timeout', 'crash', 'panic',
  'invalid', 'unexpected', 'unhandled', 'rejected', 'denied', 'unauthorized',
  'not_found', 'missing', 'corrupt', 'broken', 'regression', 'flaky',
];

// Extract failure patterns from task_run records.
export async function extractFailurePatterns() {
  const { records } = await listMemory({ prefix: TASK_RUN_PREFIX, all: true });

  const failures = records.filter((r) => {
    if (r._error) return false;
    const content = String(r.content || '').toLowerCase();
    const status = String(r.status || '').toLowerCase();
    return (
      status === 'failed' ||
      FAILURE_INDICATORS.some((ind) => content.includes(ind))
    );
  });

  if (!failures.length) return { extracted: 0, patterns: [] };

  // Group failures by error signature (simplified clustering).
  const clusters = new Map();
  for (const f of failures) {
    const content = String(f.content || '');
    // Extract a rough error signature: first line or first 100 chars.
    const signature = content.split('\n')[0].slice(0, 100).toLowerCase().trim();
    if (!signature) continue;

    if (!clusters.has(signature)) {
      clusters.set(signature, {
        signature,
        count: 0,
        keys: [],
        sample: content.slice(0, 500),
      });
    }
    const cluster = clusters.get(signature);
    cluster.count += 1;
    cluster.keys.push(f.key);
  }

  // Convert clusters to learned_pattern records.
  const patterns = [];
  for (const [signature, cluster] of clusters) {
    if (cluster.count < 1) continue; // Need at least 1 occurrence

    // Confidence scales with occurrence count (capped at 1.0).
    const confidence = Math.min(1, 0.4 + cluster.count * 0.15);
    if (confidence < MIN_CONFIDENCE) continue;

    // Generate a pattern key from the signature.
    const patternKey = `learned_${signature
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 40)
      .replace(/^_|_$/g, '')}`;

    patterns.push({
      key: patternKey,
      trigger: signature.slice(0, 120),
      failure: cluster.sample.slice(0, 300),
      fix: null, // To be filled by manual review or future inference
      confidence,
      occurrences: cluster.count,
      last_seen: new Date().toISOString(),
      source_keys: cluster.keys.slice(0, 10),
    });
  }

  // Sort by confidence and take top N.
  patterns.sort((a, b) => b.confidence - a.confidence || b.occurrences - a.occurrences);
  const topPatterns = patterns.slice(0, MAX_PATTERNS_PER_RUN);

  // Persist patterns (merge with existing if present).
  const persisted = [];
  for (const p of topPatterns) {
    const existing = await getMemory(p.key);
    const merged = existing
      ? {
          ...existing,
          occurrences: (existing.occurrences || 0) + p.occurrences,
          confidence: Math.max(existing.confidence || 0, p.confidence),
          last_seen: p.last_seen,
          source_keys: [...new Set([...(existing.source_keys || []), ...p.source_keys])].slice(0, 20),
        }
      : p;

    await putMemory(p.key, {
      category: LEARNED_PATTERN_CATEGORY,
      content: JSON.stringify(merged),
      source: 'failure_extraction',
      usefulness: Math.round(merged.confidence * 10),
    }).catch(() => {});

    persisted.push(merged);
  }

  return { extracted: persisted.length, patterns: persisted };
}

// Check if a query matches any known learned_pattern trigger.
// Returns a boost factor [0, 0.2] based on match quality.
export async function getPatternBoost(query) {
  if (!query) return 0;

  const { records } = await listMemory({ category: LEARNED_PATTERN_CATEGORY, all: true });
  const normalizedQuery = String(query).toLowerCase();

  let maxBoost = 0;
  for (const r of records) {
    if (r._error) continue;
    let pattern;
    try {
      pattern = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
    } catch {
      continue;
    }

    const trigger = String(pattern.trigger || '').toLowerCase();
    if (!trigger) continue;

    // Check for trigger match (substring or word overlap).
    if (normalizedQuery.includes(trigger) || trigger.includes(normalizedQuery)) {
      const boost = 0.1 + (pattern.confidence || 0.5) * 0.1;
      maxBoost = Math.max(maxBoost, boost);
    } else {
      // Word-level overlap.
      const queryWords = new Set(normalizedQuery.split(/\W+/).filter((w) => w.length > 2));
      const triggerWords = trigger.split(/\W+/).filter((w) => w.length > 2);
      const overlap = triggerWords.filter((w) => queryWords.has(w)).length;
      if (overlap >= 2) {
        const boost = 0.05 + (overlap / triggerWords.length) * 0.1 * (pattern.confidence || 0.5);
        maxBoost = Math.max(maxBoost, boost);
      }
    }
  }

  return Math.min(0.2, maxBoost);
}
