// ---------------------------------------------------------------------------
// Search index — lightweight inverted index for O(matches) term search.
// Stored as a single blob at memory/_search_index.json. Maps terms to key
// arrays. Rebuilt by the daily reviewer and on-demand via memory_reindex.
//
// Design: the index is a HINT, not a source of truth. If it's missing, stale,
// or returns no candidates, searchMemory falls back to the full corpus scan.
// This means the index can never cause a search to MISS a record — only to
// find it faster.
// ---------------------------------------------------------------------------

import { keyToPath, listMemory, readRecord, writeRecord } from './memory-store';

const INDEX_KEY = '_search_index';
const MAX_TERMS = 2000;
const MIN_TERM_LENGTH = 3;
const MAX_TERM_LENGTH = 40;

// Extract indexable terms from a record's key + content + source.
function extractTerms(record) {
  const text = `${record.key || ''} ${record.content || ''} ${record.source || ''}`.toLowerCase();
  const terms = new Set();
  const re = /[a-z0-9_]{3,40}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    terms.add(m[0]);
  }
  return terms;
}

// Build the inverted index from the full corpus. Returns { terms, key_count, built_at }.
export async function buildSearchIndex() {
  const { records } = await listMemory({ all: true });

  // term -> Set of keys
  const inverted = new Map();
  let keyCount = 0;

  for (const r of records) {
    if (r._error || r.key === INDEX_KEY) continue;
    keyCount++;
    const terms = extractTerms(r);
    for (const term of terms) {
      if (!inverted.has(term)) inverted.set(term, []);
      inverted.get(term).push(r.key);
    }
  }

  // Keep only the top MAX_TERMS by document frequency (most useful for search).
  const sorted = [...inverted.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_TERMS);

  const index = {};
  for (const [term, keys] of sorted) {
    index[term] = keys;
  }

  const meta = {
    built_at: new Date().toISOString(),
    key_count: keyCount,
    term_count: sorted.length,
  };

  await writeRecord(keyToPath(INDEX_KEY), {
    category: '_index',
    content: JSON.stringify({ meta, index }),
    updated: meta.built_at,
    usefulness: 0,
    retrieval_count: 0,
    source: 'search_index_builder',
    last_retrieved: null,
    basin: null,
    scope: 'shared',
    expires_at: null,
  });

  return meta;
}

// Look up candidate keys for a set of search terms. Returns null if the index
// is unavailable (caller falls back to full scan). Returns a Set of keys that
// match ALL terms (AND semantics, matching searchMemory's behavior).
export async function lookupTerms(terms) {
  if (!terms || !terms.length) return null;

  const existing = await readRecord(keyToPath(INDEX_KEY));
  if (!existing) return null;

  let parsed;
  try {
    parsed = JSON.parse(existing.data.content);
  } catch {
    return null;
  }

  const index = parsed.index;
  if (!index || typeof index !== 'object') return null;

  // AND semantics: intersect the key sets for each term.
  let candidates = null;
  for (const term of terms) {
    const keys = index[term];
    if (!keys) return new Set(); // Term not in index → no matches.
    const keySet = new Set(keys);
    if (candidates === null) {
      candidates = keySet;
    } else {
      candidates = new Set([...candidates].filter((k) => keySet.has(k)));
    }
    if (candidates.size === 0) return candidates;
  }

  return candidates;
}

// Read only the candidate records (O(matches) instead of O(corpus)).
export async function readCandidateRecords(keys) {
  const results = await Promise.all(
    [...keys].map(async (key) => {
      const existing = await readRecord(keyToPath(key));
      if (!existing) return { key, _error: 'not_found' };
      return { key, ...existing.data };
    }),
  );
  return results;
}
