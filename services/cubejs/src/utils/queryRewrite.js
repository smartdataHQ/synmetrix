import YAML from "yaml";

import { fetchGraphQL } from "./graphql.js";
import { findDataSchemasByIds } from "./dataSourceHelpers.js";
import { parseCubesFromJs } from "./smart-generation/diffModels.js";
import { assertNoLegacyEnrichmentQuery } from "./legacyEnrichmentGuard.js";

const getColumnsArray = (cube) => [
  ...(cube?.dimensions || []),
  ...(cube?.measures || []),
  ...(cube?.segments || []),
];

// Every member a query reads, wherever it names it: a query whose cube appears
// only in its timeDimensions or filters must meet the same row rules and
// partition pruning as one that selects it.
const filterMembers = (filters) =>
  (filters || []).flatMap((filter) => [
    ...(typeof filter?.member === "string" ? [filter.member] : []),
    ...(typeof filter?.dimension === "string" ? [filter.dimension] : []),
    ...filterMembers(filter?.and),
    ...filterMembers(filter?.or),
  ]);

const queryMembers = (query) => [
  ...getColumnsArray(query),
  ...(query?.timeDimensions || [])
    .map((td) => td?.dimension)
    .filter((member) => typeof member === "string"),
  ...filterMembers(query?.filters),
];

// --- Partition pruning policy (owner rule, 2026-09-03) ---
// A cube over a partitioned event table must never reach the warehouse
// without a predicate on the partition time column. `cst.semantic_events`
// is partitioned by (partition, toStartOfMonth(timestamp)); a row-type cube
// whose time dimension is a JSON payload path (e.g. `properties.started_at`)
// makes ClickHouse read the JSON column for every row of every month —
// measured 10 GiB / 18.6M rows for a one-week POI query, 13 MiB / 119 ms
// once the timestamp window is present. The rewrite derives that window from
// the query's explicit date ranges, widened by `marginDays` on both sides so
// events recorded later than the payload time (a stay ends days after it
// starts) are never excluded. Policy per source table; override with
// CUBEJS_PARTITION_PRUNING (JSON: { table: { dimension, marginDays } }), and
// per cube with `meta.partition_dimension`.
const DEFAULT_PARTITION_PRUNING = {
  semantic_events: { dimension: "timestamp", marginDays: 31 },
};

function loadPartitionPruningPolicy() {
  const raw = process.env.CUBEJS_PARTITION_PRUNING;
  if (!raw) return DEFAULT_PARTITION_PRUNING;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? { ...DEFAULT_PARTITION_PRUNING, ...parsed }
      : DEFAULT_PARTITION_PRUNING;
  } catch (err) {
    console.error(
      "[queryRewrite] CUBEJS_PARTITION_PRUNING is not valid JSON:",
      err.message,
    );
    return DEFAULT_PARTITION_PRUNING;
  }
}

const PARTITION_PRUNING = loadPartitionPruningPolicy();

// --- Row-rule exemption (owner rule, 2026-10-12) ---
// Teams whose `settings.partition` is listed here skip the rule-based row
// filters (Step 1) and see every partition: the platform owner (fftech.is).
// Deployment config only — teams cannot write `settings` through Hasura.
// Comma-separated: CUBEJS_ROW_RULES_EXEMPT_PARTITIONS=fftech.is
const ROW_RULES_EXEMPT_PARTITIONS = new Set(
  String(process.env.CUBEJS_ROW_RULES_EXEMPT_PARTITIONS || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean),
);

const DAY_MS = 24 * 60 * 60 * 1000;

function parseExplicitDate(value) {
  if (typeof value !== "string") return null;
  // Cube accepts "YYYY-MM-DD" and ISO datetimes; relative expressions
  // ("last 7 days") are left to Cube and yield no pruning window.
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) ? ms : null;
}

function formatDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Explicit [from, to] windows the query states for members of `cubeName`,
 * from timeDimensions.dateRange and inDateRange filters.
 */
