// Regression check for the precedent-invisible-to-search defect.
//
// Root cause (fixed): the inverted search index was used AUTHORITATIVELY whenever
// it returned >=1 candidate, but was only rebuilt daily / on demand. So any record
// written since the last rebuild was silently unfindable by any query whose terms
// already existed in the index — precedent records were the prime victims. The fix
// makes the index self-verifying: it stamps a coverage watermark (real-record
// count + newest blob upload time, excluding its own blob), and searchMemory only
// trusts it when a cheap keys-only list proves the corpus is unchanged.
//
// These are the pure functions that carry that guarantee. Run: node this file.

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

register('./verify-search-index-freshness.loader.mjs', import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { computeWatermark, isIndexFresh } = await import(
  pathToFileURL(join(root, 'lib', 'search-index.js')).href
);

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  PASS  ${msg}`); pass++; };

console.log('[1] computeWatermark');
{
  const recs = [
    { key: 'precedent__bsuite__20260805__x', uploaded_at: '2026-08-05T10:00:00.000Z' },
    { key: 'card_resize_is_operator_mandated', uploaded_at: '2026-08-05T11:00:00.000Z' },
    { key: '_search_index', uploaded_at: '2026-08-05T23:59:59.000Z' }, // must be excluded
  ];
  const w = computeWatermark(recs);
  ok(w.count === 2, 'excludes the _search_index blob from the count (2 real records)');
  ok(w.max_uploaded_at === '2026-08-05T11:00:00.000Z',
    'max_uploaded_at ignores the index blob (would-be-newest) and takes the newest REAL record');
  ok(computeWatermark([]).count === 0, 'empty corpus → count 0');
  ok(computeWatermark(null).count === 0, 'null-safe');
}

console.log('[2] isIndexFresh — the freshness gate');
{
  const meta = { key_count: 2, max_uploaded_at: '2026-08-05T11:00:00.000Z' };

  ok(isIndexFresh(meta, { count: 2, max_uploaded_at: '2026-08-05T11:00:00.000Z' }) === true,
    'unchanged corpus (same count, no newer upload) → FRESH');

  // THE regression: a precedent written AFTER the build. Count grows by one.
  ok(isIndexFresh(meta, { count: 3, max_uploaded_at: '2026-08-05T12:00:00.000Z' }) === false,
    'a record ADDED after build (count 2→3) → STALE → search must full-scan (the precedent bug)');

  ok(isIndexFresh(meta, { count: 1, max_uploaded_at: '2026-08-05T10:00:00.000Z' }) === false,
    'a record DELETED after build (count 2→1) → STALE');

  ok(isIndexFresh(meta, { count: 2, max_uploaded_at: '2026-08-05T11:30:00.000Z' }) === false,
    'a record EDITED after build (same count, newer upload) → STALE');

  ok(isIndexFresh(meta, { count: 2, max_uploaded_at: '2026-08-05T11:00:00.000Z' }) === true,
    'boundary: identical max_uploaded_at is not "newer" → still FRESH');

  ok(isIndexFresh(null, { count: 0, max_uploaded_at: '' }) === false, 'no index meta → not fresh (full-scan)');
  ok(isIndexFresh({ key_count: 'x' }, { count: 0, max_uploaded_at: '' }) === false,
    'malformed meta → not fresh (fail safe)');
  ok(isIndexFresh(meta, null) === false, 'no watermark → not fresh');
}

console.log(`\n${pass} passed, 0 failed`);
