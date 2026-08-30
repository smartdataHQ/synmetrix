import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import { escapeCSVField } from "../utils/csvSerializer.js";
import {
  queryUsesEnrichment,
  sqlEnrichmentBillingItems,
} from "../utils/enrichmentEntitlement.js";
import { deterministicBillingMessageId } from "../utils/enrichmentMetering.js";
import { validateFormat } from "../utils/formatValidator.js";

const require = createRequire(import.meta.url);
const runtimeVersion = require("@cubejs-backend/server-core/package.json").version;

// T060 runs the complete test tree twice, once with each dependency set. This
// manifest makes the required comparison surfaces explicit and prevents a
// future refactor from silently dropping a lane from that corpus.
const CORPUS = {
  models: [
    "../utils/smart-generation/__tests__/cubeBuilder.test.js",
    "../routes/__tests__/reconcileTeam.test.js",
  ],
  guards: ["../routes/__tests__/enrichmentGuards.test.js"],
  formats: [
    "../utils/formatValidator.js",
    "../utils/csvSerializer.js",
    "../utils/arrowSerializer.js",
  ],
  sql_api: ["../routes/__tests__/runSqlMetering.test.js"],
  auth: ["../utils/__tests__/workosAuth.test.js"],
  pre_aggregations: ["../routes/__tests__/validateInBranch.corpus.test.js"],
  outbox: ["../utils/__tests__/billingOutbox.test.js"],
  metering: [
    "../utils/__tests__/enrichmentMetering.test.js",
    "../utils/__tests__/connectionCalledBilling.test.js",
  ],
};

describe("Cube 1.6.68 to 1.7.30 comparative corpus", () => {
  it("runs only an explicitly supported Cube runtime", () => {
    assert.ok(
      ["1.6.68", "1.7.30"].includes(runtimeVersion),
      `unsupported Cube runtime in comparative corpus: ${runtimeVersion}`,
    );
    if (process.env.CUBE_RUNTIME_EXPECTED_VERSION) {
      assert.equal(runtimeVersion, process.env.CUBE_RUNTIME_EXPECTED_VERSION);
    }
  });

  for (const [surface, paths] of Object.entries(CORPUS)) {
    it(`${surface} lane remains present`, async () => {
      for (const path of paths) await access(new URL(path, import.meta.url));
    });
  }

  it("keeps format behavior stable", () => {
    assert.equal(validateFormat(), "json");
    assert.equal(validateFormat("csv"), "csv");
    assert.equal(validateFormat("arrow"), "arrow");
    assert.equal(escapeCSVField('Iceland, "weather"'), '"Iceland, ""weather"""');
    assert.throws(() => validateFormat("parquet"), /Unsupported format/);
  });

  it("keeps enrichment detection and charge identity stable", () => {
    assert.equal(
      queryUsesEnrichment({ filters: [{ member: "CtxWeatherContext.marker" }] }),
      true,
    );
    assert.deepEqual(
      sqlEnrichmentBillingItems(
        "SELECT * FROM enrich.day_context_v JOIN enrich.weather_context_v USING (event_date)",
      ),
      ["ctx:day-archetype", "ctx:weather-archetype"],
    );
    assert.equal(
      deterministicBillingMessageId("logical-1", "ctx:day-archetype"),
      deterministicBillingMessageId("logical-1", "ctx:day-archetype"),
    );
    assert.notEqual(
      deterministicBillingMessageId("logical-1", "ctx:day-archetype"),
      deterministicBillingMessageId("logical-1", "ctx:weather-archetype"),
    );
  });

  it("does not embed a comparison result in the test source", async () => {
    const source = await readFile(new URL(import.meta.url), "utf8");
    assert.doesNotMatch(source, /pass(?:ed)?\s*[:=]\s*(?:true|yes)/i);
  });
});