function explicitDateWindows(query, instance, cubeToTable) {
  const windows = [];
  const consider = (member, range) => {
    if (
      typeof member !== "string" ||
      !member.startsWith(`${instance}.`) ||
      memberInstance(member, cubeToTable).instance !== instance
    ) {
      return;
    }
    const pair = Array.isArray(range) ? range : [range, range];
    if (pair.length !== 2) return;
    const from = parseExplicitDate(pair[0]);
    const to = parseExplicitDate(pair[1]);
    if (from === null || to === null) return;
    windows.push([from, to]);
  };
  for (const td of query.timeDimensions || []) {
    if (td?.dateRange) consider(td.dimension, td.dateRange);
  }
  for (const f of query.filters || []) {
    if (f?.operator === "inDateRange") consider(f.member, f.values);
  }
  return windows;
}

function mentionsMember(query, member) {
  return (
    (query.timeDimensions || []).some((td) => td?.dimension === member) ||
    (query.filters || []).some((f) => f?.member === member) ||
    (query.dimensions || []).includes(member)
  );
}

/**
 * Add the partition-column window for every query cube whose source table
 * is governed by the pruning policy. Mutates and returns `query`.
 * Exported for tests.
 */
export function applyPartitionPruning(
  query,
  cubeToTable,
  policy = PARTITION_PRUNING,
) {
  if (!query || !cubeToTable || cubeToTable.size === 0) return query;
  if (process.env.CUBEJS_PARTITION_PRUNING_DEBUG === "1") {
    console.log("[queryRewrite] pruning map", {
      cubes: [...cubeToTable.entries()].map(([k, v]) => `${k}→${v.sourceTable}`),
      query: [...queryInstances(query, cubeToTable).keys()],
    });
  }
  for (const [instance, cubeName] of queryInstances(query, cubeToTable)) {
    const info = cubeToTable.get(cubeName);
    if (!info?.sourceTable) continue;
    const rule = policy[info.sourceTable];
    if (!rule) continue;
    const dimension = info.partitionDimension || rule.dimension;
    if (!dimension || !info.dimensions?.has(dimension)) continue;
    const member = `${instance}.${dimension}`;
    // Already constrained on the partition column — nothing to add.
    if (mentionsMember(query, member)) continue;
    const windows = explicitDateWindows(query, instance, cubeToTable);
    if (windows.length === 0) continue;
    const margin = (Number(rule.marginDays) || 0) * DAY_MS;
    const from = Math.min(...windows.map((w) => w[0])) - margin;
    const to = Math.max(...windows.map((w) => w[1])) + margin;
    if (!query.filters) query.filters = [];
    query.filters.push({
      member,
      operator: "inDateRange",
      values: [formatDay(from), formatDay(to)],
    });
  }
  return query;
}

// --- Cube-to-table mapping cache, keyed by schemaVersion ---
// Sized for fleet-wide default models (013 D15): every team gets its own
// schemaVersion, so 50 would thrash once the scoping rule is active fleet-wide.
const cubeTableMapCache = new Map();
const CUBE_TABLE_MAP_MAX_SIZE = 1000;

const rulesQuery = `
  query {
    query_rewrite_rules {
      id
      cube_name
      dimension
      property_source
      property_key
      operator
    }
  }
`;

export function invalidateRulesCache() {}

/**
 * Load current query rewrite rules from the database.
 * Exported so runSql.js can reuse it for SQL API blocking.
 */
export async function loadRules() {
  const res = await fetchGraphQL(rulesQuery);
  if (res?.errors?.length || !Array.isArray(res?.data?.query_rewrite_rules)) {
    throw new Error("Query rewrite rules could not be resolved");
  }
  return res.data.query_rewrite_rules;
}

/**
 * Extract the bare table name from a sql_table or sql property.
 * Strips schema prefix (e.g. "cst.semantic_events" → "semantic_events")
 * and backtick/quote wrapping.
 */
