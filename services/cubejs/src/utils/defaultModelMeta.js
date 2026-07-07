import YAML from "yaml";

import { fetchGraphQL } from "./graphql.js";
import createMd5Hex from "./md5Hex.js";
import { parseCubesFromJs } from "./smart-generation/diffModels.js";

/**
 * Cached per-team derived-model meta for the query pre-processor (013,
 * contracts/query-preprocessor.md "Identity & member-map resolution").
 *
 * The middleware runs BEFORE gateway auth, so everything here is resolved
 * read-only via the admin-secret path and cached (TTL ≤ 30s). The member map
 * is built by PARSING the raw dataschema files — the queryRewrite.js
 * buildCubeToTableMap precedent — deliberately NOT compiled meta, which
 * would risk a 15-30s cold compile on the query path.
 */

const TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;

const contextCache = new Map(); // partition -> {expires, value}
const userPartitionCache = new Map(); // userId -> {expires, partition}

const evictOldest = (cache) => {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
};

const CONTEXT_QUERY = `
  query ($dsId: uuid!) {
    datasources_by_pk(id: $dsId) {
      id
      name
      team {
        id
        settings
      }
      branches(where: { status: { _eq: active } }, limit: 1) {
        id
        versions(limit: 1, order_by: { created_at: desc }) {
          id
          dataschemas {
            id
            name
            code
          }
        }
      }
    }
  }
`;

const USER_PARTITION_QUERY = `
  query ($userId: uuid!) {
    members(where: { user_id: { _eq: $userId } }, limit: 1) {
      team {
        settings
      }
    }
  }
`;

const parseCubes = (name, code) => {
  try {
    if (name.endsWith(".yml") || name.endsWith(".yaml")) {
      return YAML.parse(code)?.cubes || [];
    }
    return parseCubesFromJs(code) || [];
  } catch {
    return [];
  }
};

// Preferred default aggregation order for measure slots (014)
const SLOT_AGG_PREFERENCE = ["sum", "avg", "max", "min", "count"];

// Collect meta.param_slot markers into a per-map slot registry (014):
// { <mapColumn>: [ { id, keyMember, valueMember, memberKind, aggs } ] }
const buildSlotRegistry = (cube) => {
  const accumulator = new Map(); // map -> slotId -> {keyMember, values:[{name, agg, isMeasure}]}

  const collect = (list, isMeasure) => {
    for (const field of list || []) {
      const slot = field?.meta?.param_slot;
      if (!slot?.map || !slot.role || !slot.slot) continue;
      if (!accumulator.has(slot.map)) accumulator.set(slot.map, new Map());
      const byId = accumulator.get(slot.map);
      if (!byId.has(slot.slot)) byId.set(slot.slot, { keyMember: null, values: [] });
      const entry = byId.get(slot.slot);
      if (slot.role === "key") {
        entry.keyMember = field.name;
      } else if (slot.role === "value") {
        entry.values.push({ name: field.name, agg: slot.agg || null, isMeasure });
      }
    }
  };
  collect(cube.dimensions, false);
  collect(cube.measures, true);

  const registry = {};
  for (const [mapName, byId] of accumulator) {
    const slots = [];
    for (const [id, entry] of byId) {
      if (!entry.keyMember || entry.values.length === 0) continue; // incomplete slot
      const aggs = {};
      for (const v of entry.values) {
        if (v.agg) aggs[v.agg] = v.name;
      }
      const preferred =
        SLOT_AGG_PREFERENCE.map((a) => aggs[a]).find(Boolean) ||
        entry.values[0].name;
      slots.push({
        id,
        keyMember: entry.keyMember,
        valueMember: preferred,
        memberKind: entry.values[0].isMeasure ? "measure" : "dimension",
        aggs,
      });
    }
    if (slots.length > 0) {
      slots.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      registry[mapName] = slots;
    }
  }
  return registry;
};

export const buildMemberMap = (dataschemas) => {
  const map = new Map();
  for (const schema of dataschemas || []) {
    for (const cube of parseCubes(schema.name, schema.code)) {
      if (cube?.meta?.default_model !== true) continue;
      const members = new Set();
      for (const list of [cube.dimensions, cube.measures, cube.segments]) {
        for (const field of list || []) {
          if (field?.name) members.add(field.name);
        }
      }
      map.set(cube.name, {
        template: cube.meta.template || null,
        members,
        hasScopeDimension: (cube.dimensions || []).some(
          (d) => d?.name === "partition"
        ),
        slots: buildSlotRegistry(cube),
      });
    }
  }
  return map;
};

/**
 * Datasource-first resolution: the request's own x-hasura-datasource-id →
 * datasource row → owning team → active branch → latest version → member map.
 *
 * Tenancy consistency is enforced here: the datasource's team partition MUST
 * equal the caller's JWT partition, and the datasource must be the configured
 * target — otherwise null (pass-through, gateway auth decides). This is
 * strictly tighter than the original partition→team chain: a caller can never
 * get another partition's member map, even when several teams share a
 * partition value.
 */
export const resolveDefaultModelContext = async (
  { partition, datasourceId },
  deps = {}
) => {
  const { execute = fetchGraphQL, now = Date.now() } = deps;

  const targetName = process.env.DEFAULT_MODELS_TARGET_DATASOURCE_NAME;
  if (!targetName || !partition || !datasourceId) return null;

  const cacheKey = `${datasourceId}|${partition}`;
  const cached = contextCache.get(cacheKey);
  if (cached && cached.expires > now) {
    return cached.value;
  }

  const res = await execute(CONTEXT_QUERY, { dsId: datasourceId });
  const datasource = res?.data?.datasources_by_pk;
  const version = datasource?.branches?.[0]?.versions?.[0];

  let value = null;
  if (
    datasource &&
    version &&
    datasource.name === targetName &&
    datasource.team?.settings?.partition === partition // tenancy cross-check
  ) {
    const schemaVersion = createMd5Hex(version.dataschemas.map((s) => s.id));
    value = {
      teamId: datasource.team.id,
      datasourceId: datasource.id,
      schemaVersion,
      memberMap: buildMemberMap(version.dataschemas),
      adaptations: new Map(), // R1 rename map — day-one empty extension point
    };
  }

  evictOldest(contextCache);
  contextCache.set(cacheKey, { expires: now + TTL_MS, value });
  return value;
};

/**
 * Legacy-JWT fallback: hasura-backend-plus tokens carry no partition claim —
 * resolve userId → membership → team.settings.partition (cached per user).
 */
export const resolvePartitionForUser = async (userId, deps = {}) => {
  const { execute = fetchGraphQL, now = Date.now() } = deps;
  if (!userId) return null;

  const cached = userPartitionCache.get(userId);
  if (cached && cached.expires > now) {
    return cached.partition;
  }

  const res = await execute(USER_PARTITION_QUERY, { userId });
  const partition = res?.data?.members?.[0]?.team?.settings?.partition || null;

  evictOldest(userPartitionCache);
  userPartitionCache.set(userId, { expires: now + TTL_MS, partition });
  return partition;
};

export const clearDefaultModelMetaCaches = () => {
  contextCache.clear();
  userPartitionCache.clear();
};
