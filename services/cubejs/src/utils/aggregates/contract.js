/**
 * The column contract of an aggregate table (specs/015-aggregate-routing/
 * contracts/aggregate-contract.md), in one place. Discovery, derivation,
 * generation and refresh all read it from here, so the convention cannot
 * drift between them.
 */
import { createHash } from "node:crypto";

export const SUFFIX = Object.freeze({ count: "__count", min: "__min", max: "__max", uniq: "__uniq" });
export const ROWS_COLUMN = "_rows";

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;
export const PARTITION_ID = /^[A-Za-z0-9_-]+$/;
const UNIT_SECONDS = { second: 1, minute: 60, hour: 3600, day: 86400 };
const DAY = 86400;
const MONTH_ORDER_SECONDS = 31 * DAY;
const BINDING_FIELDS = ["aggregate_of", "time_column", "grain", "min_age", "min_window", "max_staleness"];

export const quote = (identifier) => `\`${identifier}\``;
export const tableRef = (database, table) => `${quote(database)}.${quote(table)}`;

/** "<n> <unit>" with unit second, minute, hour or day. */
export function parseInterval(text) {
  const match = typeof text === "string" && /^(\d+) (second|minute|hour|day)$/.exec(text);
  if (!match) return null;
  return { text, seconds: Number(match[1]) * UNIT_SECONDS[match[2]] };
}

/**
 * A bucket grain: either a fixed UTC interval dividing one day, or the
 * calendar grain "1 month". Weeks are intentionally not supported because
 * they do not align naturally across month/quarter/year boundaries.
 */
export function parseGrain(text) {
  if (text === "1 month") return { text: "1 month", kind: "month", seconds: MONTH_ORDER_SECONDS };
  const interval = parseInterval(text);
  if (!interval || interval.seconds === 0 || DAY % interval.seconds !== 0) return null;
  return { ...interval, kind: "fixed" };
}

/** The binding an aggregate declares in its table comment, or why it is not one. */
export function parseBinding(comment) {
  const invalid = { reason: "invalid_binding" };
  let declared;
  try {
    declared = JSON.parse(comment);
  } catch {
    return invalid;
  }
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return invalid;
  const keys = Object.keys(declared);
  if (keys.length !== BINDING_FIELDS.length || !BINDING_FIELDS.every((field) => keys.includes(field))) {
    return invalid;
  }
  const source = typeof declared.aggregate_of === "string" && QUALIFIED.exec(declared.aggregate_of);
  const grain = parseGrain(declared.grain);
  const [minAge, minWindow, maxStaleness] = ["min_age", "min_window", "max_staleness"].map(
    (field) => parseInterval(declared[field]),
  );
  if (
    !source ||
    typeof declared.time_column !== "string" ||
    !IDENTIFIER.test(declared.time_column) ||
    !grain ||
    !minAge ||
    !minWindow ||
    !maxStaleness ||
    maxStaleness.seconds === 0
  ) {
    return invalid;
  }
  return {
    binding: {
      source: declared.aggregate_of,
      database: source[1],
      sourceTable: source[2],
      timeColumn: declared.time_column,
      grain: grain.text,
      grainSeconds: grain.seconds,
      minAgeSeconds: minAge.seconds,
      minWindowSeconds: minWindow.seconds,
      maxStalenessSeconds: maxStaleness.seconds,
    },
  };
}

