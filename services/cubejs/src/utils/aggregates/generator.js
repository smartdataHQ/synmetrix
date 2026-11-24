/**
 * Produces the definition of an aggregate table for any time-series source
 * table, from the table's own metadata, a grain and a grouping set. Text only:
 * it reads, and creates nothing (FR-024). The aggregate is filled by refresh.
 */
import { IDENTIFIER, ROWS_COLUMN, SUFFIX, fillSelect, parseGrain, parseInterval, quote } from "./contract.js";

const DAY = 86400;
const INTERVAL_FORM = '"<n> <unit>" with unit second, minute, hour or day';
const NUMERIC = /^(U?Int(8|16|32|64|128|256)|Float(32|64)|Decimal.*)$/;
const DATE_TIME = /^DateTime(64)?(\(.*\))?$/;
const NUMERIC_MAP = /^Map\((?:LowCardinality\(String\)|String),\s*(.*)\)$/s;
const NOT_A_KEY = /^(Map|Array|Tuple|Nested|JSON|Object|Variant|Dynamic|AggregateFunction|SimpleAggregateFunction|Point|Ring|Polygon|MultiPolygon|LineString|MultiLineString)\b/;
const UTC = new Set(["UTC", "Etc/UTC", "Etc/UCT", "Etc/Universal", "Etc/Zulu"]);

// How long one value of a partition function lasts, in seconds. A day or more: whole UTC days.
const PARTITION_PERIOD = {
  toStartOfMinute: 60, toStartOfFiveMinutes: 300, toStartOfTenMinutes: 600, toStartOfFifteenMinutes: 900,
  toStartOfHour: 3600,
  toDate: DAY, toDate32: DAY, toStartOfDay: DAY, toYYYYMMDD: DAY,
  toMonday: DAY, toStartOfWeek: DAY, toYYYYMM: DAY, toStartOfMonth: DAY, toStartOfQuarter: DAY, toYear: DAY, toStartOfYear: DAY,
};
// Partition functions whose buckets are whole UTC months (so "1 month" nests cleanly inside them).
const MONTH_NESTING_PARTITIONS = new Set(["toYYYYMM", "toStartOfMonth", "toStartOfQuarter", "toYear", "toStartOfYear"]);

const unwrapped = (type) => {
  let inner = type;
  for (;;) {
    const match = /^(?:LowCardinality|Nullable)\((.*)\)$/s.exec(inner);
    if (!match) return inner;
    inner = match[1];
  }
};
const withoutLowCardinality = (type) => type.replace(/^LowCardinality\((.*)\)$/s, "$1");

/**
 * @param {(sql: string) => Promise<object[]>} queryFn reads only
 * @param {{source: string, timeColumn: string, grain: string, groupBy: string[], minAge: string,
 *   minWindow: string, maxStaleness: string, cluster?: string}} options
 * @returns {Promise<{table: string, definition: string, leftOut: Array<{name: string, reason: string}>,
 *   forcedMerge: string|null} | {declined: string}>}
 */
