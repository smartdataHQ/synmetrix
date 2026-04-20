/**
 * Invalidate compiler-cache entries scoped to a single branch's schemaVersion.
 *
 * The cubejs compiler cache is an LRU keyed by `appId`, which is built in
 * `services/cubejs/index.js` as:
 *   `CUBEJS_APP_${dataSourceVersion}_${schemaVersion}}`   (trailing `}` is
 *   intentional — it comes from the original template literal).
 *
 * Two users querying the same branch share one `schemaVersion` but may differ
 * in `dataSourceVersion` (which folds team-properties hash). Eviction therefore
 * iterates keys and removes every key whose suffix matches `_${schemaVersion}}`.
 *
 * FR-004 blast radius: compiler cache only, scoped to the target branch.
 * Pre-aggregation cache and user-scope caches are never touched.
 *
 * @param {{compilerCache?: {keys?: () => Iterable<unknown>, delete: (key:unknown)=>unknown}}} cubejs
 * @param {string} schemaVersion - branch's current schemaVersion hash
 * @returns {number} count of LRU entries removed
 */
export function invalidateCompilerForBranch(cubejs, schemaVersion) {
  const cache = cubejs?.compilerCache;
  if (!cache || typeof cache.keys !== "function") return 0;

  const suffix = `_${schemaVersion}}`;
  let evicted = 0;
  for (const key of cache.keys()) {
    if (typeof key === "string" && key.endsWith(suffix)) {
      cache.delete(key);
      evicted += 1;
    }
  }
  return evicted;
}
