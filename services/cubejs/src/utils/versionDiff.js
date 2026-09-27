import YAML from "yaml";

import { parseCubesFromJs } from "./smart-generation/diffModels.js";

/**
 * Parse a dataschema file into its cubes and views:
 * `[{kind: 'cube'|'view', name, def}]`, or `null` when unparseable.
 */
function parseModels(name, code) {
  if (!code) return [];
  const isYaml = name?.endsWith(".yml") || name?.endsWith(".yaml");
  try {
    let cubes;
    let views;
    if (isYaml) {
      const parsed = YAML.parse(code);
      cubes = Array.isArray(parsed?.cubes) ? parsed.cubes : [];
      views = Array.isArray(parsed?.views) ? parsed.views : [];
    } else {
      views = [];
      cubes = parseCubesFromJs(code, views);
      if (!cubes && !views.length) return null; // unparseable (or empty) JS
      cubes = cubes || [];
    }
    return [
      ...cubes.map((def) => ({ kind: "cube", name: def?.name, def })),
      ...views.map((def) => ({ kind: "view", name: def?.name, def })),
    ].filter((m) => typeof m.name === "string");
  } catch {
    return null;
  }
}

// Order-insensitive for object keys (YAML key order is not semantic);
// functions (JS models) compare by source.
function canon(v) {
  if (typeof v === "function") return v.toString();
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canon(v[k])])
    );
  }
  return v;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const isNamedList = (v) =>
  Array.isArray(v) &&
  v.every((x) => x && typeof x === "object" && typeof x.name === "string");

const byName = (list) => new Map((list || []).map((x) => [x.name, x]));

// Member lists reported through the contract's `changes[]` entries.
const CHANGE_FIELDS = new Set(["dimensions", "measures", "segments"]);

/**
 * Compare two definitions of the same cube/view. Named lists (dimensions,
 * measures, segments, joins, pre_aggregations, hierarchies, …) are diffed
 * member by member; every other key (sql, sql_table, refresh_key, extends,
 * title, description, meta, public, a view's `cubes`, …) is compared whole.
 *
 * @returns {{changes: Array<object>, changedAttributes: string[]}}
 *   `changedAttributes` holds cube-level keys (`sql_table`) and member-level
 *   paths (`dimensions.<name>.<attr>`; `measures.<name>` when added/removed).
 */
function diffDefinitions(from, to) {
  const changes = [];
  const changedAttributes = [];
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])];

  for (const key of keys) {
    if (key === "name") continue;
    const a = from[key];
    const b = to[key];
    const memberWise =
      (a === undefined || isNamedList(a)) &&
      (b === undefined || isNamedList(b));
    if (!memberWise) {
      if (!same(a, b)) changedAttributes.push(key);
      continue;
    }

    const fromMembers = byName(a);
    const toMembers = byName(b);
    const change = { field: key, added: [], removed: [], modified: [] };
    for (const [member, def] of toMembers) {
      const old = fromMembers.get(member);
      if (!old) {
        change.added.push(member);
        changedAttributes.push(`${key}.${member}`);
        continue;
      }
      const attrs = [...new Set([...Object.keys(old), ...Object.keys(def)])];
      const changed = attrs.filter((x) => x !== "name" && !same(old[x], def[x]));
      if (changed.length) change.modified.push(member);
      for (const attr of changed) {
        changedAttributes.push(`${key}.${member}.${attr}`);
      }
    }
    for (const member of fromMembers.keys()) {
      if (!toMembers.has(member)) {
        change.removed.push(member);
        changedAttributes.push(`${key}.${member}`);
      }
    }
    const hasAny =
      change.added.length || change.removed.length || change.modified.length;
    if (hasAny && CHANGE_FIELDS.has(key)) changes.push(change);
  }

  return { changes, changedAttributes };
}

/**
 * Diff two versions (identified by their dataschema arrays) into the
 * `{addedCubes, removedCubes, modifiedCubes}` shape demanded by FR-011
 * and contracts/version-diff.yaml. Views are reported like cubes, with
 * `kind: 'view'`.
 *
 * Files match by dataschema `name`; cubes/views match by name within a
 * file. A cube is "added"/"removed" when it appears on one side only.
 * `modifiedCubes[].changedAttributes` lists every changed cube-level key
 * and member attribute. `modifiedFiles` lists EVERY file present in both
 * versions whose code differs — `cubeNames` is empty when no semantic
 * change was found (formatting/comments) or the file does not parse.
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
  const modifiedFiles = [];
  const entry = (m, file) => ({ cubeName: m.name, file, kind: m.kind });

  for (const [file, toRow] of toByFile) {
    if (!fromByFile.has(file)) {
      for (const m of parseModels(file, toRow.code) || []) {
        addedCubes.push(entry(m, file));
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

    const cubeNames = [];
    const fromModels = parseModels(file, fromRow.code);
    const toModels = parseModels(file, toRow.code);
    if (fromModels && toModels) {
      const key = (m) => `${m.kind}:${m.name}`;
      const fromMap = new Map(fromModels.map((m) => [key(m), m]));
      const toMap = new Map(toModels.map((m) => [key(m), m]));
      for (const [k, m] of toMap) {
        const old = fromMap.get(k);
        if (!old) {
          addedCubes.push(entry(m, file));
          cubeNames.push(m.name);
          continue;
        }
        const diff = diffDefinitions(old.def || {}, m.def || {});
        if (diff.changedAttributes.length) {
          modifiedCubes.push({ ...entry(m, file), ...diff });
          cubeNames.push(m.name);
        }
      }
      for (const [k, m] of fromMap) {
        if (!toMap.has(k)) {
          removedCubes.push(entry(m, file));
          cubeNames.push(m.name);
        }
      }
    }
    modifiedFiles.push({ file, cubeNames });
  }

  for (const [file, fromRow] of fromByFile) {
    if (!toByFile.has(file)) {
      for (const m of parseModels(file, fromRow.code) || []) {
        removedCubes.push(entry(m, file));
      }
    }
  }

  return { addedCubes, removedCubes, modifiedCubes, modifiedFiles };
}
