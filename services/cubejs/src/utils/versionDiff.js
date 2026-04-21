import YAML from "yaml";

import {
  parseCubesFromJs,
  diffModels,
} from "./smart-generation/diffModels.js";

function parseCubes(name, code) {
  if (!code) return [];
  const isYaml = name?.endsWith(".yml") || name?.endsWith(".yaml");
  try {
    if (isYaml) {
      const parsed = YAML.parse(code);
      return Array.isArray(parsed?.cubes) ? parsed.cubes : [];
    }
    const cubes = parseCubesFromJs(code);
    return Array.isArray(cubes) ? cubes : [];
  } catch {
    return [];
  }
}

/**
 * Group a flat `diffModels` result into per-cube `CubeChange` records.
 *
 * `diffModels` returns `{fields_added, fields_updated, fields_removed}` arrays
 * where every entry carries the `cube` attribute identifying which cube it
 * belongs to. This helper re-indexes those flat arrays into the per-cube
 * shape required by contracts/version-diff.yaml (`CubeChange.changes[]`).
 *
 * @param {string} fileName
 * @param {string} fromCode
 * @param {string} toCode
 * @returns {Array<{cubeName:string, file:string, changes:Array<object>}>}
 */
function diffFilePair(fileName, fromCode, toCode) {
  const flat = diffModels(fromCode || "", toCode || "", "replace");
  const byCube = new Map();

  const ensure = (cubeName) => {
    if (!byCube.has(cubeName)) {
      byCube.set(cubeName, new Map());
    }
    return byCube.get(cubeName);
  };

  const bucket = (cubeName, memberType) => {
    const cube = ensure(cubeName);
    if (!cube.has(memberType)) {
      cube.set(memberType, { added: [], removed: [], modified: [] });
    }
    return cube.get(memberType);
  };

  for (const entry of flat.fields_added || []) {
    if (!entry?.cube) continue;
    const b = bucket(entry.cube, entry.member_type || "meta");
    b.added.push(entry.name);
  }
  for (const entry of flat.fields_removed || []) {
    if (!entry?.cube) continue;
    const b = bucket(entry.cube, entry.member_type || "meta");
    b.removed.push(entry.name);
  }
  for (const entry of flat.fields_updated || []) {
    if (!entry?.cube) continue;
    const b = bucket(entry.cube, entry.member_type || "meta");
    b.modified.push(entry.name);
  }

  const cubes = [];
  for (const [cubeName, members] of byCube) {
    const changes = [];
    for (const [memberType, diff] of members) {
      const hasAny =
        diff.added.length || diff.removed.length || diff.modified.length;
      if (!hasAny) continue;
      changes.push({
        field: memberType === "measure"
          ? "measures"
          : memberType === "dimension"
          ? "dimensions"
          : memberType === "segment"
          ? "segments"
          : "meta",
        added: diff.added,
        removed: diff.removed,
        modified: diff.modified,
      });
    }
    if (changes.length > 0) {
      cubes.push({ cubeName, file: fileName, changes });
    }
  }
  return cubes;
}

/**
 * Diff two versions (identified by their dataschema arrays) into the
 * `{addedCubes, removedCubes, modifiedCubes}` shape demanded by FR-011
 * and contracts/version-diff.yaml.
 *
 * Matching is by dataschema `name` (the file name) — a cube is "added" when
 * its file is absent from `fromDataschemas` and "removed" when its file is
 * absent from `toDataschemas`. Byte-identical files are skipped.
 *
 * @param {object} args
 * @param {Array<{id?:string, name:string, code:string, checksum?:string}>} args.fromDataschemas
 * @param {Array<{id?:string, name:string, code:string, checksum?:string}>} args.toDataschemas
 */
export function diffVersions({ fromDataschemas, toDataschemas }) {
  const fromByFile = new Map();
  for (const row of fromDataschemas || []) {
    if (row?.name) fromByFile.set(row.name, row);
  }
  const toByFile = new Map();
  for (const row of toDataschemas || []) {
    if (row?.name) toByFile.set(row.name, row);
  }

  const addedCubes = [];
  const removedCubes = [];
  const modifiedCubes = [];

  for (const [file, toRow] of toByFile) {
    if (!fromByFile.has(file)) {
      for (const cube of parseCubes(file, toRow.code)) {
        addedCubes.push({ cubeName: cube.name, file });
      }
      continue;
    }
    const fromRow = fromByFile.get(file);
    if (
      fromRow.checksum &&
      toRow.checksum &&
      fromRow.checksum === toRow.checksum
    ) {
      continue;
    }
    if (fromRow.code === toRow.code) continue;

    const perCube = diffFilePair(file, fromRow.code, toRow.code);
    for (const cube of perCube) modifiedCubes.push(cube);
  }

  for (const [file, fromRow] of fromByFile) {
    if (!toByFile.has(file)) {
      for (const cube of parseCubes(file, fromRow.code)) {
        removedCubes.push({ cubeName: cube.name, file });
      }
    }
  }

  return { addedCubes, removedCubes, modifiedCubes };
}