export async function generate(queryFn, options) {
  const decline = (reason) => ({ declined: reason });
  const { source, timeColumn, groupBy, cluster, name: customName } = options;

  const sourceName = typeof source === "string" && /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(source);
  if (!sourceName) return decline("--source must be <database>.<table>");
  const [, database, table] = sourceName;
  if (typeof timeColumn !== "string" || !IDENTIFIER.test(timeColumn)) return decline("--time-column must be a plain column name");
  if (!Array.isArray(groupBy) || groupBy.some((name) => typeof name !== "string" || !IDENTIFIER.test(name))) {
    return decline("--group-by must be a list of plain column names");
  }
  if (cluster !== undefined && !(typeof cluster === "string" && IDENTIFIER.test(cluster))) return decline("--cluster must be a plain name");
  if (customName !== undefined && !(typeof customName === "string" && IDENTIFIER.test(customName))) {
    return decline("--name must be a plain table name");
  }
  const grain = parseGrain(options.grain);
  if (!grain) {
    const rawGrain = parseInterval(options.grain);
    return decline(rawGrain ? "the grain does not divide one day" : `--grain must be ${INTERVAL_FORM} or "1 month"`);
  }
  const intervals = { grain };
  for (const [option, flag] of [["minAge", "--min-age"], ["minWindow", "--min-window"], ["maxStaleness", "--max-staleness"]]) {
    intervals[option] = parseInterval(options[option]);
    if (!intervals[option]) return decline(`${flag} must be ${INTERVAL_FORM}`);
  }
  if (intervals.maxStaleness.seconds === 0) return decline("--max-staleness must be greater than zero");

  const [sourceTable] = await queryFn(
    "SELECT engine, engine_full, partition_key, sorting_key, timezone() AS server_timezone FROM system.tables " +
      `WHERE database = '${database}' AND name = '${table}'`,
  );
  if (!sourceTable) return decline(`the source table ${source} does not exist`);
  const columns = await queryFn(
    "SELECT name, type, default_kind, default_expression, is_in_sorting_key, is_in_partition_key FROM system.columns " +
      `WHERE database = '${database}' AND table = '${table}' ORDER BY position`,
  );
  const byName = new Map(columns.map((column) => [column.name, column]));
  for (const name of [timeColumn, ...groupBy]) {
    if (!byName.has(name)) return decline(`the source has no column ${quote(name)}`);
  }

  // The time column: a date-time the source is partitioned by, in periods the grain nests inside.
  const time = byName.get(timeColumn);
  if (!DATE_TIME.test(time.type)) return decline(`${quote(timeColumn)} is not a date-time column`);
  if (Number(time.is_in_partition_key) !== 1) return decline(`the source's partition expression does not involve ${quote(timeColumn)}`);
  const zone = /'([^']+)'\)$/.exec(time.type)?.[1] || sourceTable.server_timezone;
  if (!UTC.has(zone)) {
    return decline(`${quote(timeColumn)} is not kept in UTC (${zone}): buckets are cut in UTC and would not nest inside the source's partitions`);
  }
  const partitionKey = String(sourceTable.partition_key);
  const uses = partitionKey.match(new RegExp(`\\b${timeColumn}\\b`, "g")) || [];
  const wrapped = [...partitionKey.matchAll(new RegExp(`([A-Za-z_][A-Za-z0-9_]*)\\(\\s*\`?${timeColumn}\`?\\s*[,)]`, "g"))].map((match) => match[1]);
  if (wrapped.length !== uses.length || wrapped.some((name) => !PARTITION_PERIOD[name])) {
    return decline("cannot tell whether the grain nests inside the source's partition expression");
  }
  if (
    grain.kind === "month"
      ? wrapped.some((name) => !MONTH_NESTING_PARTITIONS.has(name))
      : wrapped.some((name) => PARTITION_PERIOD[name] % grain.seconds !== 0)
  ) {
    return decline(`a grain of ${grain.text} does not nest inside the source's partition expression`);
  }

  // A derived (ALIAS) column declared non-nullable over an expression that can be NULL fails
  // when it is read on a row with a missing value. One such row would stop every build.
  const derived = columns.filter(
    ({ name, type, default_kind: kind }) =>
      kind === "ALIAS" && name !== timeColumn && !/Nullable\(/.test(type) && (groupBy.includes(name) || NUMERIC.test(unwrapped(type))),
  );
  const canFail = new Map();
  if (derived.length) {
    const described = await queryFn(
      `DESCRIBE (SELECT ${derived.map((column, index) => `(${column.default_expression}) AS a${index}`).join(", ")} ` +
        `FROM ${quote(database)}.${quote(table)})`,
    );
    derived.forEach((column, index) => {
      if (/^(LowCardinality\()?Nullable\(/.test(described[index]?.type || "")) {
        canFail.set(column.name, `declared ${column.type} while its expression can be NULL: reading it fails on a row with a missing value`);
      }
    });
  }

  // Grouping columns: what the partition expression reads, plus the requested ones.
  for (const column of columns) {
    if (Number(column.is_in_partition_key) === 1 && column.name !== timeColumn && !groupBy.includes(column.name)) {
      return decline(`the source's partition expression reads ${quote(column.name)}, which must be listed in --group-by`);
    }
  }
  for (const name of groupBy) {
    if (name === timeColumn) return decline(`${quote(name)} is the time column and cannot also be a grouping column`);
    const { type } = byName.get(name);
    if (NOT_A_KEY.test(unwrapped(type))) return decline(`${quote(name)} (${type}) cannot be a grouping column`);
    if (canFail.has(name)) return decline(`${quote(name)} is ${canFail.get(name)}`);
  }

  // Every other column: a metric, a summed map, or left out with a reason.
  const metrics = [];
  const maps = [];
  const leftOut = [];
  for (const { name, type, default_kind: kind, is_in_sorting_key: inKey } of columns) {
    if (name === timeColumn || groupBy.includes(name)) continue;
    const inner = unwrapped(type);
    const mapValue = NUMERIC_MAP.exec(type);
    const reserved = name === ROWS_COLUMN || Object.values(SUFFIX).some((suffix) => name.endsWith(suffix));
    if (reserved) leftOut.push({ name, reason: "its name is reserved by the aggregate contract" });
    else if (canFail.has(name)) leftOut.push({ name, reason: canFail.get(name) });
    else if (NUMERIC.test(inner) && kind !== "ALIAS" && Number(inKey) === 1) {
      leftOut.push({ name, reason: "numeric column in the source's sorting key: an identifier, not a metric" });
    } else if (NUMERIC.test(inner)) metrics.push(name);
    else if (mapValue && NUMERIC.test(mapValue[1])) maps.push(name);
    else if (NOT_A_KEY.test(inner)) leftOut.push({ name, reason: `type cannot be summarised (${type})` });
    else leftOut.push({ name, reason: "not numeric and not in --group-by" });
  }

  // The partition expression's own columns first, then the time bucket, then the rest as requested.
  const partitionColumns = columns.filter((column) => Number(column.is_in_partition_key) === 1 && column.name !== timeColumn).map((column) => column.name);
  const sortingKey = [...partitionColumns, timeColumn, ...groupBy.filter((name) => !partitionColumns.includes(name))];

  const roles = new Map();
  for (const name of sortingKey) roles.set(name, { role: name === timeColumn ? "time" : "group" });
  for (const name of metrics) {
    roles.set(name, { role: "sum" });
    for (const kind of ["count", "min", "max"]) roles.set(`${name}${SUFFIX[kind]}`, { role: kind, of: name });
  }
  for (const name of maps) roles.set(name, { role: "sumMap" });
  roles.set(ROWS_COLUMN, { role: "rows" });

  // Exact types come from ClickHouse's own description of the fill statement.
  const fill = fillSelect({ database, sourceTable: table, timeColumn, grain: grain.text, columns: roles }, "0");
  const described = new Map((await queryFn(`DESCRIBE (${fill.sql})`)).map((row) => [row.name, row.type]));
  const typeOf = (name, { role }) => {
    if (role === "group" || role === "time") return byName.get(name).type;
    if (role === "count" || role === "rows") return "SimpleAggregateFunction(sum, UInt64)";
    const type = withoutLowCardinality(described.get(name));
    if (role === "sumMap") return `SimpleAggregateFunction(sumMap, ${type.replace(/^Map\(LowCardinality\(String\)/, "Map(String")})`;
    return `SimpleAggregateFunction(${role}, ${type})`;
  };

  const keyTypes = sortingKey.map((name) => byName.get(name).type);
  const settings = [];
  if (keyTypes.some((type) => /Nullable\(/.test(type))) settings.push("allow_nullable_key = 1");
  if (keyTypes.some((type) => /^LowCardinality\(/.test(type) && !/^(String|FixedString)/.test(unwrapped(type)))) {
    settings.push("allow_suspicious_low_cardinality_types = 1");
  }
  const binding =
    `{"aggregate_of": "${source}", "time_column": "${timeColumn}", "grain": "${grain.text}", ` +
    `"min_age": "${intervals.minAge.text}", "min_window": "${intervals.minWindow.text}", "max_staleness": "${intervals.maxStaleness.text}"}`;
  const name = customName || `${table}__agg_${grain.text.replace(" ", "")}`;
  const onCluster = cluster ? ` ON CLUSTER ${cluster}` : "";
  const definition = [
    `CREATE TABLE IF NOT EXISTS ${database}.${name}${onCluster}`,
    "(",
    [...roles].map(([column, role]) => `    ${quote(column)} ${typeOf(column, role)}`).join(",\n"),
    ")",
    `ENGINE = ${cluster ? "Replicated" : ""}AggregatingMergeTree`,
    `PARTITION BY ${partitionKey}`,
    `ORDER BY (${sortingKey.map(quote).join(", ")})`,
    ...(settings.length ? [`SETTINGS ${settings.join(", ")}`] : []),
    `COMMENT '${binding}';`,
  ].join("\n");

  // A source whose merges change what a read returns keeps duplicates in old
  // partitions unless it is told to merge them by itself.
  const engine = String(sourceTable.engine);
  const mergesChangeReads = engine.replace(/^Replicated/, "") !== "MergeTree";
  const consolidates = /min_age_to_force_merge_seconds = [1-9]/.test(String(sourceTable.engine_full));
  const forcedMerge =
    mergesChangeReads && !consolidates
      ? `ALTER TABLE ${source}${onCluster} MODIFY SETTING min_age_to_force_merge_seconds = ${intervals.minAge.seconds || DAY}, ` +
        "min_age_to_force_merge_on_partition_only = 1;"
      : null;

  return { table: `${database}.${name}`, definition, leftOut, forcedMerge, sourceEngine: engine };
}

/** What the command prints: the definition, the left-out columns, and the forced-merge note when it applies. */
export function render({ definition, leftOut, forcedMerge, sourceEngine }) {
  const parts = [definition];
  if (leftOut.length) {
    parts.push(
      ["-- Left out: source columns the aggregate does not carry", ...leftOut.map(({ name, reason }) => `--   ${name}: ${reason}`)].join("\n"),
    );
  }
  if (forcedMerge) {
    parts.push(
      [
        `-- The source is a ${sourceEngine} table: a read returns replaced rows until the database merges them.`,
        "-- Its old partitions are not merged by themselves, so they keep their duplicates and the aggregate",
        "-- repeats them. To have a partition consolidate once all of it is old enough:",
        `--   ${forcedMerge}`,
      ].join("\n"),
    );
  }
  return `${parts.join("\n\n")}\n`;
}
