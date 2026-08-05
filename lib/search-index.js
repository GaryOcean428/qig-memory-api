// ---------------------------------------------------------------------------
// Search index — lightweight inverted index for O(matches) term search.
// Stored as a single blob at memory/_search_index.json. Maps terms to key
// arrays. Rebuilt by the daily reviewer and on-demand via memory_reindex.
//
// Design: the index is a HINT, not a source of truth — but a HINT that KNOWS
// when it is stale. Every build stamps a coverage watermark (real-record count +
// newest blob upload time, excluding the index's own blob). searchMemory reads
// that watermark against a cheap keys-only list (metadata, no blob reads) and
// only trusts the index when the corpus has not changed since the build; on any
// add/edit/delete it falls back to the full corpus scan. This closes the class
// of bug where a NON-EMPTY but stale index was used authoritatively and silently
// dropped every record written since the last rebuild (precedent records were
// the prime victims — freshly written, with distinctive terms like "resize"
// already present in the index from other records).
//
// Term selection favours RARE, distinctive terms (what search is actually for).
// High-document-frequency stopwords are dropped, and each posting list is capped
// so a common term cannot bloat the blob. A query term that was dropped simply
// misses the index and triggers the full scan — correct, just not accelerated.
// ---------------------------------------------------------------------------

import { keyToPath, listMemory, readRecord, writeRecord } from './memory-store';

const INDEX_KEY = '_search_index';
const MAX_TERMS = 12000;          // generous; a ~2k-record corpus indexes well under this
const MAX_POSTINGS = 200;         // a term in >200 records is not distinctive — cap its list
const STOPWORD_DF_RATIO = 0.3;    // drop terms appearing in >30% of records...
const STOPWORD_DF_MIN = 50;       // ...but only once the corpus is big enough to have stopwords

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

// Coverage watermark over the REAL corpus (excludes the index's own blob so that
// writing the index never perturbs its own freshness signal). `records` is a
// keys-only listing: [{ key, uploaded_at, size }]. ISO timestamps compare
// lexicographically, so a plain string max is correct.
export function computeWatermark(records) {
  let count = 0;
  let maxUploadedAt = '';
  for (const r of records || []) {
    if (!r || r.key === INDEX_KEY) continue;
    count++;
    const u = r.uploaded_at || '';
    if (u > maxUploadedAt) maxUploadedAt = u;
  }
  return { count, max_uploaded_at: maxUploadedAt };
}

// True when nothing in the corpus has changed since the index was built.
// count divergence catches adds/deletes; a newer upload catches edits.
export function isIndexFresh(meta, watermark) {
  if (!meta || !watermark) return false;
  if (typeof meta.key_count !== 'number' || typeof meta.max_uploaded_at !== 'string') return false;
  if (meta.key_count !== watermark.count) return false;
  if (watermark.max_uploaded_at > meta.max_uploaded_at) return false;
  return true;
}

// Build the inverted index from the full corpus. Returns { built_at, key_count,
// max_uploaded_at, term_count }.
export async function buildSearchIndex() {
  // Watermark first (cheap, metadata-only) so it reflects state at read time.
  const keyList = await listMemory({ keysOnly: true, all: true });
  const watermark = computeWatermark(keyList.records || []);

  const { records } = await listMemory({ all: true });

  // term -> array of keys (document frequency == array length)
  const inverted = new Map();
  let keyCount = 0;

  for (const r of records) {
    if (r._error || r.key === INDEX_KEY) continue;
    keyCount++;
    for (const term of extractTerms(r)) {
      if (!inverted.has(term)) inverted.set(term, []);
      const posting = inverted.get(term);
      if (posting.length < MAX_POSTINGS) posting.push(r.key);
    }
  }

  // Drop high-DF stopwords (useless for search, and the big blobs), then prefer
  // the RAREST terms — the distinctive ones a search actually keys on — up to
  // MAX_TERMS. This is the opposite of a top-by-frequency cap, which drops
  // exactly the terms search needs.
  const stopwordDf = Math.max(STOPWORD_DF_MIN, Math.floor(keyCount * STOPWORD_DF_RATIO));
  const kept = [...inverted.entries()]
    .filter(([, keys]) => keys.length <= stopwordDf)
    .sort((a, b) => a[1].length - b[1].length) // rarest first
    .slice(0, MAX_TERMS);

  const index = {};
  for (const [term, keys] of kept) index[term] = keys;

  const meta = {
    built_at: new Date().toISOString(),
    key_count: watermark.count,
    max_uploaded_at: watermark.max_uploaded_at,
    term_count: kept.length,
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

// Read the parsed index blob ({ meta, index }) or null if unavailable/corrupt.
async function readIndex() {
  const existing = await readRecord(keyToPath(INDEX_KEY));
  if (!existing) return null;
  try {
    const parsed = JSON.parse(existing.data.content);
    if (!parsed || typeof parsed.index !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// Freshness-gated term lookup. Returns:
//   { fresh: false }                        → caller MUST full-scan
//   { fresh: true, candidates: Set<key> }   → authoritative candidate set (may be empty)
// AND semantics across terms, matching searchMemory. A term absent from a fresh
// index yields an empty candidate set; the caller still full-scans on empty so a
// dropped-stopword term can never cause a miss.
export async function indexSearch(terms) {
  if (!terms || !terms.length) return { fresh: false };

  const parsed = await readIndex();
  if (!parsed) return { fresh: false };

  // Cheap metadata list — no blob reads — to verify the index still covers the
  // live corpus. Any add/edit/delete since the build makes the index untrusted.
  const keyList = await listMemory({ keysOnly: true, all: true });
  const watermark = computeWatermark(keyList.records || []);
  if (!isIndexFresh(parsed.meta, watermark)) return { fresh: false };

  const index = parsed.index;
  let candidates = null;
  for (const term of terms) {
    const keys = index[term];
    if (!keys) return { fresh: true, candidates: new Set() };
    const keySet = new Set(keys);
    candidates = candidates === null ? keySet : new Set([...candidates].filter((k) => keySet.has(k)));
    if (candidates.size === 0) return { fresh: true, candidates };
  }
  return { fresh: true, candidates };
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
