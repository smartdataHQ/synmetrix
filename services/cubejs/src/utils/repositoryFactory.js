import mapSchemaToFile from "./mapSchemaToFile.js";
import { findDataSchemasByIds } from "./dataSourceHelpers.js";
import { LEGACY_ENRICHMENT_CUBES } from "./legacyEnrichmentGuard.js";
import { derivedFilesFor } from "./aggregates/routing.js";
import YAML from "yaml";

const MANAGED_TEMPLATE_NAMES = new Set([
  "ctx_day_context",
  "ctx_weather_context",
]);

const isLegacyEnrichmentCube = (cube) =>
  LEGACY_ENRICHMENT_CUBES.has(cube?.name) ||
  cube?.meta?.managed_by === "ctx-enrichment" ||
  MANAGED_TEMPLATE_NAMES.has(cube?.meta?.template);

export function filterLegacyEnrichmentSchemas(dataSchemas) {
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
        (cube) => !isLegacyEnrichmentCube(cube),
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
      // A request routed to an aggregate table (015) compiles the derived cube
      // held in memory. Without it the canonical files follow, and the query
      // runs on the source.
      const derived = derivedFilesFor(securityContext);
      if (derived) return derived;

      const ids = securityContext?.userScope?.dataSource?.files;
      const dataSchemas = await findDataSchemasByIds({
        ids,
        expectedChecksums: securityContext?.userScope?.dataSource?.fileChecksums,
      });

      return filterLegacyEnrichmentSchemas(dataSchemas).map(mapSchemaToFile);
    },
  };
};

export default repositoryFactory;
