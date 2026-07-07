import createMd5Hex from "./md5Hex.js";

/**
 * Dynamic property discovery probes (014, FR-005..007).
 *
 * Enumerates the map keys and JSON paths present in a team's slice of a
 * source table — optionally under a caller-supplied filter (e.g. one event
 * type) — and shapes them as cube.dev-member-like directory entries with
 * ready-to-use query forms. Every probe is partition-scoped (FR-006) and
 * results are cached with a short TTL (FR-007).
 */

export const escapeSqlString = (value) =>
  String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

const assertIdentifier = (name, what) => {
  if (!IDENT_RE.test(String(name))) {
    const err = new Error(`invalid ${what}: ${name}`);
    err.status = 400;
    err.code = "invalid_identifier";
    throw err;
  }
  return name;
};

// Resolve a filter member to a plain column: a dimension whose SQL is a bare
// column (`col` or `{CUBE}.col`), or — for skeleton models that lack the
// member — a bare name that verifiably IS a column on the source table.
// Anything else is rejected rather than interpolated.
const resolveFilterColumn = (member, cubeDef, tableColumns) => {
  const name = member.includes(".") ? member.split(".").pop() : member;
  const dimension = (cubeDef.dimensions || []).find((d) => d.name === name);
  const sql = dimension?.sql || null;
  if (sql) {
    const bare = sql.replace("{CUBE}.", "");
    if (IDENT_RE.test(bare)) return bare;
  }
  if (!dimension && tableColumns?.has(name) && IDENT_RE.test(name)) {
    return name;
  }
  const err = new Error(`unsupported_filter: ${member}`);
  err.status = 400;
  err.code = "unsupported_filter";
  throw err;
};

export const buildFilterWhere = ({ partition, filters = [], cubeDef, tableColumns = null }) => {
  const clauses = [`partition = '${escapeSqlString(partition)}'`];
  for (const filter of filters) {
    if (!filter?.member || !Array.isArray(filter.values) || filter.values.length === 0) {
      const err = new Error("unsupported_filter: member and values required");
      err.status = 400;
      err.code = "unsupported_filter";
      throw err;
    }
    if (filter.operator !== "equals") {
      const err = new Error(`unsupported_filter: operator ${filter.operator}`);
      err.status = 400;
      err.code = "unsupported_filter";
      throw err;
    }
    const column = resolveFilterColumn(filter.member, cubeDef, tableColumns);
    const values = filter.values.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    clauses.push(`${column} IN (${values})`);
  }
  return clauses.join(" AND ");
};

export const buildMapProbeSql = ({ table, column, where, sampleLimit = 5 }) => {
  assertIdentifier(table, "table");
  assertIdentifier(column, "column");
  return (
    `SELECT kv.1 AS key, count() AS occurrences, uniqExact(kv.2) AS cardinality, ` +
    `groupUniqArray(${Number(sampleLimit) || 5})(toString(kv.2)) AS sample_values ` +
    `FROM (SELECT arrayJoin(${column}) AS kv FROM ${table} WHERE ${where}) ` +
    `GROUP BY key ORDER BY occurrences DESC LIMIT 500`
  );
};

export const buildJsonProbeSql = ({ table, column, where }) => {
  assertIdentifier(table, "table");
  assertIdentifier(column, "column");
  return (
    `SELECT tup.1 AS path, tup.2 AS type, count() AS occurrences ` +
    `FROM (SELECT arrayJoin(JSONAllPathsWithTypes(${column})) AS tup FROM ${table} WHERE ${where}) ` +
    `GROUP BY path, type ORDER BY occurrences DESC LIMIT 1000`
  );
};

export const buildTotalSql = ({ table, where }) => {
  assertIdentifier(table, "table");
  return `SELECT count() AS total FROM ${table} WHERE ${where}`;
};

const unwrap = (type, wrapper) => {
  const prefix = `${wrapper}(`;
  if (type.startsWith(prefix) && type.endsWith(")")) {
    return type.slice(prefix.length, -1);
  }
  return type;
};

