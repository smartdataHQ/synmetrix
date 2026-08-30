import mapSchemaToFile from "./mapSchemaToFile.js";
import { findDataSchemasByIds } from "./dataSourceHelpers.js";
import {
  validateEnrichmentLease,
  ENRICHMENT_CUBES,
} from "./enrichmentEntitlement.js";
import YAML from "yaml";

const MANAGED_TEMPLATE_NAMES = new Set([
  "ctx_day_context",
  "ctx_weather_context",
]);

const isManagedEnrichmentCube = (cube) =>
  ENRICHMENT_CUBES.has(cube?.name) ||
  cube?.meta?.managed_by === "ctx-enrichment" ||
  MANAGED_TEMPLATE_NAMES.has(cube?.meta?.template);

export function filterUnentitledEnrichmentSchemas(
  dataSchemas,
  securityContext,
  options,
) {
  if (validateEnrichmentLease(securityContext, options).valid)
    return dataSchemas;

  const filtered = [];
  for (const schema of dataSchemas || []) {
    const managedFile = MANAGED_TEMPLATE_NAMES.has(
      String(schema?.name || "").replace(/\.(yml|yaml)$/i, ""),
    );
    if (!/\.ya?ml$/i.test(schema?.name || "")) {
      if (!managedFile) filtered.push(schema);
      continue;
    }
    try {
      const document = YAML.parse(schema.code);
      if (!Array.isArray(document?.cubes)) {
        if (!managedFile) filtered.push(schema);
        continue;
      }
      const cubes = document.cubes.filter(
        (cube) => !isManagedEnrichmentCube(cube),
      );
      if (cubes.length === 0) continue;
      if (cubes.length === document.cubes.length) {
        filtered.push(schema);
      } else {
        filtered.push({
          ...schema,
          code: YAML.stringify({ ...document, cubes }),
        });
      }
    } catch {
      // A reserved managed file that cannot be inspected is omitted. Other
      // customer-authored files retain their existing compiler behaviour.
      if (!managedFile) filtered.push(schema);
    }
  }
  return filtered;
}

/**
 * Generates documentation for the repository factory.
 * @param {Object} options - The options for the repository factory.
 * @param {Object} options.securityContext - The security context.
 * @returns {Object} - The repository factory object.
 */
const repositoryFactory = ({ securityContext }) => {
  return {
    /**
     * Retrieves the data schema files.
     * @returns {Array} - The data schema files.
     */
    dataSchemaFiles: async () => {
      const ids = securityContext?.userScope?.dataSource?.files;
      const dataSchemas = await findDataSchemasByIds({ ids });

      return filterUnentitledEnrichmentSchemas(
        dataSchemas,
        securityContext,
      ).map(mapSchemaToFile);
    },
  };
};

export default repositoryFactory;