function extractTableName(cube) {
  // 1. meta.source_table (explicit, highest priority)
  if (cube.meta?.source_table) return cube.meta.source_table;

  // 2. sql_table property (YAML string or JS template result)
  const sqlTable = cube.sql_table;
  if (typeof sqlTable === "string" && sqlTable.trim()) {
    const bare = sqlTable.replace(/[`"]/g, "").trim();
    const lastDot = bare.lastIndexOf(".");
    return lastDot >= 0 ? bare.substring(lastDot + 1) : bare;
  }

  // 3. sql property — parse "SELECT * FROM [schema.]table_name"
  const sql = cube.sql;
  if (typeof sql === "string") {
    const match = sql.match(
      /\bFROM\s+[`"]?(?:[\w-]+\.)?[`"]?([a-zA-Z_][\w]*)[`"]?/i,
    );
    if (match) return match[1];
  }

  return null;
}

/**
 * Build a Map of cubeName → sourceTable by parsing all active dataschema files.
 * Resolves the source table from meta.source_table, sql_table, or the sql FROM
 * clause so that query rewrite rules (which target table names) apply to ALL
 * cubes backed by a given table regardless of the cube name.
 * Cached by schemaVersion since the mapping only changes when models change.
 */
async function buildCubeToTableMap(schemaVersion, fileIds, expectedChecksums) {
  if (cubeTableMapCache.has(schemaVersion)) {
    return cubeTableMapCache.get(schemaVersion);
  }

  // Maps cubeName → { sourceTable, dimensions: Set<string> }
  const mapping = new Map();
  // Model files whose cubes could not be read: a query on a cube the map lacks
  // is refused while row rules apply, since it may be one of theirs.
  mapping.unreadable = [];
  // Every join alias any cube declares: a path through one the map cannot
  // resolve is refused rather than read without its cube's rules.
  mapping.joinAliases = new Set();

  try {
    const schemas = await findDataSchemasByIds({ ids: fileIds, expectedChecksums });

    for (const schema of schemas) {
      const { code, name } = schema;
      if (!code) continue;

      const isYaml = name?.endsWith(".yml") || name?.endsWith(".yaml");
      let cubes;

      if (isYaml) {
        try {
          // Cube reads models with js-yaml, which allows a repeated key.
          cubes = YAML.parse(code, { uniqueKeys: false })?.cubes;
        } catch {
          mapping.unreadable.push(name);
          continue;
        }
      } else {
        cubes = parseCubesFromJs(code);
      }

      if (!Array.isArray(cubes)) continue;

      for (const cube of cubes) {
        if (!cube.name) continue;
        const sourceTable = extractTableName(cube);
        const dims = new Set(
          (cube.dimensions || []).map((d) => d.name).filter(Boolean),
        );
        const joinAliases = new Map();
        for (const join of cube.joins || []) {
          if (!join?.alias) continue;
          mapping.joinAliases.add(join.alias);
          if (join.name) joinAliases.set(join.alias, join.name);
        }
        mapping.set(cube.name, {
          sourceTable,
          dimensions: dims,
          partitionDimension: cube.meta?.partition_dimension || null,
          joinAliases,
          extends: typeof cube.extends === "string" ? cube.extends : null,
        });
      }
    }
    // An `extends` child inherits its parent's aliased joins.
    for (const info of mapping.values()) {
      const seen = new Set();
      for (let parent = info.extends; parent && !seen.has(parent); ) {
        seen.add(parent);
        const parentInfo = mapping.get(parent);
        for (const [alias, target] of parentInfo?.joinAliases || []) {
          if (!info.joinAliases.has(alias)) info.joinAliases.set(alias, target);
        }
        parent = parentInfo?.extends;
      }
    }
  } catch (err) {
    console.error(
      "[queryRewrite] Failed to build cube-to-table map:",
      err.message,
    );
    throw err;
  }

  // Evict oldest entry if cache is full
  if (cubeTableMapCache.size >= CUBE_TABLE_MAP_MAX_SIZE) {
    const oldest = cubeTableMapCache.keys().next().value;
    cubeTableMapCache.delete(oldest);
  }
  cubeTableMapCache.set(schemaVersion, mapping);

  return mapping;
}

// A member path names the cube instance it reads: the cube named first, then
// any join aliases its model declares (Cube 1.8: `orders.customer.city` reads
// `users` as orders' `customer`). Row rules, partition pruning and the access
// list apply to that instance and its cube. Exported for tests.
export function memberInstance(member, cubeToTable) {
  const parts = member.split(".");
  let cube = parts[0];
  let depth = 1;
  while (depth < parts.length - 1) {
    const target = cubeToTable.get(cube)?.joinAliases?.get(parts[depth]);
    if (!target) break;
    cube = target;
    depth += 1;
  }
  // What remains is a member, or a time dimension and its granularity.
  const rest = parts.length - depth;
  if (rest > 2 || (rest === 2 && cubeToTable.joinAliases?.has(parts[depth]))) {
    const error = new Error(
      `'${member}' goes through a join alias the model map cannot resolve, so row rules could not follow it; query the member on its own cube`,
    );
    error.type = "UserError"; // the gateway answers 400
    throw error;
  }
  return { instance: parts.slice(0, depth).join("."), cube };
}

const orderMembers = (query) => {
  const order = query?.order;
  return Array.isArray(order)
    ? order.map((o) => (Array.isArray(o) ? o[0] : o?.id))
    : Object.keys(order || {});
};

/**
 * Every cube instance the query reads: instance path -> cube name.
 * Exported for tests.
 */
export function queryInstances(query, cubeToTable) {
  const instances = new Map();
  for (const member of [...queryMembers(query), ...orderMembers(query)]) {
    if (typeof member !== "string" || member.indexOf(".") <= 0) continue;
    const { instance, cube } = memberInstance(member, cubeToTable);
    instances.set(instance, cube);
  }
  return instances;
}

/**
 * Rewrite a query based on the user's permissions.
 * 1. Apply rule-based row filtering (all roles, including owner/admin)
 *    Rules are defined by source table name — they apply to ALL cubes
 *    backed by that table, not just cubes with a matching name.
 *    Skipped for teams in CUBEJS_ROW_RULES_EXEMPT_PARTITIONS.
 * 2. Apply field-level access list check (non-owner/non-admin only)
 */
const queryRewrite = async (query, { securityContext }) => {
  // Retired managed enrichment cubes remain unavailable even if an old
  // historical tenant version is restored.
  assertNoLegacyEnrichmentQuery(query);

  const { userScope } = securityContext;
  const {
    dataSourceAccessList,
    hasAccessList,
    role,
    teamProperties,
    memberProperties,
  } = userScope;

  // --- Step 0: Strip unresolvable "no order" placeholders ---
  // The client query builder emits `emptyCube.emptyKey` as a sentinel for
  // "no order selected". The legacy planner silently ignored the unresolvable
  // member; the Tesseract planner rejects it ("Cannot resolve: emptyCube") and
  // 500s the query. Removing it is safe — it just means "no explicit order".
  if (query && query.order) {
    const isPlaceholder = (m) =>
      typeof m === "string" && m.startsWith("emptyCube.");
    if (Array.isArray(query.order)) {
      query.order = query.order.filter((o) =>
        Array.isArray(o)
          ? !isPlaceholder(o[0])
          : !isPlaceholder(o && (o.id || o.member)),
      );
    } else if (typeof query.order === "object") {
      for (const key of Object.keys(query.order)) {
        if (isPlaceholder(key)) delete query.order[key];
      }
    }
  }

  // --- Step 0b: Partition pruning (applies to ALL roles, before any rule) ---
  const { schemaVersion, files, fileChecksums } = userScope.dataSource;
  const cubeToTable = await buildCubeToTableMap(schemaVersion, files, fileChecksums);
  applyPartitionPruning(query, cubeToTable);

  // --- Step 1: Rule-based row filtering (applies to ALL roles) ---
  const rules = securityContext.queryRules || (await loadRules());
  const exempt = ROW_RULES_EXEMPT_PARTITIONS.has(teamProperties?.partition);

  if (rules.length > 0 && !exempt) {
    const instances = queryInstances(query, cubeToTable);

    // Index rules by table name for fast lookup
    const rulesByTable = new Map();
    for (const rule of rules) {
      const tableName = rule.cube_name; // cube_name column stores the table name
      if (!rulesByTable.has(tableName)) {
        rulesByTable.set(tableName, []);
      }
      rulesByTable.get(tableName).push(rule);
    }

    let blocked = false;

    if (!query.filters) {
      query.filters = [];
    }

    // Deduplicate by tracking which cube.dimension pairs are already filtered.
    const appliedFilters = new Set();

    for (const [instance, cubeName] of instances) {
      // Resolve the source table and available dimensions for this cube.
      // Fall back to the cube name itself for cubes without meta.source_table
      // (e.g. hand-written schemas where cube name matches table name).
      const cubeInfo = cubeToTable.get(cubeName);
      if (!cubeInfo && cubeToTable.unreadable?.length) {
        blocked = true;
        break;
      }
      const sourceTable = cubeInfo?.sourceTable || cubeName;
      const cubeDimensions = cubeInfo?.dimensions;
      const tableRules = rulesByTable.get(sourceTable);
      if (!tableRules) continue;

      for (const rule of tableRules) {
        // If the cube is backed by a ruled table but lacks the required
        // dimension, block the query — dropping a dimension must not
        // bypass access control.
        if (cubeDimensions && !cubeDimensions.has(rule.dimension)) {
          blocked = true;
          break;
        }

        const filterKey = `${instance}.${rule.dimension}`;

        if (appliedFilters.has(filterKey)) continue;

        const source =
          rule.property_source === "team" ? teamProperties : memberProperties;
        const value = source?.[rule.property_key];

        if (value === undefined || value === null) {
          blocked = true;
          break;
        }

        query.filters.push({
          member: filterKey,
          operator: rule.operator,
          values: [String(value)],
        });
        appliedFilters.add(filterKey);
      }

      if (blocked) break;
    }

    // If blocked (missing property), block the ENTIRE query
    if (blocked) {
      const allMembers = getColumnsArray(query);
      if (allMembers.length > 0) {
        query.filters = [
          {
            member: allMembers[0],
            operator: "equals",
            values: ["__blocked_by_access_control__"],
          },
        ];
      }
      return query;
    }
  }

  // --- Step 2: Field-level access list check (non-owner/non-admin only) ---
  if (["owner", "admin"].includes(role)) {
    return query;
  }

  // No access list assigned (access_list_id is NULL) → no restrictions configured.
  // Auto-provisioned members start without an access list and get full access
  // until an admin explicitly assigns one to scope their permissions.
  if (!hasAccessList) {
    return query;
  }

  // Access list IS assigned but has no entry for this datasource → deny.
  if (!dataSourceAccessList) {
    throw new Error("403: You have no access to the datasource");
  }

  const queryNames = getColumnsArray(query);
  const accessNames = Object.values(dataSourceAccessList).reduce(
    (acc, cube) => [...acc, ...getColumnsArray(cube)],
    [],
  );

  queryNames.forEach((cn) => {
    // An aliased path reads its target cube's member: orders.customer.city
    // needs access to users.city.
    const { instance, cube } =
      typeof cn === "string" && cn.includes(".")
        ? memberInstance(cn, cubeToTable)
        : { instance: null, cube: null };
    const name = instance && instance !== cube ? `${cube}.${cn.slice(instance.length + 1)}` : cn;
    if (!accessNames.includes(name)) {
      throw new Error(`403: You have no access to "${cn}" cube property`);
    }
  });

  return query;
};

export default queryRewrite;