/** `Map(K, V)` → base value type name (LowCardinality/Nullable unwrapped), else null. */
export const parseMapValueType = (columnType) => {
  const type = String(columnType || "").trim();
  if (!type.startsWith("Map(")) return null;
  const inner = type.slice(4, -1);
  // split top-level comma
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      let value = inner.slice(i + 1).trim();
      value = unwrap(unwrap(value, "LowCardinality"), "Nullable");
      return unwrap(value, "LowCardinality");
    }
  }
  return null;
};

const CH_NUMERIC_RE = /^(Float|Int|UInt|Decimal)/;
const CH_TIME_RE = /^(DateTime|Date)/;

const cubeTypeFor = (chType) => {
  if (chType === "Bool") return "boolean";
  if (CH_NUMERIC_RE.test(chType)) return "number";
  if (CH_TIME_RE.test(chType)) return "time";
  return "string";
};

const title = (key) =>
  key
    .split(/[_.]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

export const shapeMapEntries = ({
  cube,
  column,
  valueType,
  rows,
  totalRows,
  sampleLimit = 5,
}) => {
  const type = cubeTypeFor(valueType);
  const memberKind =
    type === "number" ? "measure" : type === "boolean" ? "segment" : "dimension";

  return (rows || []).map((row) => {
    const key = row.key;
    const name = `${cube}.${column}.${key}`;
    const occurrences = Number(row.occurrences) || 0;
    const entry = {
      name,
      title: `${title(column)} › ${title(key)}`,
      shortTitle: title(key),
      type,
      memberKind,
      source: { column, kind: "map", key, valueType },
      stats: {
        occurrences,
        coverage: totalRows > 0 ? occurrences / totalRows : 0,
        cardinality: Number(row.cardinality) || 0,
        sampleValues: (row.sample_values || []).slice(0, sampleLimit),
      },
      query: {
        rest:
          memberKind === "measure" ? { measure: name } : { dimension: name },
        sql: `${column}['${escapeSqlString(key)}']`,
      },
    };
    if (memberKind === "measure") {
      entry.aggregations = ["sum", "avg"];
    }
    return entry;
  });
};

export const shapeJsonEntries = ({ cube, column, rows, totalRows }) => {
  // group by path, pick the dominant observed type
  const byPath = new Map();
  for (const row of rows || []) {
    const occurrences = Number(row.occurrences) || 0;
    if (!byPath.has(row.path)) byPath.set(row.path, { total: 0, types: [] });
    const entry = byPath.get(row.path);
    entry.total += occurrences;
    entry.types.push({ type: row.type, occurrences });
  }

  const entries = [];
  for (const [path, info] of byPath) {
    info.types.sort((a, b) => b.occurrences - a.occurrences);
    const dominant = info.types[0];
    const type = cubeTypeFor(dominant.type);
    const name = `${cube}.${column}.${path}`;
    const sqlAccess =
      type === "number"
        ? `CAST(${column}.${path} AS Float64)`
        : type === "boolean"
          ? `CAST(${column}.${path} AS Bool)`
          : `toString(${column}.${path})`;
    entries.push({
      name,
      title: `${title(column)} › ${title(path)}`,
      shortTitle: title(path),
      type,
      memberKind: "dimension",
      source: {
        column,
        kind: "json",
        path,
        dominantType: dominant.type,
        typeShare: info.total > 0 ? dominant.occurrences / info.total : 0,
      },
      stats: {
        occurrences: info.total,
        coverage: totalRows > 0 ? info.total / totalRows : 0,
      },
      query: { rest: { dimension: name }, sql: sqlAccess },
    });
  }
  entries.sort((a, b) => b.stats.occurrences - a.stats.occurrences);
  return entries;
};

const MAX_CACHE_ENTRIES = 500;

export const createProbeCache = ({ ttlMs, now = Date.now } = {}) => {
  const store = new Map();
  const keyOf = (input) =>
    createMd5Hex([
      input.partition,
      input.cube,
      [...(input.targets || [])].sort(),
      JSON.stringify(input.filters || []),
      input.schemaVersion,
    ]);
  return {
    get(input) {
      const key = keyOf(input);
      const entry = store.get(key);
      if (!entry || entry.expires <= now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set(input, value) {
      if (store.size >= MAX_CACHE_ENTRIES) {
        store.delete(store.keys().next().value);
      }
      store.set(keyOf(input), { expires: now() + ttlMs, value });
    },
  };
};
