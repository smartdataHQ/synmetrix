import { prepareCompiler } from "@cubejs-backend/schema-compiler";

const activeSchemas = (dataSource) =>
  dataSource?.branches?.[0]?.versions?.[0]?.dataschemas || [];

const schemaFile = (schema) => ({
  fileName: schema.name,
  readOnly: true,
  content: schema.code,
});

export async function compileSchemaFiles(files) {
  const repository = { dataSchemaFiles: async () => files };
  const { compiler } = prepareCompiler(repository, {
    allowNodeRequire: true,
    standalone: true,
  });
  await compiler.compile();
}

/**
 * Compile every active datasource model set without returning identifiers,
 * filenames, source text, or compiler messages. This is intended for an
 * in-cluster release gate where tenant schemas must never be exported in
 * diagnostics.
 */
export async function checkLiveSchemaCompatibility(
  dataSources,
  { compile = compileSchemaFiles } = {},
) {
  const summary = {
    compatible: true,
    contexts: 0,
    files: 0,
    yamlFiles: 0,
    javascriptFiles: 0,
    compiledContexts: 0,
    failedContexts: 0,
  };

  for (const dataSource of dataSources || []) {
    const schemas = activeSchemas(dataSource);
    summary.contexts += 1;
    summary.files += schemas.length;
    summary.yamlFiles += schemas.filter((schema) =>
      /\.ya?ml$/i.test(schema?.name || ""),
    ).length;
    summary.javascriptFiles += schemas.filter((schema) =>
      /\.js$/i.test(schema?.name || ""),
    ).length;

    try {
      await compile(schemas.map(schemaFile));
      summary.compiledContexts += 1;
    } catch {
      summary.compatible = false;
      summary.failedContexts += 1;
    }
  }

  return summary;
}