const SIMPLE_AGGREGATE = /^SimpleAggregateFunction\((\w+),\s*(.*)\)$/s;
const UNIQ_AGGREGATE = /^AggregateFunction\(uniq,\s*(.+)\)$/s;
const AGGREGATE_STATE = /^(Simple)?AggregateFunction\(/;
const DATE_TIME = /^DateTime(64)?(\(.*\))?$/;
const NUMERIC = /^(U?Int(8|16|32|64|128|256)|Float(32|64)|Decimal.*)$/;
const STRING_KEYED_MAP = /^Map\(String,\s*(.*)\)$/s;

/**
 * The role of every aggregate column, read from its name, type and place in
 * the sorting key. A column that fits no role is unusable; it never makes the
 * aggregate itself unusable.
 *
 * @returns {Map<string, {role: string, type: string, of?: string}>} in column order
 */
export function classifyColumns(columns, binding) {
  const simple = new Map();
  for (const column of columns) {
    const match = SIMPLE_AGGREGATE.exec(column.type);
    if (match) simple.set(column.name, { fn: match[1], inner: match[2] });
  }
  const isSum = (name) => {
    const found = simple.get(name);
    return Boolean(found) && found.fn === "sum" && name !== ROWS_COLUMN && !suffixOf(name);
  };

  const roles = new Map();
  for (const column of columns) {
    const { name, type } = column;
    const inKey = Number(column.is_in_sorting_key) === 1;
    const aggregate = simple.get(name);
    let role = "unusable";
    let of;
    if (name === binding.timeColumn) {
      if (inKey && DATE_TIME.test(type)) role = "time";
    } else if (!aggregate) {
      if (UNIQ_AGGREGATE.test(type) && name.length > SUFFIX.uniq.length && name.endsWith(SUFFIX.uniq)) {
        role = "uniq";
        of = name.slice(0, -SUFFIX.uniq.length);
      } else if (inKey && !AGGREGATE_STATE.test(type)) {
        role = "group";
      }
    } else if (name === ROWS_COLUMN) {
      if (aggregate.fn === "sum" && aggregate.inner === "UInt64") role = "rows";
    } else if (suffixOf(name)) {
      const [kind, suffix] = suffixOf(name);
      const base = name.slice(0, -suffix.length);
      const fits =
        kind === "count"
          ? aggregate.fn === "sum" && aggregate.inner === "UInt64"
          : aggregate.fn === kind;
      if (fits && isSum(base)) {
        role = kind;
        of = base;
      }
    } else if (aggregate.fn === "sum") {
      role = "sum";
    } else if (aggregate.fn === "sumMap") {
      const value = STRING_KEYED_MAP.exec(aggregate.inner);
      if (value && NUMERIC.test(value[1])) role = "sumMap";
    }
    roles.set(name, of ? { role, type, of } : { role, type });
  }
  return roles;
}

function suffixOf(name) {
  for (const [kind, suffix] of Object.entries(SUFFIX)) {
    if (name.length > suffix.length && name.endsWith(suffix)) return [kind, suffix];
  }
  return null;
}

/** Changes whenever the binding or any column changes; column order does not matter. */
export function structureFingerprint(binding, columns) {
  const listed = columns
    .map((column) => [column.name, column.type, Number(column.is_in_sorting_key)])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return createHash("md5").update(JSON.stringify([binding, listed])).digest("hex");
}

/** The time bucket an aggregate row belongs to. Buckets are cut in UTC. */
export const bucketExpression = (timeColumn, grain) =>
  grain === "1 month"
    ? `toDateTime(toStartOfMonth(src.${quote(timeColumn)}, 'UTC'), 'UTC')`
    : `toDateTime(toStartOfInterval(src.${quote(timeColumn)}, INTERVAL ${grain}, 'UTC'), 'UTC')`;

/**
 * The one statement that summarises a source partition into aggregate rows:
 * a plain read by default, every source column qualified with `src.` because
 * an output alias would otherwise shadow the column it is built from.
 *
 * @param {{database: string, sourceTable: string, timeColumn: string, grain: string,
 *   columns: Map<string, {role: string, of?: string}>}} structure
 * @param {string} partitionId
 * @param {{final?: boolean, whereExtra?: string|null}} [options]
 * @returns {{sql: string, columns: string[]}} columns in SELECT order, for inserting by name
 */
export function fillSelect(structure, partitionId, { final = false, whereExtra = null } = {}) {
  if (typeof partitionId !== "string" || !PARTITION_ID.test(partitionId)) {
    throw new Error("partition id is not a plain identifier");
  }
  const bucket = bucketExpression(structure.timeColumn, structure.grain);
  const select = [];
  const names = [];
  const groupBy = [];
  for (const [name, { role, of }] of structure.columns) {
    const source = `src.${quote(of || name)}`;
    let expression;
    if (role === "group") {
      expression = source;
      groupBy.push(source);
    } else if (role === "time") {
      expression = bucket;
      groupBy.push(bucket);
    } else if (role === "sum") expression = `sum(${source})`;
    else if (role === "count") expression = `count(${source})`;
    else if (role === "min") expression = `min(${source})`;
    else if (role === "max") expression = `max(${source})`;
    else if (role === "sumMap") expression = `sumMap(${source})`;
    else if (role === "uniq") expression = `uniqState(${source})`;
    else if (role === "rows") expression = "count()";
    else continue;
    select.push(`${expression} AS ${quote(name)}`);
    names.push(name);
  }
  const from = `${tableRef(structure.database, structure.sourceTable)} AS src${final ? " FINAL" : ""}`;
  const where = `src._partition_id = '${partitionId}'${whereExtra ? ` AND (${whereExtra})` : ""}`;
  return {
    sql: `SELECT ${select.join(", ")} FROM ${from} WHERE ${where} GROUP BY ${groupBy.join(", ")}`,
    columns: names,
  };
}
