/**
 * Builds, in memory, the variant of a cube that reads an aggregate table: the
 * same cube name and member names, the source table swapped inside the cube's
 * own SQL, and each measure rewritten by the role of the columns it reads. A
 * member that is not provably exact on the aggregate is left out, with a
 * reason; a query that needs it stays on the source.
 */
import { createHash } from "node:crypto";
import YAML from "yaml";

import { IDENTIFIER, ROWS_COLUMN, SUFFIX, quote } from "./contract.js";
import { JOINED_KEY_PLACEHOLDER, classify, memberExpression } from "./expressions.js";

/** Bump when the derivation rules change, so variants compiled under old rules are not reused. */
export const DERIVE_VERSION = 4;

const CUBE_KEYS = ["title", "description", "meta", "public", "shown", "data_source", "sql_alias", "refresh_key"];
const SAFE_JOIN_RELATIONSHIPS = new Set(["many_to_one", "one_to_one", "belongsTo", "hasOne"]);
const SAFE_SPLIT_SETTINGS = new Set(["asterisk_include_alias_columns", "do_not_merge_across_partitions_select_final"]);
const UNSUPPORTED_MEASURE_KEYS = ["rolling_window", "multi_stage", "time_shift", "add_group_by", "reduce_by", "group_by", "case"];
const NOT_IN_A_PLAIN_READ = new Set([
  "group", "order", "limit", "having", "union", "join", "final", "prewhere", "sample", "window", "qualify",
  "format", "intersect", "except", "offset", "fetch", "settings", "into", "array",
]);
// What a calculation over other measures may use besides those measures and literals.
const NUMBER_FUNCTIONS = new Set([
  "plus", "minus", "multiply", "divide", "negate", "intdiv", "intdivorzero", "modulo", "nullif", "ifnull", "coalesce",
  "if", "multiif", "round", "floor", "ceil", "abs", "tofloat64", "cast", "greatest", "least", "equals", "notequals",
  "less", "greater", "lessorequals", "greaterorequals", "and", "or", "not", "isnull", "isnotnull",
]);

export function variantKey(schemaVersion, cubeName, structure) {
  return createHash("md5")
    .update(JSON.stringify([schemaVersion, cubeName, structure.table, structure.fingerprint, DERIVE_VERSION]))
    .digest("hex");
}

/** The table a cube reads, as "database.table", or null when its SQL is not a single plain read. */
export function sourceTableOf(cube, defaultDatabase) {
  const read = readOf(cube);
  if (!read) return null;
  if (read.database) return `${read.database}.${read.table}`;
  return defaultDatabase && IDENTIFIER.test(defaultDatabase) ? `${defaultDatabase}.${read.table}` : null;
}

/**
 * @param {object|null} cube the cube as written in the tenant's YAML model
 * @param {object} structure the aggregate (catalog.js)
 * @param {(expressions: Array<string|null>, columns: Map<string, string>) => Promise<object[]>} classifyBatch
 * @param {string} schemaVersion
 * @param {{defaultDatabase?: string, availableCubes?: Map<string, {cube: object, fileName: string, content: string}>}} [options]
 */
