import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = path.join(root, "node_modules");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function findPackages(directory, packageName, found = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const child = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      await findPackages(child, packageName, found);
      continue;
    }
    if (entry.name === packageName) {
      const manifest = path.join(child, "package.json");
      try {
        const parsed = await readJson(manifest);
        if (parsed.name === packageName) found.push({ directory: child, parsed });
      } catch {
        // A non-package directory with the same basename is irrelevant.
      }
    }
    if (entry.name !== packageName) {
      const nested = path.join(child, "node_modules");
      try {
        if ((await fs.stat(nested)).isDirectory()) {
          await findPackages(nested, packageName, found);
        }
      } catch {
        // Most packages do not own a nested node_modules directory.
      }
    }
  }
  return found;
}

const thriftPackages = await findPackages(nodeModules, "thrift");
if (!thriftPackages.length || thriftPackages.some(({ parsed }) => parsed.version !== "0.23.0")) {
  throw new Error("Every installed Apache Thrift package must resolve to 0.23.0");
}

const extractDirectory = path.join(nodeModules, "extract-zip");
const extractManifest = path.join(extractDirectory, "package.json");
const currentExtract = await readJson(extractManifest);

if (currentExtract.version !== "0.0.0-disabled") {
  if (currentExtract.name !== "extract-zip" || currentExtract.version !== "2.0.1") {
    throw new Error("Refusing to replace an unreviewed extract-zip package");
  }
  await fs.rm(extractDirectory, { recursive: true, force: false });
  await fs.mkdir(extractDirectory, { recursive: false });
  await fs.writeFile(
    extractManifest,
    `${JSON.stringify({
      name: "extract-zip",
      version: "0.0.0-disabled",
      private: true,
      main: "index.js",
      description: "Fail-closed runtime shim; archive extraction is install-time only",
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(extractDirectory, "index.js"),
    `"use strict";\n` +
      `const disabled = () => {\n` +
      `  const error = new Error("Archive extraction is disabled in the production runtime");\n` +
      `  error.code = "CUBE_RUNTIME_ARCHIVE_EXTRACTION_DISABLED";\n` +
      `  throw error;\n` +
      `};\n` +
      `module.exports = disabled;\n` +
      `module.exports.default = disabled;\n`,
  );
}

console.log(
  `Runtime dependency hardening verified (${thriftPackages.length} Thrift resolution(s), archive extraction disabled)`,
);
