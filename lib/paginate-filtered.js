// Fill a logical page of filtered results by walking physical blob pages.
//
// The blob store paginates STORAGE; callers want pages of FILTERED results. If we
// filter a single physical page and hand back the store's cursor/hasMore, any page
// whose records all fail the filter becomes an EMPTY page with has_more=true — the
// recurring "pagination returns empty pages" / "false-clean silent message loss"
// bug (CCAi 2026-07-18; the "category filter under pagination" trap).
//
// This helper keeps pulling physical pages until it has collected at least `limit`
// kept items OR the store is genuinely exhausted, so an empty result page can ONLY
// mean "nothing left in the store", never "this physical slice happened to match
// nothing". `has_more` reflects the STORE cursor; page until it is false.
//
// Work is bounded by `maxPages` (a sparse filter over a huge corpus cannot trigger
// an unbounded scan). If the cap is hit before filling, we return what we have with
// the store cursor so the caller resumes exactly where we stopped — every physical
// blob up to the returned cursor has been examined, so no match is ever skipped.
//
//   fetchPage(cursor) → { blobs, cursor, hasMore }   one physical page
//   readItem(blob)    → item | null                  read one blob (run concurrently)
//   keep(item)        → boolean                       filter predicate
//
// Returns { results, cursor, has_more }. `results` may slightly exceed `limit`
// (a page's worth); it is never truncated, because truncating would leave matches
// behind the returned cursor and silently skip them.
export async function collectFilteredPage({
  fetchPage,
  readItem,
  keep,
  limit,
  cursor,
  maxPages = 8,
}) {
  const results = [];
  let next = cursor;
  let storeHasMore = false;
  let storeCursor = null;

  for (let page = 0; page < maxPages; page++) {
    const { blobs, cursor: pageCursor, hasMore } = await fetchPage(next);
    // Read the page's blobs CONCURRENTLY — a sequential scan of a full page is the
    // O(n) latency blowup that broke the synapse poll (ec484a1).
    const items = await Promise.all(
      (blobs || []).map((blob) => Promise.resolve(readItem(blob)).catch(() => null)),
    );
    for (const item of items) {
      if (item != null && keep(item)) results.push(item);
    }
    storeHasMore = !!hasMore;
    storeCursor = pageCursor ?? null;
    next = storeCursor;
    if (results.length >= limit) break; // page filled
    if (!hasMore) break; // store exhausted
  }

  return {
    results,
    cursor: storeHasMore ? storeCursor : null,
    has_more: storeHasMore,
  };
}
