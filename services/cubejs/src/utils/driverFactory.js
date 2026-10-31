import ServerCore from "@cubejs-backend/server-core";
import DriverDependenciesModule from "@cubejs-backend/server-core/dist/src/core/DriverDependencies.js";
import confineDbParams from "./confineDbParams.js";
import defineUserScope from "./defineUserScope.js";

const DriverDependencies = DriverDependenciesModule.default || DriverDependenciesModule;

// Only types Cube knows, so its third-party package lookup by type name never
// runs for a tenant. Each type's tenant-supplied params are confined to what
// cannot reach this pod or other tenants (confineDbParams).
const assertKnownDbType = (dbType) => {
  if (!DriverDependencies[dbType]) {
    throw new Error(`Unsupported database type: "${dbType}"`);
  }
};

const driverError = (err) => {
  console.error("Driver error:", err?.message || err);
  throw new Error(err?.message || err);
};

const resolveDriverSelection = async ({ securityContext, dataSource }) => {
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
  assertKnownDbType(dbType);
  return {
    dbParams: await confineDbParams(dbType, dbParams, {
      dataSourceId: selectedUserScope?.dataSource?.dataSourceId,
    }),
    dbType,
  };
};

/**
 * Cube 1.7 removed CreateOptions.dbType and derives the dialect from the
 * DriverConfig returned by its server-level factory. Keep this factory
 * config-only so Cube can resolve a different datasource type per context.
 */
export const driverConfigFactory = async (context) => {
  try {
    const { dbParams, dbType } = await resolveDriverSelection(context);
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
  try {
    const { dbParams, dbType } = await resolveDriverSelection({
      securityContext,
      dataSource,
    });
    // Cube's own resolver: drivers ship ESM entry points since 1.7.37, where a
    // default import is the module namespace rather than the driver class.
    return ServerCore.createDriver(dbType, dbParams);
  } catch (err) {
    return driverError(err);
  }
};

export default driverFactory;
