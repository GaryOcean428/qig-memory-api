// ESM loader for scripts/verify-search-index-freshness.mjs only.
// lib/*.js use extensionless relative imports (e.g. `from './memory-store'`),
// which Next's bundler resolves but plain Node does not. This hook appends `.js`
// to extensionless relative specifiers so the module graph loads under `node`.
// Nothing is stubbed: the functions under test (computeWatermark, isIndexFresh)
// are pure and touch no blob/network; the rest of the graph only defines
// functions at load time.
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.(m?js|json)$/.test(specifier)) {
    return next(specifier + '.js', context);
  }
  return next(specifier, context);
}
