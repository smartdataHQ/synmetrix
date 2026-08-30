import DriverDependenciesModule from "@cubejs-backend/server-core/dist/src/core/DriverDependencies.js";
import VerticaDriver from '@cubejs-backend/vertica-driver';
import defineUserScope from "./defineUserScope.js";

const DriverDependencies = DriverDependenciesModule.default || DriverDependenciesModule;

const driverError = (err) => {
  console.error("Driver error:", err?.message || err);
  throw new Error(err?.message || err);
};

const resolveDriverSelection = ({ securityContext, dataSource }) => {
  const { userScope, user } = securityContext || {};
  let selectedUserScope = userScope;

  if (dataSource && dataSource !== "default") {
    selectedUserScope = defineUserScope(
      user?.dataSources,
      user?.members,
      dataSource,
    );
  }

  const dbParams = selectedUserScope?.dataSource?.dbParams;
  const dbType = selectedUserScope?.dataSource?.dbType;
  if (!dbType || !dbParams || typeof dbParams !== "object") {
    throw new Error("database type and parameters are required");
  }
  return { dbParams, dbType };
};

/**
 * Cube 1.7 removed CreateOptions.dbType and derives the dialect from the
 * DriverConfig returned by its server-level factory. Keep this factory
 * config-only so Cube can resolve a different datasource type per context.
 */
export const driverConfigFactory = async (context) => {
  try {
    const { dbParams, dbType } = resolveDriverSelection(context);
    if (dbType !== "vertica" && !DriverDependencies[dbType]) {
      throw new Error(
        `Unknown database type: "${dbType}" (available: ${Object.keys(DriverDependencies).join(", ")})`,
      );
    }
    return { ...dbParams, type: dbType };
  } catch (err) {
    return driverError(err);
  }
};

/**
 * Factory function that creates a driver instance based on the provided security context and data source.
 * @param {Object} options - The options object.
 * @param {Object} options.securityContext - The security context object.
 * @param {Object} options.dataSource - The data source object.
 * @returns {Promise<Object>} A promise that resolves to the driver instance.
 */
const driverFactory = async ({ securityContext, dataSource }) => {
  const { dbParams, dbType } = resolveDriverSelection({
    securityContext,
    dataSource,
  });

  let driverModule;

  try {
    if (dbType === "vertica") {
      return new VerticaDriver(dbParams);
    }

    const dbDriver = DriverDependencies[dbType];
    if (!dbDriver) {
      throw new Error(`Unknown database type: "${dbType}" (available: ${Object.keys(DriverDependencies).join(', ')})`);
    }
    driverModule = await import(dbDriver);

    if (dbType === "druid") {
      driverModule = driverModule.default;
    }

    if (dbType === "databricks-jdbc") {
      return new driverModule.DatabricksDriver(dbParams);
    }
  } catch (err) {
    return driverError(err);
  }

  const driverClass = new driverModule.default(dbParams);
  return driverClass;
};

export default driverFactory;
