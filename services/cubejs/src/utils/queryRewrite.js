import YAML from "yaml";

import { fetchGraphQL } from "./graphql.js";
import { findDataSchemasByIds } from "./dataSourceHelpers.js";
import { parseCubesFromJs } from "./smart-generation/diffModels.js";

const getColumnsArray = (cube) => [
  ...(cube?.dimensions || []),
  ...(cube?.measures || []),
  ...(cube?.segments || []),
];

// --- Rule cache with 60-second TTL ---
let rulesCache = null;
let rulesCacheTime = 0;
const RULES_CACHE_TTL = 60_000;

// --- Cube-to-table mapping cache, keyed by schemaVersion ---
const cubeTableMapCache = new Map();
const CUBE_TABLE_MAP_MAX_SIZE = 50;

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

export function invalidateRulesCache() {
  rulesCache = null;
  rulesCacheTime = 0;
}

/**
 * Load query rewrite rules from the database, cached with 60s TTL.
 * Exported so runSql.js can reuse it for SQL API blocking.
 */
export async function loadRules() {
  const now = Date.now();
  if (rulesCache && now - rulesCacheTime < RULES_CACHE_TTL) {
    return rulesCache;
  }

  try {
    const res = await fetchGraphQL(rulesQuery);
    rulesCache = res?.data?.query_rewrite_rules || [];
    rulesCacheTime = now;
  } catch (err) {
    console.error("[queryRewrite] Failed to load rules:", err.message);
    // If cache exists, keep using stale data; otherwise empty
    if (!rulesCache) rulesCache = [];
  }

  return rulesCache;
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
      /\bFROM\s+[`"]?(?:[\w-]+\.)?[`"]?([a-zA-Z_][\w]*)[`"]?/i
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
async function buildCubeToTableMap(schemaVersion, fileIds) {
  if (cubeTableMapCache.has(schemaVersion)) {
    return cubeTableMapCache.get(schemaVersion);
  }

  // Maps cubeName → { sourceTable, dimensions: Set<string> }
  const mapping = new Map();

  try {
    const schemas = await findDataSchemasByIds({ ids: fileIds });

    for (const schema of schemas) {
      const { code, name } = schema;
      if (!code) continue;

      const isYaml = name?.endsWith(".yml") || name?.endsWith(".yaml");
      let cubes;

      if (isYaml) {
        try {
          const parsed = YAML.parse(code);
          cubes = parsed?.cubes;
        } catch {
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
          (cube.dimensions || []).map((d) => d.name).filter(Boolean)
        );
        mapping.set(cube.name, { sourceTable, dimensions: dims });
      }
    }
  } catch (err) {
    console.error("[queryRewrite] Failed to build cube-to-table map:", err.message);
  }

  // Evict oldest entry if cache is full
  if (cubeTableMapCache.size >= CUBE_TABLE_MAP_MAX_SIZE) {
    const oldest = cubeTableMapCache.keys().next().value;
    cubeTableMapCache.delete(oldest);
  }
  cubeTableMapCache.set(schemaVersion, mapping);

  return mapping;
}

/**
 * Extract cube names from query dimensions and measures.
 * Cube.js query members are formatted as "CubeName.memberName".
 */
function extractCubeNames(query) {
  const names = new Set();
  const allMembers = getColumnsArray(query);
  for (const member of allMembers) {
    const dotIndex = member.indexOf(".");
    if (dotIndex > 0) {
      names.add(member.substring(0, dotIndex));
    }
  }
  return names;
}

/**
 * Rewrite a query based on the user's permissions.
 * 1. Apply rule-based row filtering (all roles, including owner/admin)
 *    Rules are defined by source table name — they apply to ALL cubes
 *    backed by that table, not just cubes with a matching name.
 * 2. Apply field-level access list check (non-owner/non-admin only)
 */
const queryRewrite = async (query, { securityContext }) => {
  const { userScope } = securityContext;
  const { dataSourceAccessList, hasAccessList, role, teamProperties, memberProperties } = userScope;

  // --- Step 1: Rule-based row filtering (applies to ALL roles) ---
  const rules = await loadRules();

  if (rules.length > 0) {
    const queryCubeNames = extractCubeNames(query);

    // Build cube → source table mapping from active schemas
    const { schemaVersion, files } = userScope.dataSource;
    const cubeToTable = await buildCubeToTableMap(schemaVersion, files);

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

    for (const cubeName of queryCubeNames) {
      // Resolve the source table and available dimensions for this cube.
      // Fall back to the cube name itself for cubes without meta.source_table
      // (e.g. hand-written schemas where cube name matches table name).
      const cubeInfo = cubeToTable.get(cubeName);
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

        const filterKey = `${cubeName}.${rule.dimension}`;

        if (appliedFilters.has(filterKey)) continue;

        const source = rule.property_source === "team" ? teamProperties : memberProperties;
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
    []
  );

  queryNames.forEach((cn) => {
    if (!accessNames.includes(cn)) {
      throw new Error(`403: You have no access to "${cn}" cube property`);
    }
  });

  return query;
};

export default queryRewrite;
