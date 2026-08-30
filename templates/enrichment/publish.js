import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_CUBES = {
  day: "CtxDayContext",
  weather: "CtxWeatherContext",
};

function requiredString(entry, key) {
  if (typeof entry?.[key] !== "string" || !entry[key].trim()) {
    throw new Error(`compatibility entry requires ${key}`);
  }
  return entry[key].trim();
}

export function validateCompatibilityMatrix(matrix) {
  if (matrix?.schema_version !== 1 || !Array.isArray(matrix?.entries)) {
    throw new Error(
      "compatibility matrix must be schema_version 1 with entries[]",
    );
  }
  for (const entry of matrix.entries) {
    for (const key of [
      "fact_model",
      "event_time_expr",
      "timezone_source",
      "timezone_valid_expr",
      "local_date_expr",
      "location_rule",
      "country_source",
      "country_location_proof",
      "geohash_expr",
      "verification_owner",
    ])
      requiredString(entry, key);
    if (entry.cardinality !== "many_to_one") {
      throw new Error("compatibility entry cardinality must be many_to_one");
    }
    if (
      !Array.isArray(entry.products) ||
      entry.products.length === 0 ||
      entry.products.some((product) => !PRODUCT_CUBES[product])
    ) {
      throw new Error(
        "compatibility entry products must contain day and/or weather",
      );
    }
  }
  return matrix;
}

const joinSql = (entry, product) => {
  const cube = PRODUCT_CUBES[product];
  // ClickHouse 26.7 requires a constant time-zone argument to toTimeZone().
  // The compatibility gate therefore supplies a separately proven local-date
  // expression and an explicit IANA-zone validity predicate. Invalid or
  // missing timezone rows fail the join instead of falling back to UTC.
  return `(${entry.timezone_valid_expr}) AND (${entry.geohash_expr}) = {${cube}}.requestGeohash6 AND (${entry.country_source}) = {${cube}}.countryCode AND (${entry.local_date_expr}) = {${cube}}.localDate`;
};

export function generateJoinStubs(matrix) {
  validateCompatibilityMatrix(matrix);
  return matrix.entries.map((entry) => ({
    fact_model: entry.fact_model,
    verification_owner: entry.verification_owner,
    joins: entry.products.map((product) => ({
      name: PRODUCT_CUBES[product],
      relationship: "many_to_one",
      sql: joinSql(entry, product),
    })),
  }));
}

export async function buildPublication() {
  const names = ["ctx_day_context.yml", "ctx_weather_context.yml"];
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      code: await readFile(path.join(ROOT, name), "utf8"),
    })),
  );
  const matrixCode = await readFile(
    path.join(ROOT, "compatibility-matrix.yaml"),
    "utf8",
  );
  const matrix = validateCompatibilityMatrix(YAML.parse(matrixCode));
  const joinStubs = generateJoinStubs(matrix);
  const joinsCode = YAML.stringify({
    schema_version: 1,
    generated_from: "compatibility-matrix.yaml",
    join_stubs: joinStubs,
  });
  files.push({ name: "enrichment_joins.yaml", code: joinsCode });
  const checksum = createHash("sha256")
    .update(
      files
        .map((file) => `${file.name}\0${file.code}`)
        .sort()
        .join("\0"),
    )
    .digest("hex");
  return { checksum, files, matrixStatus: matrix.status, joinStubs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const publication = await buildPublication();
  // Publication to the configured Global Templates branch is intentionally
  // refused while Gate 1 has no approved entries. This check mode still gives
  // CI a deterministic artifact/checksum and makes accidental empty rollout
  // impossible.
  process.stdout.write(`${JSON.stringify(publication, null, 2)}\n`);
  if (publication.matrixStatus !== "approved") {
    process.stderr.write(
      "Gate 1 is not approved; no remote publication was attempted.\n",
    );
  }
}
