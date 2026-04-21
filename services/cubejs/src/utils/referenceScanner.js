/**
 * scanCrossCubeReferences — detect blocking references to a target cube.
 *
 * Implements FR-008: deletion of a cube MUST be blocked when any other cube on
 * the same branch carries a reference to the target via one of seven kinds:
 * `joins`, `extends`, `sub_query`, `formula`, `segment`, `pre_aggregation`,
 * or `filter_params`.
 *
 * Inputs:
 *   targetCubeName — cube identifier (e.g. `"orders"`).
 *   otherCubes     — array of `{cubeName, fileName, code}` for every OTHER
 *                    cube on the same branch. The caller MUST omit the target
 *                    cube itself; self-matches are still filtered defensively.
 *
 * Returns: array of `{referringCube, file, referenceKind, line}` in the order
 * encountered. The `referenceKind` values match the enum on
 * `BlockingReference.referenceKind` in data-model §2.4.
 *
 * Implementation is textual-pattern based per research.md §R3. A cube is a
 * blocking referrer if any of the seven patterns match its source. Textual
 * scan is deterministic, O(n·m), and avoids duplicating compiler parse state.
 *
 * @param {string} targetCubeName
 * @param {Array<{cubeName:string, fileName:string, code:string}>} otherCubes
 * @returns {Array<{referringCube:string, file:string, referenceKind:string, line:number}>}
 */
export function scanCrossCubeReferences(targetCubeName, otherCubes) {
  if (!targetCubeName || !Array.isArray(otherCubes)) return [];

  const target = escapeForRegex(targetCubeName);

  const patterns = [
    {
      kind: "filter_params",
      re: new RegExp(`FILTER_PARAMS\\.${target}\\.`, "g"),
    },
    {
      kind: "extends",
      re: new RegExp(`extends\\s*:\\s*['\"]?${target}['\"]?\\b`, "g"),
    },
    {
      kind: "joins",
      re: new RegExp(
        `joins\\s*:[\\s\\S]*?-\\s*name\\s*:\\s*['\"]?${target}['\"]?\\b`,
        "g"
      ),
    },
    {
      kind: "pre_aggregation",
      re: new RegExp(
        `pre_aggregations\\s*:[\\s\\S]*?${target}\\.[A-Za-z_][A-Za-z0-9_]*`,
        "g"
      ),
    },
    {
      kind: "sub_query",
      re: new RegExp(
        `sub_query\\s*:\\s*true[\\s\\S]*?(?:\\{${target}(?:\\.[A-Za-z_][A-Za-z0-9_]*)?\\}|\\b${target}\\.[A-Za-z_][A-Za-z0-9_]*)`,
        "g"
      ),
    },
    {
      kind: "segment",
      re: new RegExp(
        `segments\\s*:[\\s\\S]*?(?:\\{${target}(?:\\.[A-Za-z_][A-Za-z0-9_]*)?\\}|\\b${target}\\.[A-Za-z_][A-Za-z0-9_]*)`,
        "g"
      ),
    },
    {
      kind: "formula",
      re: new RegExp(
        `(?:\\{${target}(?:\\.[A-Za-z_][A-Za-z0-9_]*)?\\}|\\b${target}\\.[A-Za-z_][A-Za-z0-9_]*)`,
        "g"
      ),
    },
  ];

  const hits = [];
  for (const cube of otherCubes) {
    if (!cube || cube.cubeName === targetCubeName || !cube.code) continue;
    const code = String(cube.code);
    const seen = new Set();
    for (const { kind, re } of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        const key = `${kind}:${m.index}`;
        if (seen.has(key)) break;
        seen.add(key);
        hits.push({
          referringCube: cube.cubeName,
          file: cube.fileName,
          referenceKind: kind,
          line: lineAt(code, m.index),
        });
        if (!re.global) break;
      }
    }
  }
  return hits;
}

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineAt(text, index) {
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
