import { fetchGraphQL } from "./graphql.js";

const getColumnsArray = (cube) => [
  ...(cube?.dimensions || []),
  ...(cube?.measures || []),
  ...(cube?.segments || []),
];

// --- Rule cache with 60-second TTL ---
let rulesCache = null;
let rulesCacheTime = 0;
const RULES_CACHE_TTL = 60_000;

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
 * 2. Apply field-level access list check (non-owner/non-admin only)
 */
const queryRewrite = async (query, { securityContext }) => {
  const { userScope } = securityContext;
  const { dataSourceAccessList, role, teamProperties, memberProperties } = userScope;

  // --- Step 1: Rule-based row filtering (applies to ALL roles) ---
  const rules = await loadRules();

  if (rules.length > 0) {
    const queryCubeNames = extractCubeNames(query);
    let blocked = false;

    if (!query.filters) {
      query.filters = [];
    }

    // Rules are table-level: apply each unique dimension filter once per cube.
    // Deduplicate by tracking which cube.dimension pairs are already filtered.
    const appliedFilters = new Set();

    for (const rule of rules) {
      const source = rule.property_source === "team" ? teamProperties : memberProperties;
      const value = source?.[rule.property_key];

      for (const cubeName of queryCubeNames) {
        const filterKey = `${cubeName}.${rule.dimension}`;

        // Skip if already applied for this cube+dimension
        if (appliedFilters.has(filterKey)) continue;

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
