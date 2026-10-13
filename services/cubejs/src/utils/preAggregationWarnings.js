/**
 * Model warnings Cube's compiler does not raise.
 *
 * Cube honours `refresh_key.update_window` only with `incremental: true`.
 * Without it every partition in the build range is rebuilt on each refresh
 * tick: on 2026-10-13 abler's BigQuery models rebuilt ~270 partitions an
 * hour, closed months included, because of this.
 *
 * @param {object} cubeEvaluator from prepareCompiler, after compile()
 * @param {Array<{fileName: string, content: string}>} files the compiled files
 */
export function preAggregationWarnings(cubeEvaluator, files) {
  const contentByFile = new Map(files.map((f) => [f.fileName, f.content || ""]));
  const warnings = [];

  for (const cubeName of cubeEvaluator.cubeNames()) {
    const cube = cubeEvaluator.cubeFromPath(cubeName);
    for (const [name, preAgg] of Object.entries(cube.preAggregations || {})) {
      const refreshKey = preAgg.refreshKey || {};
      if (!refreshKey.updateWindow || refreshKey.incremental) continue;

      const line = locate(contentByFile.get(cube.fileName), name);
      warnings.push({
        severity: "warning",
        message: `${cubeName}.${name}: update_window has no effect without incremental: true, so every partition is rebuilt on each refresh. Add incremental: true to refresh_key.`,
        fileName: cube.fileName || null,
        startLine: line,
        startColumn: line ? 1 : null,
        endLine: line,
        endColumn: null,
      });
    }
  }
  return warnings;
}

// Line of the update_window key after the pre-aggregation's name; null if not found.
function locate(content, preAggName) {
  if (!content) return null;
  const lines = content.split("\n");
  const start = lines.findIndex((l) => new RegExp(`\\b${preAggName}\\b`).test(l));
  if (start < 0) return null;
  const hit = lines.findIndex((l, i) => i > start && /\b(update_window|updateWindow)\b/.test(l));
  return (hit < 0 ? start : hit) + 1;
}
