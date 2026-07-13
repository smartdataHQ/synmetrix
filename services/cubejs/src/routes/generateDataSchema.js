import { ScaffoldingTemplate } from "@cubejs-backend/schema-compiler";
import yaml from "js-yaml";
import {
  createDataSchema,
  findDataSchemas,
} from "../utils/dataSourceHelpers.js";
import createMd5Hex from "../utils/md5Hex.js";
import { NO_SCHEMA_KEY } from "./getSchema.js";
const camelize = (value) =>
  value.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

const ensureYamlPrimaryKeys = (files, schema) => {
  const columnsByTable = {};
  Object.values(schema || {}).forEach((tables) => {
    Object.entries(tables || {}).forEach(([tableName, columns]) => {
      columnsByTable[tableName] = (columns || []).map((c) => c.name);
    });
  });

  files.forEach((file) => {
    let doc;
    try {
      doc = yaml.load(file.content);
    } catch {
      return;
    }
    let changed = false;
    (doc?.cubes || []).forEach((cube) => {
      if (!cube?.joins?.length) return;
      const dimensions = cube.dimensions || [];
      if (dimensions.some((d) => d.primary_key || d.primaryKey)) return;

      const tableMatch = /from\s+(?:[\w"]+\.)?"?(\w+)"?/i.exec(cube.sql || "");
      const tableName = tableMatch?.[1];
      const columns = (tableName && columnsByTable[tableName]) || [];
      const pkColumn =
        columns.find((c) => c === "id") ||
        columns.find((c) => c === `${tableName}_id`) ||
        columns.find((c) => /_id$/.test(c) && cube.joins.every((j) => !(j.sql || "").includes(`{CUBE}.${c}`)));
      if (!pkColumn) return;

      dimensions.unshift({
        name: camelize(pkColumn),
        sql: pkColumn,
        type: "number",
        primary_key: true,
        public: false,
      });
      cube.dimensions = dimensions;
      changed = true;
    });
    if (changed) {
      file.content = yaml.dump(doc, { lineWidth: 120 });
    }
  });
};

const filterFiles = (mainFiles, addFiles) => {
  const fileNames = mainFiles.map((f) => f.fileName);
  return [
    ...mainFiles,
    ...addFiles.filter((f) => !fileNames.includes(f.fileName)),
  ];
};

const normalizeTables = (schema, tables) => {
  const normalizedSchema = { ...schema };

  if (normalizedSchema?.[NO_SCHEMA_KEY]) {
    normalizedSchema[""] = normalizedSchema[NO_SCHEMA_KEY];
    delete normalizedSchema[NO_SCHEMA_KEY];
  }

  let normalizedTables = tables.map((table) => [
    table?.schema !== NO_SCHEMA_KEY ? table?.schema.replace("/", ".") : "",
    table?.name,
  ]);

  return {
    tables: normalizedTables,
    schema: normalizedSchema,
  };
};

export default async (req, res, cubejs) => {
  const { securityContext } = req;
  const { userScope, userId, authToken } = securityContext;
  const { dataSourceId } = userScope.dataSource;

  let driver;

  try {
    driver = await cubejs.options.driverFactory({ securityContext });
    let schema = await driver.tablesSchema();
    const {
      tables = [],
      overwrite = false,
      branchId,
      format = "yaml",
    } = req.body || {};

    const { tables: normalizedTables, schema: normalizedSchema } =
      normalizeTables(schema, tables);

    const scaffoldingTemplate = new ScaffoldingTemplate(
      normalizedSchema,
      driver,
      {
        format,
      }
    );

    const newFiles =
      scaffoldingTemplate.generateFilesByTableNames(normalizedTables);

    // ScaffoldingTemplate emits joins for FK-pattern columns but only marks a
    // primary key for columns literally named "id" — schemas using
    // `<table>_id` keys (e.g. Pagila) then scaffold cubes with joins and no
    // primary_key, and the WHOLE branch fails to compile ("primary key for X
    // is required when join is defined"). Post-process YAML scaffolds: when a
    // cube has joins and no primary-key dimension, promote the id-pattern
    // column to a hidden primary-key dimension.
    if (format === "yaml") {
      ensureYamlPrimaryKeys(newFiles, normalizedSchema);
    }

    if (!newFiles.length) {
      return res.status(400).json({
        code: "generate_schema_no_new_files",
        message: "No new files created",
      });
    }

    // Use admin secret (no authToken) for internal Hasura calls — the caller
    // may be authenticated with an externally-issued JWT (e.g. WorkOS) that
    // Hasura cannot verify; checkAuth + defineUserScope already authorized the
    // request. Mirrors the smartGenerate precedent.
    const dataSchemas = await findDataSchemas({
      dataSourceId,
      branchId,
    });

    const existedFiles = dataSchemas.map((row) => ({
      fileName: row.name,
      content: row.code,
    }));

    let files;
    if (overwrite) {
      files = filterFiles(newFiles, existedFiles);
    } else {
      files = filterFiles(existedFiles, newFiles);
    }

    let commitChecksum = files.reduce((acc, cur) => acc + cur.code, "");
    commitChecksum = createMd5Hex(commitChecksum);

    const preparedSchemas = files.map((file) => ({
      name: file.fileName,
      code: file.content,
      user_id: userId,
      datasource_id: dataSourceId,
    }));

    const commitObject = {
      user_id: userId,
      branch_id: branchId,
      checksum: commitChecksum,
      dataschemas: {
        data: [...preparedSchemas],
      },
    };

    await createDataSchema(commitObject);

    if (cubejs.compilerCache) {
      cubejs.compilerCache.purgeStale();
    }

    res.json({ code: "ok", message: "Generation finished" });
  } catch (err) {
    console.error(err);

    if (driver.release) {
      await driver.release();
    }

    res.status(500).json({
      code: "generate_schema_error",
      message: err.message || err,
    });
  }
};
