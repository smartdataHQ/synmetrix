/**
 * The per-request hook of aggregate routing.
 *
 * Cube's gateway finishes every query of a request in `getNormalizedQueries`
 * (access policies, queryRewrite, normalization, relative dates resolved) and
 * only then asks for a compiler to generate SQL. The hook wraps that method:
 * once the queries are final it decides whether one aggregate can answer all
 * of them, and if so marks a copy of the request's security context with a
 * variant key. `contextToAppId` appends that key and `repositoryFactory`
 * serves the derived cube for it, so SQL and annotations come from the
 * variant while metadata and every other path stay on the canonical model.
 *
 * Any failure in here leaves the request exactly as it was (FR-029).
 */
import YAML from "yaml";

import { findDataSchemasByIds } from "../dataSourceHelpers.js";
import tenantDriverFactory from "../tenantDriverFactory.js";
import { createCatalog, serverNow } from "./catalog.js";
import { deriveCube, sourceTableOf, variantKey } from "./derive.js";
import { classifyBatch } from "./expressions.js";
import { cubeOfRequest, decide } from "./suitability.js";

const MAX_VARIANTS = 200;
const MAX_SCHEMA_VERSIONS = 50;
const RETRY_AFTER_MS = 60_000;

// Variant key -> derived cube, least recently used first. Never stored anywhere else.
const variants = new Map();

/** Stores a derived cube under its variant key; evicts the least recently used past the bound. */
export function rememberVariant(key, derived) {
  variants.delete(key);
  variants.set(key, derived);
  while (variants.size > MAX_VARIANTS) variants.delete(variants.keys().next().value);
}

export function clearVariants() {
  variants.clear();
}

function recall(key) {
  const found = variants.get(key);
  if (found) rememberVariant(key, found);
  return found;
}

const variantOf = (securityContext) => securityContext?.userScope?.dataSource?.aggregateVariant;

/** What `contextToAppId` appends: a routed request compiles and caches its own model variant. */
export function aggregateAppIdSuffix(context) {
  const key = variantOf(context?.securityContext);
  return key ? `_AGG_${key}` : "";
}

/**
 * The model files of a marked context's variant, or null. Null also when the
 * variant has been evicted: the caller then serves the canonical files and the
 * query runs on the source.
 */
export function derivedFilesFor(securityContext) {
  const key = variantOf(securityContext);
  const files = key ? recall(key)?.files : null;
  return files?.length ? files : null;
}

function unmark(context) {
  if (!context) return;
  const securityContext = context.securityContext;
  const dataSource = securityContext?.userScope?.dataSource;
  if (dataSource && "aggregateVariant" in dataSource) {
    const { aggregateVariant: _marker, ...plain } = dataSource;
    context.securityContext = { ...securityContext, userScope: { ...securityContext.userScope, dataSource: plain } };
  }
  delete context.aggregateRouting;
}

// A copy: the security context object is shared with whoever built it.
function mark(context, decision) {
  const securityContext = context.securityContext;
  context.securityContext = {
    ...securityContext,
    userScope: {
      ...securityContext.userScope,
      dataSource: { ...securityContext.userScope.dataSource, aggregateVariant: decision.variantKey },
    },
  };
  context.aggregateRouting = { aggregate: decision.aggregate, coveredUntil: decision.coveredUntil };
}

/**
 * Does nothing unless AGGREGATE_ROUTING_ENABLED is "true" (FR-027): nothing is
 * wrapped and no data source is probed.
 *
 * @param {object} cubejs the ServerCore instance, after `initApp`
 * @param {object} [deps] replaceable parts, for tests
 * @returns {boolean} whether the hook is in place
 */
