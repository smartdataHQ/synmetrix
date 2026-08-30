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

const occurrences = (source, value) => source.split(value).length - 1;

export function patchCompilerSource(source) {
  if (source.includes(PATCHED)) return { source, changed: false };
  if (occurrences(source, ORIGINAL) !== 1) {
    throw new Error(
      "Refusing to patch Cube YAML compiler: expected source anchor was not found exactly once",
    );
  }
  return { source: source.replace(ORIGINAL, PATCHED), changed: true };
}

export async function patchInstalledCompiler() {
  const packageJsonPath = require.resolve(`${COMPILER_PACKAGE}/package.json`);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Refusing to patch ${COMPILER_PACKAGE} ${packageJson.version}; expected ${SUPPORTED_VERSION}`,
    );
  }

  const compilerPath = resolve(
    dirname(packageJsonPath),
    "dist/src/compiler/YamlCompiler.js",
  );
  const current = await readFile(compilerPath, "utf8");
  const result = patchCompilerSource(current);
  if (result.changed) await writeFile(compilerPath, result.source, "utf8");
  return { compilerPath, changed: result.changed };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await patchInstalledCompiler();
  console.log(
    result.changed
      ? `Patched Cube ${SUPPORTED_VERSION} YAML metadata handling`
      : `Cube ${SUPPORTED_VERSION} YAML metadata patch already applied`,
  );
}
