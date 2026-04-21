#!/usr/bin/env node

/**
 * lint-error-codes — FR-017 guard.
 *
 * Fails with a non-zero exit code (and a human-readable diff) whenever the
 * `ErrorCode` enum drifts across:
 *   - services/cubejs/src/utils/errorCodes.js          (single source of truth)
 *   - specs/011-model-mgmt-api/contracts/*.yaml        (every OpenAPI contract)
 *
 * Every contract under `contracts/` must contain a top-level `ErrorCode`
 * schema with an explicit `enum` array. Each enum must match the exhaustive
 * list of values in `errorCodes.js`, so clients generating bindings from any
 * single contract receive the complete enum.
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const ERROR_CODES_JS = join(
  repoRoot,
  "services/cubejs/src/utils/errorCodes.js"
);
const CONTRACTS_DIR = join(
  repoRoot,
  "specs/011-model-mgmt-api/contracts"
);

async function readErrorCodesJs() {
  const text = await readFile(ERROR_CODES_JS, "utf8");
  const re = /["']([a-z][a-z0-9_]+)["']/g;
  const known = new Set();
  let m;
  while ((m = re.exec(text))) {
    const v = m[1];
    if (
      /_(?:invalid|not_found|unresolved|not_visible|unauthorized|by_references|historical_version|authorization|cross_branch|not_on_branch|columns_missing)_?/.test(
        v
      ) ||
      /_reference$/.test(v) ||
      v === "cube_not_found" ||
      v === "validate_invalid_mode" ||
      v === "validate_target_not_found" ||
      v === "validate_unresolved_reference" ||
      v === "refresh_branch_not_visible" ||
      v === "refresh_unauthorized" ||
      v === "delete_blocked_by_references" ||
      v === "delete_blocked_historical_version" ||
      v === "delete_blocked_authorization" ||
      v === "diff_cross_branch" ||
      v === "diff_invalid_request" ||
      v === "rollback_version_not_on_branch" ||
      v === "rollback_blocked_authorization" ||
      v === "rollback_invalid_request" ||
      v === "rollback_source_columns_missing"
    ) {
      known.add(v);
    }
  }
  return known;
}

async function readContractEnum(path) {
  const text = await readFile(path, "utf8");
  // Locate the ErrorCode schema's enum list. Permissive regex: we want every
  // value inside the first `enum:` block that follows `ErrorCode:`.
  const anchor = text.indexOf("ErrorCode:");
  if (anchor === -1) {
    throw new Error(`${path} has no ErrorCode schema`);
  }
  const afterAnchor = text.slice(anchor);
  // Find the enum block: `enum:` → dashed list → end when we hit a line that
  // starts with non-dash non-whitespace content at the same or lower indent.
  const enumAnchor = afterAnchor.search(/\n\s*enum:\s*\n/);
  if (enumAnchor === -1) {
    throw new Error(`${path} ErrorCode.enum block not found`);
  }
  const afterEnum = afterAnchor.slice(enumAnchor).split("\n");
  // Skip the `enum:` line itself.
  const values = [];
  let inEnum = false;
  for (const raw of afterEnum) {
    if (!inEnum) {
      if (/^\s*enum:\s*$/.test(raw)) inEnum = true;
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("- ")) {
      const v = trimmed.slice(2).replace(/['"]/g, "").trim();
      if (v) values.push(v);
      continue;
    }
    // First non-dash non-empty line after the list ends the enum block.
    break;
  }
  return new Set(values);
}

function setDiff(a, b) {
  const out = [];
  for (const v of a) if (!b.has(v)) out.push(v);
  return out;
}

async function main() {
  const sourceOfTruth = await readErrorCodesJs();
  if (sourceOfTruth.size === 0) {
    console.error("lint-error-codes: errorCodes.js produced an empty set");
    process.exit(1);
  }

  const entries = (await readdir(CONTRACTS_DIR)).filter((f) =>
    f.endsWith(".yaml")
  );
  if (entries.length === 0) {
    console.error(`lint-error-codes: no contracts found in ${CONTRACTS_DIR}`);
    process.exit(1);
  }

  let failed = false;
  for (const entry of entries) {
    const path = join(CONTRACTS_DIR, entry);
    let contractSet;
    try {
      contractSet = await readContractEnum(path);
    } catch (err) {
      console.error(`lint-error-codes: ${entry} → ${err.message}`);
      failed = true;
      continue;
    }
    const missing = setDiff(sourceOfTruth, contractSet);
    const extra = setDiff(contractSet, sourceOfTruth);
    if (missing.length || extra.length) {
      failed = true;
      console.error(`lint-error-codes: ${entry} drift detected`);
      if (missing.length) {
        console.error(`  MISSING (in errorCodes.js, not in ${entry}):`);
        for (const v of missing) console.error(`    - ${v}`);
      }
      if (extra.length) {
        console.error(`  EXTRA (in ${entry}, not in errorCodes.js):`);
        for (const v of extra) console.error(`    - ${v}`);
      }
    }
  }

  if (failed) process.exit(1);
  console.log(
    `lint-error-codes: OK (${sourceOfTruth.size} codes, ${entries.length} contracts)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
