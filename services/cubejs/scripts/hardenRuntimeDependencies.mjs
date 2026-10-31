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

console.log(
  `Runtime dependency hardening verified (${thriftPackages.length} Thrift resolution(s))`,
);
