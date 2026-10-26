import JSum from "jsum";

import createMd5Hex from "./md5Hex.js";
import prepareDbParams from "./prepareDbParams.js";

/**
 * Function to build the security context for a given data source.
 *
 * @param {Object} dataSource - The data source object.
 * @param {string} dataSource.id - The ID of the data source.
 * @param {string} dataSource.db_type - The type of the database.
 * @param {Object} dataSource.db_params - The parameters for the database connection.
 * @param {Array} dataSource.dataschemas - The data schemas for the data source.
 * @returns {Object} - The security context for the data source.
 *
 * @throws {Error} - Throws an error if no data source or no dbParams are provided.
 */
const buildSecurityContext = (dataSource, branch, version, teamSettings = {}) => {
  if (!dataSource) {
    throw new Error("No dataSource provided");
  }

  if (!dataSource?.db_params) {
    throw new Error("No dbParams provided");
  }

  const partition = teamSettings.partition || null;
  const internalTables = teamSettings.internal_tables || [];

  const data = {
    dataSourceId: dataSource.id,
    dbType: dataSource.db_type?.toLowerCase(),
    dbParams: dataSource.db_params,
  };

  data.dbParams = prepareDbParams(data.dbParams, data.dbType);

  // Include all team properties in the hash for cache isolation between tenants.
  // Member properties are NOT included — they are applied at query time via queryRewrite,
  // preventing cache over-fragmentation with hundreds of members.
  const teamPropsForHash = Object.keys(teamSettings).length > 0 ? teamSettings : null;
  const hashData = teamPropsForHash ? { ...data, teamProperties: teamPropsForHash } : data;
  const dataSourceVersion = JSum.digest(hashData, "SHA256", "hex");

  const dataModels =
    version?.dataschemas ||
    branch?.versions?.[0]?.dataschemas ||
    dataSource.branches?.[0]?.versions?.[0]?.dataschemas ||
    [];

  const files = dataModels.map((schema) => schema.id);

  const fileRevisions = modelFileRevisions(dataModels);
  const schemaVersion = createMd5Hex(fileRevisions);
  const preAggregationSchema = createMd5Hex(data.dataSourceId);

  return {
    ...data,
    dataSourceVersion,
    preAggregationSchema,
    schemaVersion,
    schemaRevisionComplete: dataModels.every(
      (schema) => Boolean(schema.checksum) || typeof schema.code === "string",
    ),
    files,
    fileChecksums: Object.fromEntries(fileRevisions),
    partition,
    internalTables,
  };
};

export default buildSecurityContext;

// Each model file's id with its content checksum (the md5 of name and code a
// trigger stores on every write), sorted: what a schemaVersion is made of.
function modelFileRevisions(dataModels) {
  return dataModels
    .map((schema) => [
      schema.id,
      schema.checksum ||
        (typeof schema.code === "string"
          ? createMd5Hex(`${schema.name || ""}-${schema.code}`)
          : null),
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
}

/** The schemaVersion of a set of model files, as buildSecurityContext computes it. */
export function schemaVersionOf(dataModels) {
  return createMd5Hex(modelFileRevisions(dataModels || []));
}

export function buildAuthorityRevision(securityContext, rules) {
  const { userId, userScope, tokenPayload } = securityContext || {};
  const source = userScope?.dataSource;
  if (
    !userId ||
    !source?.schemaRevisionComplete ||
    !source.dataSourceId ||
    !source.dataSourceVersion ||
    !source.schemaVersion ||
    !Array.isArray(rules)
  )
    return null;
  return JSum.digest(
    {
      userId,
      accountId: tokenPayload?.accountId || null,
      partition: tokenPayload?.partition || null,
      source: [
        source.dataSourceId,
        source.dataSourceVersion,
        source.schemaVersion,
      ],
      role: userScope.role,
      hasAccessList: userScope.hasAccessList,
      access: userScope.dataSourceAccessList || null,
      team: userScope.teamProperties,
      member: userScope.memberProperties,
      rules: rules
        .slice()
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    },
    "SHA256",
    "hex",
  );
}