export async function deriveCube(cube, structure, classifyBatch, schemaVersion, { defaultDatabase, availableCubes } = {}) {
  const derived = {
    variantKey: variantKey(schemaVersion, cube?.name, structure),
    cube: cube?.name,
    aggregate: structure.table,
    files: [],
    available: new Set(),
    leftOut: new Map(),
    timeMembers: new Set(),
    ineligible: null,
  };
  const notEligible = (code) => ({ ...derived, ineligible: code });

  if (!cube || typeof cube !== "object") return notEligible("not_yaml");
  if (cube.extends) return notEligible("extends");
  if (Array.isArray(cube.pre_aggregations) ? cube.pre_aggregations.length : cube.pre_aggregations) {
    return notEligible("pre_aggregations");
  }
  const read = readOf(cube);
  if (!read || sourceTableOf(cube, defaultDatabase) !== structure.source) return notEligible("not_plain_read");
  if (read.splitTimeColumn && read.splitTimeColumn !== structure.timeColumn) return notEligible("not_plain_read");

  // Candidate non-fan-out joins (many_to_one / one_to_one) whose target cube is
  // available in the same schema. Validated below against the aggregate's grouping keys.
  const joinCandidates = availableCubes?.size ? normalizedJoins(cube.joins).filter((join) =>
    SAFE_JOIN_RELATIONSHIPS.has(join.relationship) && availableCubes.has(join.name) && typeof join.sql === "string",
  ) : [];
  const candidateJoinNames = new Set(joinCandidates.map((join) => join.name));

  // Everything ClickHouse has to parse, in one statement.
  const expressions = [];
  const ask = (expression) => expressions.push(expression) - 1;
  const replaceAt = read.replaces.map((item) => ask(item.expression));
  const predicateAt = read.where ? ask(read.where) : null;
  const joinPlans = joinCandidates.map((join) => ({
    join,
    at: ask(memberExpression(join.sql, cube, new Set(), new Set([join.name]))),
  }));
  const plans = {
    dimensions: (cube.dimensions || []).map((member) => planDimension(member, cube, ask, candidateJoinNames)),
    segments: (cube.segments || []).map((member) => ({
      member,
      at: [ask(memberExpression(member.sql, cube, new Set(), candidateJoinNames))],
      referencedJoins: referencedJoinCubes(member.sql, candidateJoinNames),
    })),
    measures: (cube.measures || []).map((member) => planMeasure(member, cube, ask, candidateJoinNames)),
  };

  const base = new Map();
  for (const [name, { role }] of structure.columns) {
    base.set(name, { group: "K", sum: "S", sumMap: "M", time: "T" }[role] || "X");
  }
  if (candidateJoinNames.size) base.set(JOINED_KEY_PLACEHOLDER, "K");
  const parsed = expressions.length ? await classifyBatch(expressions, base) : [];
  const grain = { grainKind: structure.grainKind, grain: structure.grain, grainSeconds: structure.grainSeconds };
  const judge = (at, columns, options) =>
    parsed[at]?.node ? classify(parsed[at].node, columns, options?.grain ?? null) : { cls: "X", detail: "unsupported_member" };

  // REPLACE items: what each target becomes.
  const targets = new Set(read.replaces.map((item) => item.target));
  const effective = new Map(base);
  const keptReplaces = [];
  read.replaces.forEach((item, index) => {
    if (!structure.columns.has(item.target)) return; // the aggregate has no such column: nothing to replace
    const node = parsed[replaceAt[index]]?.node;
    const readsOtherTarget = node && [...identifiersOf(node)].some((name) => name !== item.target && targets.has(name));
    const result = readsOtherTarget ? { cls: "X" } : judge(replaceAt[index], base);
    if (result.cls === "K" || result.cls === "S") {
      effective.set(item.target, result.cls);
      keptReplaces.push(item.text);
    } else {
      effective.set(item.target, result.detail === "reads_time_column" ? "T" : "X");
    }
  });

  // The cube's own restriction (its tenant predicate) must mean the same on both tables.
  if (predicateAt !== null) {
    const strict = new Map(effective);
    for (const target of targets) {
      if (!(base.get(target) === "K" && effective.get(target) === "K")) strict.set(target, "X");
    }
    if (judge(predicateAt, strict).cls !== "K") return notEligible("predicate_not_grouping");
  }

  // Keep only non-fan-out joins whose local key expression depends solely on grouping columns.
  const keptJoins = [];
  const keptJoinNames = new Set();
  for (const { join, at } of joinPlans) {
    if (judge(at, effective).cls === "K") {
      keptJoins.push(join.raw);
      keptJoinNames.add(join.name);
    }
  }
  const missingJoin = (refs) => refs && [...refs].some((name) => !keptJoinNames.has(name));

  const has = (name, role) => structure.columns.get(name)?.role === role;
  const stored = (name) => has(name, "sum") && !targets.has(name); // the column itself, not a rewritten value
  const storedUniq = (name) => has(`${name}${SUFFIX.uniq}`, "uniq") && !targets.has(name);
  const needs = (at, wanted, options) => {
    const result = judge(at, effective, options);
    if (result.cls === wanted) return null;
    if (result.cls === "X" && result.detail !== "not_exact_when_summed") return result.detail;
    return wanted === "K" ? "not_grouping_column" : "not_exact_when_summed";
  };
  const firstProblem = (ats, wanted, options) => ats.map((at) => needs(at, wanted, options)).find(Boolean) || null;

  const out = { dimensions: [], segments: [], measures: [] };
  const full = (member) => `${cube.name}.${member.name}`;
  const keep = (kind, member, definition = member) => {
    out[kind].push(definition);
    derived.available.add(full(member));
  };
  const leave = (member, detail) => derived.leftOut.set(full(member), detail);

  for (const { member, at, unsupported, referencedJoins } of plans.dimensions) {
    if (unsupported || missingJoin(referencedJoins)) {
      leave(member, missingJoin(referencedJoins) ? "column_not_in_aggregate" : "unsupported_member");
      continue;
    }
    const node = at.length === 1 ? parsed[at[0]]?.node : null;
    const isTimeColumn =
      member.type === "time" && node?.type === "Identifier" && node.name === structure.timeColumn &&
      effective.get(structure.timeColumn) === "T" && !targets.has(structure.timeColumn);
    if (isTimeColumn) {
      keep("dimensions", member);
      derived.timeMembers.add(full(member));
      continue;
    }
    const problem = firstProblem(at, "K");
    if (problem) leave(member, problem);
    else keep("dimensions", member);
  }

  for (const { member, at, referencedJoins } of plans.segments) {
    if (missingJoin(referencedJoins)) {
      leave(member, "column_not_in_aggregate");
      continue;
    }
    const problem = firstProblem(at, "K");
    if (problem) leave(member, problem);
    else keep("segments", member);
  }

  const measureDefinitions = new Map();
  const calculations = [];
  for (const plan of plans.measures) {
    const { member, referencedJoins } = plan;
    if (plan.unsupported) leave(member, "unsupported_member");
    else if (missingJoin(referencedJoins)) leave(member, "column_not_in_aggregate");
    else if (member.type === "number") calculations.push(plan);
    else {
      const result = deriveMeasure(plan, { judge, needs, firstProblem, effective, has, stored, storedUniq, parsed, grain });
      if (result.detail) leave(member, result.detail);
      else measureDefinitions.set(member.name, result.definition);
    }
  }

  // Calculations over other measures: available once everything they read is.
  let progressed = true;
  let waiting = calculations;
  while (waiting.length && progressed) {
    progressed = false;
    const next = [];
    for (const plan of waiting) {
      const { member, references } = plan;
      const state = references.map((name) =>
        measureDefinitions.has(name) ? "ready" : waiting.some((other) => other !== plan && other.member.name === name) ? "waiting" : "gone",
      );
      if (state.includes("gone")) leave(member, "depends_on_unavailable_member");
      else if (state.includes("waiting")) {
        next.push(plan);
        continue;
      } else if (!numberSafe(parsed[plan.at]?.node)) leave(member, "unsupported_member");
      else measureDefinitions.set(member.name, member);
      progressed = true;
    }
    waiting = next;
  }
  for (const { member } of waiting) leave(member, "depends_on_unavailable_member"); // they only read each other

  // A measure names the members a drill-down shows; all of them must exist in the derived cube.
  const dimensionNames = new Set(out.dimensions.map((dimension) => dimension.name));
  const local = (reference) => String(reference).replace(new RegExp(`^(CUBE|${cube.name})\\.`), "");
  for (const member of cube.measures || []) {
    if (!measureDefinitions.has(member.name)) continue;
    const drill = Array.isArray(member.drill_members) ? member.drill_members : [];
    if (drill.some((reference) => !dimensionNames.has(local(reference)) && !measureDefinitions.has(local(reference)))) {
      leave(member, "depends_on_unavailable_member");
    } else keep("measures", member, measureDefinitions.get(member.name));
  }

  const definition = { name: cube.name };
  if (read.sqlTable) definition.sql_table = structure.table;
  else {
    definition.sql =
      `SELECT *${keptReplaces.length ? ` REPLACE (${keptReplaces.join(", ")})` : ""} FROM ${structure.table}` +
      `${read.where ? ` WHERE ${read.where}` : ""}${read.settings ? ` SETTINGS ${read.settings}` : ""}`;
  }
  for (const key of CUBE_KEYS) if (cube[key] !== undefined) definition[key] = cube[key];
  if (keptJoins.length) {
    definition.joins = keptJoins;
    if (!out.dimensions.some((dimension) => dimension.primary_key === true)) {
      const pkCols = [...structure.columns.entries()]
        .filter(([, { role }]) => role === "group" || role === "time")
        .map(([name]) => `ifNull(toString({CUBE}.${quote(name)}), '')`);
      if (pkCols.length) {
        out.dimensions.push({
          name: "__agg_pk",
          sql: `concatWithSeparator('|', ${pkCols.join(", ")})`,
          type: "string",
          primary_key: true,
          public: false,
        });
      }
    }
  }
  for (const kind of ["dimensions", "segments", "measures"]) if (out[kind].length) definition[kind] = out[kind];

  // Quote string scalars so Cube's YAML 1.1 loader (js-yaml) never coerces
  // ISO date strings like origin: "2020-01-01" into Date objects.
  const stringifyYaml = (doc) => YAML.stringify(doc, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" });
  const files = [{ fileName: `${cube.name}__aggregate.yml`, content: stringifyYaml({ cubes: [definition] }) }];
  if (keptJoinNames.size && availableCubes?.size) {
    const added = new Set();
    for (const joinName of keptJoinNames) {
      const entry = availableCubes.get(joinName);
      if (!entry || added.has(joinName)) continue;
      added.add(joinName);
      files.push({
        fileName: `${joinName}__joined.yml`,
        content: stringifyYaml({ cubes: [entry.cube] }),
      });
    }
  }
  derived.files = files;
  return derived;
}

function normalizedJoins(joins) {
  if (Array.isArray(joins)) {
    return joins
      .filter((join) => join && typeof join === "object" && typeof join.name === "string")
      .map((join) => ({ name: join.name, relationship: join.relationship, sql: join.sql, raw: join }));
  }
  if (joins && typeof joins === "object") {
    return Object.entries(joins)
      .filter(([, join]) => join && typeof join === "object")
      .map(([name, join]) => ({ name, relationship: join.relationship, sql: join.sql, raw: { name, ...join } }));
  }
  return [];
}

function referencedJoinCubes(sql, candidateJoinNames) {
  const found = new Set();
  if (typeof sql !== "string" || !candidateJoinNames?.size) return found;
  const re = /\{([^{}]*)\}(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g;
  let match;
  while ((match = re.exec(sql)) !== null) {
    const reference = match[1].trim();
    const dotIdent = match[2];
    if (dotIdent && candidateJoinNames.has(reference)) {
      found.add(reference);
      continue;
    }
    const dotted = /^([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*$/.exec(reference);
    if (!dotIdent && dotted && candidateJoinNames.has(dotted[1])) found.add(dotted[1]);
  }
  return found;
}

function planDimension(member, cube, ask, candidateJoinNames) {
  if (member.sub_query || member.type === "geo" || member.latitude || member.longitude) return { member, unsupported: true };
  if (member.case) {
    const conditions = Array.isArray(member.case.when) ? member.case.when : [];
    if (conditions.length === 0) return { member, unsupported: true };
    const referencedJoins = new Set();
    for (const condition of conditions) {
      for (const name of referencedJoinCubes(condition.sql, candidateJoinNames)) referencedJoins.add(name);
    }
    return {
      member,
      at: conditions.map((condition) => ask(memberExpression(condition.sql, cube, new Set(), candidateJoinNames))),
      referencedJoins,
    };
  }
  return {
    member,
    at: [ask(memberExpression(member.sql, cube, new Set(), candidateJoinNames))],
    referencedJoins: referencedJoinCubes(member.sql, candidateJoinNames),
  };
}

function planMeasure(member, cube, ask, candidateJoinNames) {
  if (UNSUPPORTED_MEASURE_KEYS.some((key) => member[key] !== undefined)) return { member, unsupported: true };
  const filters = Array.isArray(member.filters) ? member.filters : [];
  const referencedJoins = new Set();
  for (const filter of filters) {
    for (const name of referencedJoinCubes(filter.sql, candidateJoinNames)) referencedJoins.add(name);
  }
  const filterAt = filters.map((filter) => ask(memberExpression(filter.sql, cube, new Set(), candidateJoinNames)));
  if (member.type === "number") {
    // Every reference must be a measure of this cube; the rest must be plain arithmetic.
    const references = [];
    let plain = filters.length === 0 && typeof member.sql === "string";
    const arithmetic = plain
      ? member.sql.replace(/\{([^{}]*)\}(\.)?/g, (whole, inner, dot) => {
          const reference = inner.trim();
          const name = reference.replace(new RegExp(`^(CUBE|${cube.name})\\.`), "");
          if (dot || reference === "CUBE" || reference === cube.name) plain = false;
          references.push(name);
          return "1";
        })
      : null;
    if (!plain) return { member, unsupported: true };
    return { member, references, at: ask(arithmetic) };
  }
  if (member.type === "count") {
    return member.sql === undefined ? { member, filters, filterAt, referencedJoins } : { member, unsupported: true };
  }
  if (!["sum", "avg", "min", "max", "count_distinct", "count_distinct_approx"].includes(member.type)) return { member, unsupported: true };
  for (const name of referencedJoinCubes(member.sql, candidateJoinNames)) referencedJoins.add(name);
  return { member, filters, filterAt, at: ask(memberExpression(member.sql, cube, new Set(), candidateJoinNames)), referencedJoins };
}

function deriveMeasure({ member, at, filters, filterAt }, { judge, needs, firstProblem, effective, has, stored, storedUniq, parsed, grain }) {
  const filterProblem = firstProblem(filterAt, "K", { grain });
  if (filterProblem) return { detail: filterProblem };
  const condition = filters.map((filter) => `(${String(filter.sql).trim()})`).join(" AND ");
  const total = (expression) => (condition ? `sumIf(${expression}, ${condition})` : `sum(${expression})`);
  const { filters: _folded, ...unfiltered } = member;
  const rows = has(ROWS_COLUMN, "rows");

  if (member.type === "count") {
    if (!rows) return { detail: "no_stored_field" };
    const { name, ...rest } = unfiltered;
    return { definition: { name, ...rest, type: "number", sql: total(`{CUBE}.${ROWS_COLUMN}`) } };
  }

  const node = parsed[at]?.node;
  const result = judge(at, effective);
  const missing = result.cls === "X" && result.detail !== "not_exact_when_summed" ? result.detail : null;
  const column = node?.type === "Identifier" && stored(node.name) ? node.name : null;

  switch (member.type) {
    case "sum": {
      const problem = needs(at, "S", { grain });
      return problem ? { detail: problem } : { definition: member };
    }
    case "count_distinct": {
      const problem = needs(at, "K");
      return problem ? { detail: problem } : { definition: member };
    }
    case "count_distinct_approx": {
      if (result.cls === "K") return { definition: member };
      if (node?.type === "Identifier" && storedUniq(node.name)) {
        const sketch = `{CUBE}.${node.name}${SUFFIX.uniq}`;
        const sql = condition ? `uniqMergeIf(${sketch}, ${condition})` : `uniqMerge(${sketch})`;
        return { definition: { ...unfiltered, sql, type: "number" } };
      }
      if (missing) return { detail: missing };
      return { detail: "not_grouping_column" };
    }
    case "avg": {
      if (missing) return { detail: missing };
      if (column && has(`${column}${SUFFIX.count}`, "count")) {
        // toFloat64: avg() answers in floating point; a decimal sum divided as it is would be cut to its scale
        const sql = `toFloat64(${total(`{CUBE}.${column}`)}) / nullIf(${total(`{CUBE}.${column}${SUFFIX.count}`)}, 0)`;
        return { definition: { ...unfiltered, sql, type: "number" } };
      }
      if (isMapKey(node, effective) && rows) {
        const sql = `toFloat64(${total(String(member.sql).trim())}) / nullIf(${total(`{CUBE}.${ROWS_COLUMN}`)}, 0)`;
        return { definition: { ...unfiltered, sql, type: "number" } };
      }
      return { detail: "no_stored_field" };
    }
    default: {
      // min, max
      if (missing) return { detail: missing };
      if (result.cls === "K") return { definition: member };
      const suffix = SUFFIX[member.type];
      if (column && has(`${column}${suffix}`, member.type)) {
        return { definition: { ...member, sql: `{CUBE}.${column}${suffix}` } };
      }
      return { detail: "no_stored_field" };
    }
  }
}

const isMapKey = (node, columns) => {
  if (node?.type !== "Function" || node.name !== "arrayElement") return false;
  const [map, key] = node.children[0]?.children || [];
  return map?.type === "Identifier" && columns.get(map.name) === "M" && key?.type === "Literal";
};

function numberSafe(node) {
  if (!node) return false;
  if (node.type === "Literal") return true;
  if (node.type !== "Function" || !NUMBER_FUNCTIONS.has(String(node.name).toLowerCase())) return false;
  const list = node.children[0];
  if (node.children.length > 1 || (list && list.type !== "ExpressionList")) return false;
  return (list ? list.children : []).every(numberSafe);
}

function identifiersOf(node, found = new Set()) {
  if (node.type === "Identifier") found.add(node.name);
  for (const child of node.children) identifiersOf(child, found);
  return found;
}

/**
 * Reads a cube's table access: `sql_table`, a plain
 * `SELECT * [REPLACE (…)] FROM table [WHERE …] [SETTINGS …]`, or a
 * time-partitioned two-branch `UNION ALL` over the same table (used by
 * ReplacingMergeTree cubes that apply `FINAL` only to recent months while old
 * partitions are already force-merged). Anything else is not a plain read.
 */
function readOf(cube) {
  if (!cube || typeof cube !== "object") return null;
  if (typeof cube.sql_table === "string" && cube.sql === undefined) {
    const table = tableOf(cube.sql_table.trim());
    return table ? { ...table, sqlTable: true, replaces: [], where: null, settings: null } : null;
  }
  if (typeof cube.sql !== "string") return null;
  const sql = cube.sql.trim().replace(/;\s*$/, "");
  const tokens = tokenize(sql);
  if (!tokens) return null;

  let at = 0;
  const word = (token, text) => token?.kind === "word" && token.text.toLowerCase() === text;
  if (!word(tokens[at++], "select")) return null;
  if (!(tokens[at]?.kind === "symbol" && tokens[at++].text === "*")) return null;

  // Two-branch time-split UNION ALL: SELECT * FROM ( <branch1> UNION ALL <branch2> )
  if (word(tokens[at], "from") && tokens[at + 1]?.kind === "group" && tokens[at + 1].text.startsWith("(") && at + 2 === tokens.length) {
    return splitUnionReadOf(tokens[at + 1].inner);
  }

  let replaces = [];
  if (word(tokens[at], "replace")) {
    const group = tokens[at + 1];
    if (group?.kind !== "group") return null;
    replaces = replaceItems(group.inner);
    if (!replaces) return null;
    at += 2;
  }
  if (!word(tokens[at++], "from")) return null;
  const table = tokens[at]?.kind === "word" ? tableOf(tokens[at].text) : null;
  if (!table) return null;
  at += 1;

  let where = null;
  let settings = null;
  if (word(tokens[at], "where")) {
    const from = at + 1;
    let to = from;
    while (to < tokens.length && !word(tokens[to], "settings")) to += 1;
    const predicate = tokens.slice(from, to);
    if (predicate.length === 0) return null;
    if (predicate.some((token) => token.kind === "word" && NOT_IN_A_PLAIN_READ.has(token.text.toLowerCase()))) return null;
    where = sql.slice(predicate[0].start, predicate[predicate.length - 1].end);
    at = to;
  }
  if (word(tokens[at], "settings")) {
    if (at + 1 >= tokens.length) return null;
    settings = sql.slice(tokens[at + 1].start);
    if (/\bfinal\b/i.test(settings)) return null; // a setting that removes duplicates while reading
    at = tokens.length;
  }
  return at === tokens.length ? { ...table, sqlTable: false, replaces, where, settings } : null;
}

function splitUnionReadOf(inner) {
  const tokens = tokenize(inner);
  if (!tokens) return null;
  const word = (token, text) => token?.kind === "word" && token.text.toLowerCase() === text;
  const unionAt = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (word(tokens[i], "union") && word(tokens[i + 1], "all")) unionAt.push(i);
  }
  if (unionAt.length !== 1) return null;
  const splitIdx = unionAt[0];
  const left = parseSplitBranch(inner.slice(0, tokens[splitIdx].start).trim());
  const right = parseSplitBranch(inner.slice(tokens[splitIdx + 1].end).trim());
  if (!left || !right) return null;
  if (left.database !== right.database || left.table !== right.table) return null;

  // Match the complementary time-range split (< vs >=, or <= vs >) and identical tenant predicates.
  const pair = matchTimeSplit(left.conjuncts, right.conjuncts);
  if (!pair) return null;
  return {
    database: left.database,
    table: left.table,
    sqlTable: false,
    replaces: [],
    where: pair.shared.length ? pair.shared.join(" AND ") : null,
    settings: null,
    splitTimeColumn: pair.timeColumn,
  };
}

function parseSplitBranch(sql) {
  const tokens = tokenize(sql);
  if (!tokens) return null;
  const word = (token, text) => token?.kind === "word" && token.text.toLowerCase() === text;
  let at = 0;
  if (!word(tokens[at++], "select")) return null;
  if (!(tokens[at]?.kind === "symbol" && tokens[at++].text === "*")) return null;
  if (!word(tokens[at++], "from")) return null;
  const table = tokens[at]?.kind === "word" ? tableOf(tokens[at].text) : null;
  if (!table) return null;
  at += 1;
  if (word(tokens[at], "final")) at += 1;
  if (!word(tokens[at++], "where")) return null;
  const from = at;
  while (at < tokens.length && !word(tokens[at], "settings")) at += 1;
  const predicate = tokens.slice(from, at);
  if (predicate.length === 0) return null;
  if (predicate.some((token) => token.kind === "word" && (NOT_IN_A_PLAIN_READ.has(token.text.toLowerCase()) || token.text.toLowerCase() === "or"))) {
    return null;
  }
  if (word(tokens[at], "settings")) {
    const rest = sql.slice(tokens[at + 1]?.start ?? sql.length).trim();
    if (!rest) return null;
    for (const part of rest.split(",")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\d+\s*$/.exec(part);
      if (!m || !SAFE_SPLIT_SETTINGS.has(m[1].toLowerCase())) return null;
    }
  } else if (at !== tokens.length) return null;

  // Split top-level AND conjuncts.
  const conjuncts = [];
  let start = 0;
  for (let i = 0; i <= predicate.length; i += 1) {
    if (i === predicate.length || word(predicate[i], "and")) {
      if (i === start) return null;
      conjuncts.push(sql.slice(predicate[start].start, predicate[i - 1].end).trim());
      start = i + 1;
    }
  }
  return { ...table, conjuncts };
}

function parseTimeBound(conjunct) {
  const m = /^`?([A-Za-z_][A-Za-z0-9_]*)`?\s*(<=|>=|<|>)\s*(.+)$/s.exec(conjunct);
  if (!m) return null;
  return { column: m[1], op: m[2], bound: m[3].replace(/\s+/g, " ").trim() };
}

function matchTimeSplit(leftConjuncts, rightConjuncts) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const complements = new Map([["<", ">="], [">=", "<"], ["<=", ">"], [">", "<="]]);
  for (let i = 0; i < leftConjuncts.length; i += 1) {
    const lb = parseTimeBound(leftConjuncts[i]);
    if (!lb) continue;
    for (let j = 0; j < rightConjuncts.length; j += 1) {
      const rb = parseTimeBound(rightConjuncts[j]);
      if (!rb || rb.column !== lb.column || rb.bound !== lb.bound || complements.get(lb.op) !== rb.op) continue;
      const leftRest = leftConjuncts.filter((_, k) => k !== i);
      const rightRest = rightConjuncts.filter((_, k) => k !== j);
      if (leftRest.length !== rightRest.length) continue;
      const rightNorm = new Set(rightRest.map(norm));
      if (leftRest.every((c) => rightNorm.has(norm(c)))) {
        return { timeColumn: lb.column, shared: leftRest };
      }
    }
  }
  return null;
}

function tableOf(text) {
  const part = "(?:`([A-Za-z_][A-Za-z0-9_]*)`|\"([A-Za-z_][A-Za-z0-9_]*)\"|([A-Za-z_][A-Za-z0-9_]*))";
  const match = new RegExp(`^${part}(?:\\.${part})?$`).exec(text);
  if (!match) return null;
  const first = match[1] || match[2] || match[3];
  const second = match[4] || match[5] || match[6];
  return second ? { database: first, table: second } : { database: null, table: first };
}

function replaceItems(inner) {
  const tokens = tokenize(inner);
  if (!tokens || tokens.length === 0) return null;
  const items = [];
  let current = [];
  const close = () => {
    const as = current.length - 2;
    const name = current[current.length - 1];
    if (as < 1 || !(current[as].kind === "word" && current[as].text.toLowerCase() === "as")) return false;
    const target = name.kind === "word" ? tableOf(name.text) : null;
    if (!target || target.database) return false;
    items.push({
      target: target.table,
      expression: inner.slice(current[0].start, current[as - 1].end),
      text: inner.slice(current[0].start, name.end),
    });
    current = [];
    return true;
  };
  for (const token of tokens) {
    if (token.kind === "symbol" && token.text === ",") {
      if (!close()) return null;
    } else current.push(token);
  }
  return close() ? items : null;
}

/**
 * Splits SQL into its outermost pieces: words (including quoted and dotted
 * names), string literals, bracketed groups, and single symbols. Null when the
 * text holds a comment or does not balance.
 */
function tokenize(sql) {
  const tokens = [];
  const closers = { "(": ")", "[": "]" };
  const skipQuoted = (from, quote) => {
    let i = from + 1;
    while (i < sql.length) {
      if (sql[i] === "\\") i += 2;
      else if (sql[i] === quote) {
        if (sql[i + 1] === quote) i += 2;
        else return i + 1;
      } else i += 1;
    }
    return -1;
  };
  const skipGroup = (from) => {
    const stack = [closers[sql[from]]];
    let i = from + 1;
    while (i < sql.length && stack.length) {
      const c = sql[i];
      if (c === "'" || c === "`" || c === '"') {
        i = skipQuoted(i, c);
        if (i < 0) return -1;
        continue;
      }
      if (isComment(sql, i)) return -1;
      if (closers[c]) stack.push(closers[c]);
      else if (c === ")" || c === "]") {
        if (stack.pop() !== c) return -1;
      }
      i += 1;
    }
    return stack.length ? -1 : i;
  };

  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (isComment(sql, i)) {
      return null;
    } else if (c === "'") {
      const end = skipQuoted(i, c);
      if (end < 0) return null;
      tokens.push({ kind: "string", text: sql.slice(i, end), start: i, end });
      i = end;
    } else if (closers[c]) {
      const end = skipGroup(i);
      if (end < 0) return null;
      tokens.push({ kind: "group", text: sql.slice(i, end), inner: sql.slice(i + 1, end - 1), start: i, end });
      i = end;
    } else if (c === ")" || c === "]") {
      return null;
    } else if (/[A-Za-z0-9_`"$]/.test(c)) {
      let end = i;
      while (end < sql.length) {
        if (sql[end] === "`" || sql[end] === '"') {
          end = skipQuoted(end, sql[end]);
          if (end < 0) return null;
        } else if (/[A-Za-z0-9_.$]/.test(sql[end])) end += 1;
        else break;
      }
      tokens.push({ kind: "word", text: sql.slice(i, end), start: i, end });
      i = end;
    } else {
      tokens.push({ kind: "symbol", text: c, start: i, end: i + 1 });
      i += 1;
    }
  }
  return tokens;
}

const isComment = (sql, i) =>
  (sql[i] === "-" && sql[i + 1] === "-") || (sql[i] === "/" && sql[i + 1] === "*") || sql[i] === "#";
