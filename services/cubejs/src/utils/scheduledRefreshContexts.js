import { getDataSources } from "./dataSourceHelpers.js";
import buildSecurityContext from "./buildSecurityContext.js";
import YAML from "yaml";

const UNSAFE_PARTITION_FILTER =
  /\bFILTER_PARAMS\.[A-Za-z_][A-Za-z0-9_]*\.partition\.filter\s*\(/;

export const parseDisabledScheduledRefreshDbTypes = (value) =>
  new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^[a-z][a-z0-9_-]*$/.test(item)),
  );

/**
 * A FILTER_PARAMS partition callback in a cube's base SQL needs an interactive
 * query filter. Cube's scheduled-refresh contexts do not carry one, so the
 * callback itself is rendered into SQL (for example `partition = (column) =>`
 * ...) and every pre-aggregation refresh for that datasource fails.
 *
 * Only inspect the top-level cube SQL. FILTER_PARAMS remains supported in
 * member SQL, and malformed/non-YAML models remain the compiler's concern.
 */
export const hasUnsafeScheduledRefreshPartitionFilter = (schema) => {
  try {
    const document = YAML.parse(String(schema?.code || ""));
    return (document?.cubes || []).some(
      (cube) =>
        typeof cube?.sql === "string" &&
        UNSAFE_PARTITION_FILTER.test(cube.sql),
    );
  } catch {
    return false;
  }
};

const activeSchemas = (dataSource) =>
  dataSource?.branches?.[0]?.versions?.[0]?.dataschemas || [];

/**
 * Build refresh contexts while quarantining only the legacy model pattern
 * proven to generate invalid scheduled-refresh SQL. The warning is aggregate:
 * never log datasource/schema/tenant identifiers or model contents.
 */
export const buildScheduledRefreshContexts = (
  dataSources,
  {
    buildContext = buildSecurityContext,
    disabledDbTypes = new Set(),
    warn = (summary) =>
      console.warn("Scheduled refresh context quarantined", summary),
  } = {},
) => {
  const contexts = [];
  let excludedDataSources = 0;
  let unsafeSchemas = 0;
  let configurationExcludedDataSources = 0;

  for (const dataSource of dataSources || []) {
    const dbType = String(dataSource?.db_type || "").trim().toLowerCase();
    if (disabledDbTypes.has(dbType)) {
      configurationExcludedDataSources += 1;
      continue;
    }

    const affected = activeSchemas(dataSource).filter(
      hasUnsafeScheduledRefreshPartitionFilter,
    ).length;

    if (affected > 0) {
      excludedDataSources += 1;
      unsafeSchemas += affected;
      continue;
    }

    contexts.push({
      securityContext: {
        userScope: {
          dataSource: buildContext(dataSource),
        },
      },
    });
  }

  if (excludedDataSources > 0) {
    warn({
      reason: "unresolved_partition_filter_in_base_sql",
      excludedDataSources,
      unsafeSchemas,
    });
  }

  if (configurationExcludedDataSources > 0) {
    warn({
      reason: "scheduled_refresh_driver_disabled",
      excludedDataSources: configurationExcludedDataSources,
    });
  }

  return contexts;
};

/**
 * Asynchronous function to get the security contexts for all data sources to refresh cache.
 *
 * @returns {Promise<Array>} - A promise that resolves to an array of objects, where each object contains the security context for a data source.
 */
const scheduledRefreshContexts = async () => {
  const dataSources = await getDataSources();
  return buildScheduledRefreshContexts(dataSources, {
    disabledDbTypes: parseDisabledScheduledRefreshDbTypes(
      process.env.CUBEJS_SCHEDULED_REFRESH_DISABLED_DB_TYPES,
    ),
  });
};

export default scheduledRefreshContexts;