export function installAggregateRouting(cubejs, deps = {}) {
  if (!(deps.enabled ?? process.env.AGGREGATE_ROUTING_ENABLED === "true")) return false;
  const {
    driverFor = (securityContext) => tenantDriverFactory(cubejs)({ securityContext }),
    loadSchemas = findDataSchemasByIds,
    log = (line) => console.log(line),
    now = () => performance.now(),
  } = deps;
  const catalog = deps.catalog || createCatalog({ driverFor, now });

  const gateway = cubejs.apiGateway();
  if (typeof gateway?.getNormalizedQueries !== "function") {
    log("aggregate routing not installed: this Cube version has no gateway.getNormalizedQueries");
    return false;
  }

  // The cubes of a tenant's YAML model files, parsed once per schema version.
  const models = new Map();
  const cubesOf = (dataSource) => {
    const version = dataSource.schemaVersion;
    let loading = models.get(version);
    if (loading) models.delete(version);
    else {
      loading = (async () => {
        const cubes = new Map();
        const files = await loadSchemas({ ids: dataSource.files, expectedChecksums: dataSource.fileChecksums });
        for (const file of files || []) {
          if (!/\.ya?ml$/i.test(file?.name || "")) continue;
          try {
            for (const cube of YAML.parse(file.code)?.cubes || []) {
              if (cube && typeof cube.name === "string") cubes.set(cube.name, cube);
            }
          } catch {
            // a file that does not parse defines no cube to derive
          }
        }
        return cubes;
      })();
      loading.catch(() => models.delete(version)); // not remembered: tried again by the next request
    }
    models.set(version, loading);
    while (models.size > MAX_SCHEMA_VERSIONS) models.delete(models.keys().next().value);
    return loading;
  };

  const deriving = new Map();
  const derivedFor = (cube, structure, securityContext) => {
    const dataSource = securityContext.userScope.dataSource;
    const key = variantKey(dataSource.schemaVersion, cube.name, structure);
    const known = recall(key);
    if (known?.failedUntil > now()) throw new Error("derivation failed recently");
    if (known && !known.failedUntil) return known;
    if (deriving.has(key)) return deriving.get(key);

    const work = (async () => {
      let driver;
      const classify = async (expressions, columns) => {
        driver ??= await driverFor(securityContext);
        return classifyBatch((sql) => driver.query(sql), expressions, columns);
      };
      try {
        const derived = await deriveCube(cube, structure, classify, dataSource.schemaVersion, {
          defaultDatabase: dataSource.dbParams?.database,
        });
        rememberVariant(key, derived);
        return derived;
      } catch (error) {
        rememberVariant(key, { failedUntil: now() + RETRY_AFTER_MS });
        throw error;
      } finally {
        deriving.delete(key);
        try {
          await driver?.release?.();
        } catch {
          // nothing more to do with a driver that fails to close
        }
      }
    })();
    deriving.set(key, work);
    return work;
  };

  const route = async (context, queries, stage) => {
    const securityContext = context?.securityContext;
    stage.name = "catalog";
    const entry = catalog.lookup(securityContext);
    const derived = new Map();
    const request = entry ? cubeOfRequest(queries) : {};
    if (request.cube && entry.aggregates.length > 0) {
      const dataSource = securityContext.userScope.dataSource;
      stage.name = "model";
      const cube = (await cubesOf(dataSource)).get(request.cube) || null;
      const source = cube ? sourceTableOf(cube, dataSource.dbParams?.database) : null;
      if (!source) {
        derived.set("", { cube: request.cube, ineligible: cube ? "not_plain_read" : "not_yaml" });
      } else {
        stage.name = "derivation";
        for (const structure of entry.aggregates) {
          if (structure.source === source) derived.set(structure.table, await derivedFor(cube, structure, securityContext));
        }
      }
    }
    stage.name = "decision";
    const decision = decide(queries, derived, entry, () => serverNow(entry, now));
    return { decision, entry };
  };

  const original = gateway.getNormalizedQueries.bind(gateway);
  gateway.getNormalizedQueries = async (inputQuery, context, ...rest) => {
    // Row rules and normalization always run on the canonical model, and a
    // context that is used again must not carry the decision of an earlier call.
    unmark(context);
    const result = await original(inputQuery, context, ...rest);

    let decision = { cube: null, aggregate: null, reason: "error" };
    let rejected = [];
    const stage = { name: "start" };
    try {
      const routed = await route(context, result[1], stage);
      decision = routed.decision;
      rejected = routed.entry?.rejected || [];
      if (decision.aggregate) mark(context, decision);
    } catch (error) {
      unmark(context);
      decision = { cube: null, aggregate: null, reason: "error" };
      // The stage and the kind of error only: a database message can quote model text.
      log(`aggregate routing failed: ${stage.name} (${error?.name || "Error"})`);
    }

    // One line per request (FR-028): names and reason codes, never query values.
    const outcome = decision.aggregate ? `aggregate=${decision.aggregate}` : `reason=${decision.reason}`;
    const ignored =
      decision.reason === "no_aggregate" && rejected.length
        ? `  rejected=${rejected.map((entry) => `${entry.table}:${entry.reason}`).join(",")}`
        : "";
    log(`aggregate routing  requestId=${context?.requestId ?? "-"}  cube=${decision.cube ?? "-"}  ${outcome}${ignored}`);
    return result;
  };
  return true;
}
