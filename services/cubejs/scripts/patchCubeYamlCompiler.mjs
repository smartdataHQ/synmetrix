import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SUPPORTED_VERSION = "1.7.30";
const COMPILER_PACKAGE = "@cubejs-backend/schema-compiler";
const BIGQUERY_PACKAGE = "@cubejs-backend/bigquery-driver";
const ORCHESTRATOR_PACKAGE = "@cubejs-backend/query-orchestrator";

const ORIGINAL = `        else if (typeof obj === 'string') {
            let code = obj;
            if (!CubeValidator_1.nonStringFields.has(propertyPath[propertyPath.length - 1])) {`;

const PATCHED = `        else if (typeof obj === 'string') {
            // Cube metadata is an arbitrary literal payload exposed to API consumers.
            // Treating it as Python f-string source makes JSON-valued metadata look
            // like an interpolation expression and rejects otherwise valid models.
            // Jinja rendering has already happened before this transformation.
            if (propertyPath.includes('meta')) {
                return t.stringLiteral(obj);
            }
            let code = obj;
            if (!CubeValidator_1.nonStringFields.has(propertyPath[propertyPath.length - 1])) {`;

const CLICKHOUSE_ORIGINAL = `        templates.types.timestamp = 'DATETIME';
        delete templates.types.time;`;

const CLICKHOUSE_PATCHED = `        templates.types.timestamp = 'DATETIME';
        // ClickHouse type names are case-sensitive. The base 'STRING' type is
        // what Tesseract CASTs multi-column primary keys to for count measures
        // without sql, and ClickHouse rejects it ("Unknown data type
        // family: STRING").
        templates.types.string = 'String';
        delete templates.types.time;`;

const BIGQUERY_ORIGINAL = `        const rowStream = new HydrationStream_1.HydrationStream();
        stream.pipe(rowStream);`;

const BIGQUERY_PATCHED = `        const rowStream = new HydrationStream_1.HydrationStream();
        // pipe() drops source errors; an unhandled one ("Not found: Table")
        // is an uncaughtException that kills the refresh worker for every
        // tenant. Forwarded, it fails only this pre-aggregation build.
        stream.on('error', (err) => rowStream.destroy(err));
        stream.pipe(rowStream);`;

// Both stream-download paths wrap the driver's row stream the same way.
const LOADER_ORIGINAL = `                tableData.rowStream.pipe(stream);
                tableData.rowStream = stream;`;

const LOADER_PATCHED = `                // pipe() drops source errors; forwarded, they reach the upload pipeline
                tableData.rowStream.on('error', (err) => stream.destroy(err));
                tableData.rowStream.pipe(stream);
                tableData.rowStream = stream;`;

const occurrences = (source, value) => source.split(value).length - 1;

function applyPatch(source, original, patched, label, expected = 1) {
  if (source.includes(patched)) return { source, changed: false };
  if (occurrences(source, original) !== expected) {
    throw new Error(
      `Refusing to patch Cube ${label}: expected source anchor was not found exactly ${expected === 1 ? "once" : `${expected} times`}`,
    );
  }
  return { source: source.replaceAll(original, patched), changed: true };
}

export function patchCompilerSource(source) {
  return applyPatch(source, ORIGINAL, PATCHED, "YAML compiler");
}

export function patchClickHouseQuerySource(source) {
  return applyPatch(
    source,
    CLICKHOUSE_ORIGINAL,
    CLICKHOUSE_PATCHED,
    "ClickHouse query adapter",
  );
}

export function patchBigQueryDriverSource(source) {
  return applyPatch(source, BIGQUERY_ORIGINAL, BIGQUERY_PATCHED, "BigQuery driver");
}

export function patchPreAggregationLoaderSource(source) {
  return applyPatch(source, LOADER_ORIGINAL, LOADER_PATCHED, "pre-aggregation loader", 2);
}

async function supportedPackageRoot(name) {
  const packageJsonPath = require.resolve(`${name}/package.json`);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Refusing to patch ${name} ${packageJson.version}; expected ${SUPPORTED_VERSION}`,
    );
  }
  return dirname(packageJsonPath);
}

async function patchFile(path, patch) {
  const current = await readFile(path, "utf8");
  const result = patch(current);
  if (result.changed) await writeFile(path, result.source, "utf8");
  return result.changed;
}

export async function patchInstalledCompiler() {
  const root = await supportedPackageRoot(COMPILER_PACKAGE);
  const compilerPath = resolve(root, "dist/src/compiler/YamlCompiler.js");
  const clickHousePath = resolve(root, "dist/src/adapter/ClickHouseQuery.js");
  const yamlChanged = await patchFile(compilerPath, patchCompilerSource);
  const clickHouseChanged = await patchFile(
    clickHousePath,
    patchClickHouseQuerySource,
  );
  const bigQueryPath = resolve(
    await supportedPackageRoot(BIGQUERY_PACKAGE),
    "dist/src/BigQueryDriver.js",
  );
  const bigQueryChanged = await patchFile(bigQueryPath, patchBigQueryDriverSource);
  const loaderPath = resolve(
    await supportedPackageRoot(ORCHESTRATOR_PACKAGE),
    "dist/src/orchestrator/PreAggregationLoader.js",
  );
  const loaderChanged = await patchFile(loaderPath, patchPreAggregationLoaderSource);
  return {
    compilerPath,
    clickHousePath,
    bigQueryPath,
    loaderPath,
    changed: yamlChanged || clickHouseChanged || bigQueryChanged || loaderChanged,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await patchInstalledCompiler();
  console.log(
    result.changed
      ? `Patched Cube ${SUPPORTED_VERSION} YAML metadata handling + ClickHouse string type + stream error forwarding`
      : `Cube ${SUPPORTED_VERSION} YAML metadata + ClickHouse string type + stream error forwarding patches already applied`,
  );
}
