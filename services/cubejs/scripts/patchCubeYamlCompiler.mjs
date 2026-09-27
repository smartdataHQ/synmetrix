import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SUPPORTED_VERSION = "1.7.30";
const COMPILER_PACKAGE = "@cubejs-backend/schema-compiler";

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

const occurrences = (source, value) => source.split(value).length - 1;

function applyPatch(source, original, patched, label) {
  if (source.includes(patched)) return { source, changed: false };
  if (occurrences(source, original) !== 1) {
    throw new Error(
      `Refusing to patch Cube ${label}: expected source anchor was not found exactly once`,
    );
  }
  return { source: source.replace(original, patched), changed: true };
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

async function patchFile(path, patch) {
  const current = await readFile(path, "utf8");
  const result = patch(current);
  if (result.changed) await writeFile(path, result.source, "utf8");
  return result.changed;
}

export async function patchInstalledCompiler() {
  const packageJsonPath = require.resolve(`${COMPILER_PACKAGE}/package.json`);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Refusing to patch ${COMPILER_PACKAGE} ${packageJson.version}; expected ${SUPPORTED_VERSION}`,
    );
  }

  const root = dirname(packageJsonPath);
  const compilerPath = resolve(root, "dist/src/compiler/YamlCompiler.js");
  const clickHousePath = resolve(root, "dist/src/adapter/ClickHouseQuery.js");
  const yamlChanged = await patchFile(compilerPath, patchCompilerSource);
  const clickHouseChanged = await patchFile(
    clickHousePath,
    patchClickHouseQuerySource,
  );
  return {
    compilerPath,
    clickHousePath,
    changed: yamlChanged || clickHouseChanged,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await patchInstalledCompiler();
  console.log(
    result.changed
      ? `Patched Cube ${SUPPORTED_VERSION} YAML metadata handling + ClickHouse string type`
      : `Cube ${SUPPORTED_VERSION} YAML metadata + ClickHouse string type patches already applied`,
  );
}
