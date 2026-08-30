import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import {
  buildPublication,
  generateJoinStubs,
  validateCompatibilityMatrix,
} from "../publish.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function cube(name) {
  const document = YAML.parse(await readFile(path.join(ROOT, name), "utf8"));
  assert.equal(document.cubes.length, 1);
  return document.cubes[0];
}

describe("Spec 102 enrichment templates", () => {
  it("carry managed provenance, exact billing items, and public-view-only sources", async () => {
    const day = await cube("ctx_day_context.yml");
    const weather = await cube("ctx_weather_context.yml");
    assert.deepEqual(day.meta.billing_items, ["ctx:day-archetype"]);
    assert.deepEqual(weather.meta.billing_items, ["ctx:weather-archetype"]);
    for (const model of [day, weather]) {
      assert.equal(model.meta.default_model, true);
      assert.equal(model.meta.managed_by, "ctx-enrichment");
      assert.equal(model.public, true);
      assert.doesNotMatch(
        JSON.stringify(model),
        /release_(manifest|pointer)|enrich\.(day|weather)_context(?!_v)/,
      );
      assert.equal(model.measures, undefined);
    }
    assert.equal(day.sql_table, "enrich.day_context_v");
    assert.match(weather.sql, /enrich\.weather_context_v/);
    assert.doesNotMatch(weather.sql, /country_code\s*=\s*'IS'/);
    assert.equal(weather.meta.weather_country, undefined);
    assert.match(
      weather.dimensions.find((d) => d.name === "contextKey").sql,
      /country_code/,
    );
  });

  it("keeps categorical markers as strings", async () => {
    const day = await cube("ctx_day_context.yml");
    const weather = await cube("ctx_weather_context.yml");
    assert.equal(
      day.dimensions.find((d) => d.name === "archetypeMarker").type,
      "string",
    );
    assert.equal(
      weather.dimensions.find((d) => d.name === "weatherMarker").type,
      "string",
    );
  });

  it("generates only matrix-approved, country-correlated many-to-one joins", () => {
    const matrix = validateCompatibilityMatrix({
      schema_version: 1,
      status: "approved",
      entries: [
        {
          fact_model: "SemanticEvents",
          products: ["day", "weather"],
          event_time_expr: "{CUBE}.timestamp",
          timezone_source: "{CUBE}.context_timezone",
          timezone_valid_expr: "{CUBE}.timezone_is_valid = 1",
          local_date_expr: "toDate({CUBE}.local_time)",
          location_rule: "context_point",
          country_source: "{CUBE}.country_code",
          country_location_proof: "evidence/gate-1/profile.json",
          geohash_expr: "{CUBE}.geohash6",
          cardinality: "many_to_one",
          verification_owner: "analytics-platform",
        },
      ],
    });
    const [stub] = generateJoinStubs(matrix);
    assert.equal(stub.fact_model, "SemanticEvents");
    assert.equal(stub.joins.length, 2);
    assert.ok(stub.joins.every((join) => join.relationship === "many_to_one"));
    assert.doesNotMatch(stub.joins[0].sql, /= 'IS'/);
    assert.doesNotMatch(stub.joins[1].sql, /= 'IS'/);
    assert.ok(stub.joins.every((join) => join.sql.includes("countryCode")));
    assert.ok(
      stub.joins.every((join) =>
        join.sql.startsWith("({CUBE}.timezone_is_valid = 1) AND"),
      ),
    );
    assert.ok(
      stub.joins.every((join) =>
        join.sql.includes("(toDate({CUBE}.local_time))"),
      ),
    );
    assert.ok(stub.joins.every((join) => !join.sql.includes("toTimeZone")));
  });

  it("rejects an entry without an explicit timezone guard and local-date expression", () => {
    assert.throws(
      () =>
        validateCompatibilityMatrix({
          schema_version: 1,
          status: "approved",
          entries: [
            {
              fact_model: "SemanticEvents",
              products: ["day"],
              event_time_expr: "{CUBE}.timestamp",
              timezone_source: "{CUBE}.context_timezone",
              location_rule: "unique_only",
              country_source: "{CUBE}.country_code",
              country_location_proof: "evidence/gate-1/profile.json",
              geohash_expr: "{CUBE}.geohash6",
              cardinality: "many_to_one",
              verification_owner: "analytics-platform",
            },
          ],
        }),
      /timezone_valid_expr/,
    );
  });

  it("publishes no join stubs while Gate 1 remains empty and is checksum-idempotent", async () => {
    const first = await buildPublication();
    const second = await buildPublication();
    assert.equal(first.matrixStatus, "gate_1_open");
    assert.deepEqual(first.joinStubs, []);
    assert.equal(first.checksum, second.checksum);
    assert.deepEqual(first.files, second.files);
  });
});
