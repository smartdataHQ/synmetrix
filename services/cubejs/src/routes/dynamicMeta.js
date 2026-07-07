import YAML from "yaml";

import { findDataSchemasByIds } from "../utils/dataSourceHelpers.js";
import { parseCubesFromJs } from "../utils/smart-generation/diffModels.js";
import {
  buildFilterWhere,
  buildMapProbeSql,
  buildJsonProbeSql,
  buildTotalSql,
  parseMapValueType,
  shapeMapEntries,
  shapeJsonEntries,
  createProbeCache,
} from "../utils/dynamicPropertyProbe.js";

/**
 * POST /api/v1/meta/dynamic — dynamic property discovery (014, FR-005..007).
 *
 * Given a cube and optional simple filters (e.g. event = X), probes the
 * caller's team slice for available map keys and JSON paths and returns a
 * cube-meta-shaped directory dashboards/query composers can build from.
 * Mounted behind checkAuthMiddleware; every probe carries the security
 * context's partition (FR-006). Responses are TTL-cached (FR-007).
 */

const DEFAULT_TTL_MS = Number(process.env.DYNAMIC_META_TTL_MS) || 120_000;
const DEFAULT_SAMPLES = Number(process.env.DYNAMIC_META_SAMPLE_VALUES) || 5;

const sharedCache = createProbeCache({ ttlMs: DEFAULT_TTL_MS });

const parseCubesFromFile = (name, code) => {
  try {
    if (name.endsWith(".yml") || name.endsWith(".yaml")) {
      return YAML.parse(code)?.cubes || [];
    }
    return parseCubesFromJs(code) || [];
  } catch {
    return [];
  }
};

const resolveSourceTable = (cubeDef) => {
  if (cubeDef.sql_table) return cubeDef.sql_table;
  const db = cubeDef.meta?.source_database;
  const table = cubeDef.meta?.source_table;
  if (table) return db ? `${db}.${table}` : table;
  const match = /FROM\s+([A-Za-z_][A-Za-z0-9_.]*)/i.exec(cubeDef.sql || "");
  return match ? match[1] : null;
};

export default async function dynamicMeta(req, res, cubejs, deps = {}) {
  const {
    loadSchemas = (ids) => findDataSchemasByIds({ ids }),
    getDriver = () =>
      cubejs.options.driverFactory({ securityContext: req.securityContext }),
    ttlMs = DEFAULT_TTL_MS,
    sampleLimit = DEFAULT_SAMPLES,
    cache = deps.cache === undefined ? sharedCache : deps.cache,
  } = deps;

  const dataSource = req.securityContext?.userScope?.dataSource;
  if (!dataSource) {
    return res
      .status(403)
      .json({ code: "unauthorized", message: "authentication required" });
  }
  const partition = dataSource.partition;
  if (!partition) {
    return res.status(400).json({
      code: "partition_required",
      message: "dynamic discovery requires a partition-scoped team datasource",
    });
  }

  const { cube, filters = [], targets = null } = req.body || {};
  if (!cube || typeof cube !== "string") {
    return res
      .status(400)
      .json({ code: "invalid_input", message: "cube is required" });
  }

  try {
    const cacheInput = {
      partition,
      cube,
      targets: targets || ["*"],
      filters,
      schemaVersion: dataSource.schemaVersion,
    };
    const cached = cache?.get(cacheInput);
    if (cached) {
      return res.json({
        ...cached,
        freshness: { ...cached.freshness, cached: true },
      });
    }

    // resolve the cube definition from the team's own model files
    const schemas = await loadSchemas(dataSource.files || []);
    let cubeDef = null;
    for (const schema of schemas || []) {
      cubeDef = parseCubesFromFile(schema.name, schema.code).find(
        (c) => c?.name === cube
      );
      if (cubeDef) break;
    }
    if (!cubeDef) {
      return res
        .status(404)
        .json({ code: "cube_not_found", message: `cube ${cube} not found` });
    }
    const table = resolveSourceTable(cubeDef);
    if (!table) {
      return res.status(400).json({
        code: "source_unresolvable",
        message: `cube ${cube} has no resolvable source table`,
      });
    }

    const driver = await getDriver();

    // discover map/JSON columns on the source table (also feeds the filter
    // fallback: skeleton models may lack the member, but the column is real)
    const described = await driver.query(`DESCRIBE TABLE ${table}`);
    const tableColumns = new Set((described || []).map((r) => r.name));
    const where = buildFilterWhere({ partition, filters, cubeDef, tableColumns });
    const wanted = targets ? new Set(targets) : null;
    const mapColumns = [];
    const jsonColumns = [];
    for (const row of described || []) {
      if (wanted && !wanted.has(row.name)) continue;
      const valueType = parseMapValueType(row.type);
      if (valueType) {
        mapColumns.push({ name: row.name, valueType });
      } else if (String(row.type).startsWith("JSON")) {
        jsonColumns.push({ name: row.name });
      }
    }

    const totalRows = Number(
      (await driver.query(buildTotalSql({ table, where })))?.[0]?.total || 0
    );

    // probe all target columns in parallel (SC-002: cold ≤ 2s)
    const mapResults = await Promise.all(
      mapColumns.map(async (column) => ({
        column,
        rows:
          totalRows > 0
            ? await driver.query(
                buildMapProbeSql({ table, column: column.name, where, sampleLimit })
              )
            : [],
      }))
    );
    const jsonResults = await Promise.all(
      jsonColumns.map(async (column) => ({
        column,
        rows:
          totalRows > 0
            ? await driver.query(
                buildJsonProbeSql({ table, column: column.name, where })
              )
            : [],
      }))
    );

    const dimensions = [];
    const measures = [];
    const segments = [];
    for (const { column, rows } of mapResults) {
      const entries = shapeMapEntries({
        cube,
        column: column.name,
        valueType: column.valueType,
        rows,
        totalRows,
        sampleLimit,
      });
      for (const entry of entries) {
        if (entry.memberKind === "measure") measures.push(entry);
        else if (entry.memberKind === "segment") segments.push(entry);
        else dimensions.push(entry);
      }
    }

    const properties = [];
    for (const { column, rows } of jsonResults) {
      properties.push(
        ...shapeJsonEntries({ cube, column: column.name, rows, totalRows })
      );
    }

    const payload = {
      cube,
      scope: { filters },
      freshness: {
        generatedAt: new Date().toISOString(),
        ttlMs,
        cached: false,
      },
      totalRows,
      dynamicMembers: { dimensions, measures, segments, properties },
    };
    cache?.set(cacheInput, payload);
    return res.json(payload);
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      code: err.code || "dynamic_meta_failed",
      message: err.message || String(err),
    });
  }
}
