// ---------------------------------------------------------------------------
// Mode classifier — lightweight character-frequency + keyword attractor model.
// Ports the 5 attractors from headroom-qig-geo/geometry.py without requiring
// ML models. Classifies incoming query text into an operational mode, which
// searchMemory uses to boost records whose category/content matches.
//
// Attractors (from QIGGraph basin topology):
//   reasoning  — analytical, logical, mathematical, proof
//   tool_use   — imperative, API calls, function invocation, commands
//   creativity — generative, novel, imaginative, design
//   recovery   — error handling, debugging, fix, diagnose
//   output     — formatting, presentation, summary, report
// ---------------------------------------------------------------------------

export const MODES = ['reasoning', 'tool_use', 'creativity', 'recovery', 'output'];

// Keyword signatures per attractor. Weighted by specificity — common words
// score lower than mode-specific terms.
const ATTRACTOR_KEYWORDS = {
  reasoning: [
    'prove', 'theorem', 'lemma', 'derive', 'infer', 'logic', 'axiom', 'hypothesis',
    'analyze', 'analysis', 'compute', 'calculate', 'evaluate', 'reason', 'deduce',
    'implication', 'therefore', 'because', 'causal', 'correlation', 'inference',
    'mathematical', 'geometric', 'algebraic', 'topological', 'proof', 'verify',
    'validate', 'check', 'confirm', 'assess', 'measure', 'quantify', 'metric',
  ],
  tool_use: [
    'call', 'invoke', 'execute', 'run', 'api', 'endpoint', 'function', 'method',
    'command', 'cli', 'shell', 'bash', 'script', 'deploy', 'build', 'install',
    'fetch', 'request', 'response', 'http', 'rest', 'graphql', 'query', 'mutation',
    'tool', 'plugin', 'extension', 'module', 'import', 'require', 'package',
    'configure', 'setup', 'initialize', 'connect', 'authenticate', 'authorize',
  ],
  creativity: [
    'create', 'design', 'imagine', 'invent', 'novel', 'original', 'generate',
    'compose', 'craft', 'build', 'make', 'produce', 'develop', 'write', 'draw',
    'paint', 'sculpt', 'architect', 'brainstorm', 'ideate', 'conceptualize',
    'innovate', 'experiment', 'explore', 'discover', 'pioneer', 'prototype',
    'mockup', 'wireframe', 'sketch', 'draft', 'outline', 'storyboard', 'narrative',
  ],
  recovery: [
    'error', 'bug', 'fix', 'debug', 'diagnose', 'troubleshoot', 'resolve', 'repair',
    'recover', 'restore', 'rollback', 'revert', 'undo', 'patch', 'hotfix', 'workaround',
    'exception', 'failure', 'crash', 'panic', 'fault', 'broken', 'corrupt', 'invalid',
    'unexpected', 'unhandled', 'stack', 'trace', 'log', 'inspect', 'investigate',
    'root cause', 'regression', 'flaky', 'timeout', 'deadlock', 'race condition',
  ],
  output: [
    'format', 'present', 'display', 'render', 'show', 'print', 'export', 'report',
    'summarize', 'summary', 'conclusion', 'result', 'outcome', 'deliver', 'publish',
    'share', 'communicate', 'explain', 'describe', 'document', 'writeup', 'readme',
    'guide', 'tutorial', 'instruction', 'manual', 'specification', 'spec', 'schema',
    'template', 'layout', 'structure', 'organize', 'arrange', 'order', 'sequence',
  ],
};

// Character-frequency basin: 64-bin histogram of normalized character codes.
// Produces a simplex vector suitable for Fisher-Rao distance comparison.
function charFrequencyBasin(text) {
  const bins = new Array(64).fill(0);
  const normalized = String(text || '').toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    // Map printable ASCII (32-126) into 64 bins; non-ASCII folds into bin 63.
    const bin = code >= 32 && code <= 126 ? Math.floor(((code - 32) / 95) * 63) : 63;
    bins[Math.min(63, bin)]++;
  }
  const total = bins.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  // Laplace smoothing to avoid zeros on the simplex.
  const smoothed = bins.map((c) => (c + 1) / (total + 64));
  return smoothed;
}

// Classify text into an operational mode. Returns { mode, confidence, scores, basin }.
export function classifyMode(text) {
  const normalized = String(text || '').toLowerCase();
  const words = normalized.split(/\W+/).filter(Boolean);
  const wordSet = new Set(words);

  const scores = {};
  for (const mode of MODES) {
    const keywords = ATTRACTOR_KEYWORDS[mode];
    let hits = 0;
    for (const kw of keywords) {
      if (kw.includes(' ')) {
        // Multi-word phrase: check substring.
        if (normalized.includes(kw)) hits += 2;
      } else if (wordSet.has(kw)) {
        hits += 1;
      }
    }
    // Normalize by keyword count to avoid bias toward modes with more keywords.
    scores[mode] = hits / keywords.length;
  }

  // Find dominant mode.
  let mode = 'reasoning'; // default fallback
  let maxScore = -1;
  for (const [m, s] of Object.entries(scores)) {
    if (s > maxScore) {
      maxScore = s;
      mode = m;
    }
  }

  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0 ? maxScore / totalScore : 0.2;

  return {
    mode,
    confidence,
    scores,
    basin: charFrequencyBasin(text),
  };
}

// Category-to-mode affinity. Records in certain categories are more relevant
// to specific modes. Returns a boost factor [0, 1].
const CATEGORY_MODE_AFFINITY = {
  reasoning: ['experiment', 'research', 'analysis', 'doctrine', 'kernel_state', 'learned_pattern'],
  tool_use: ['tool', 'api', 'config', 'script', 'automation', 'task_run'],
  creativity: ['design', 'creative', 'draft', 'prototype', 'brainstorm'],
  recovery: ['error', 'bug', 'incident', 'debug', 'failure', 'learned_pattern'],
  output: ['report', 'summary', 'documentation', 'manual', 'guide', 'council'],
};

export function categoryModeBoost(category, mode) {
  if (!category || !mode) return 0;
  const affinity = CATEGORY_MODE_AFFINITY[mode];
  if (!affinity) return 0;
  const cat = String(category).toLowerCase();
  return affinity.some((a) => cat.includes(a)) ? 0.12 : 0;
}
