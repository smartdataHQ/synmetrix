import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import queryRewrite from "../../utils/queryRewrite.js";
import { authorizeNativeEnrichmentSql } from "../loadExport.js";
import { authorizeRunSqlQuery } from "../runSql.js";

const KEY = "test-enrichment-signing-key-at-least-32-bytes";
const NOW = new Date("2026-08-30T10:00:00.000Z");
const PRODUCTS = ["ctx:day-archetype", "ctx:weather-archetype"];

function securityContext() {
  const payload = {
    schema_version: 1,
    account_partition: "tenant-is",
    enabled: true,
    entitlement_revision: "12",
    issued_at: "2026-08-30T09:00:00.000Z",
    valid_until: "2026-08-30T11:00:00.000Z",
    products: PRODUCTS,
  };
  const signature = createHmac("sha256", KEY)
    .update(JSON.stringify(payload))
    .digest("base64url");
  return {
    userScope: {
      teamProperties: {
        partition: payload.account_partition,
        premium: {
          enrichment: {
            enabled: payload.enabled,
            entitlement_revision: payload.entitlement_revision,
            issued_at: payload.issued_at,
            valid_until: payload.valid_until,
            products: payload.products,
            signature_version: "hmac-sha256-v1",
            signature,
          },
        },
      },
    },
  };
}

const OPTIONS = { signingKey: KEY, now: NOW };

describe("enrichment side-door authorization", () => {
  it("denies a nested resolved member at the compiler boundary before rule loading", async () => {
    await assert.rejects(
      queryRewrite(
        {
          measures: ["Orders.count"],
          filters: [{ or: [{ member: "CtxWeatherContext.temperatureAvg" }] }],
        },
        { securityContext: {} },
      ),
      (error) =>
        error.status === 403 &&
        error.code === "enrichment_not_available" &&
        !/weather|temperature/i.test(error.message),
    );
  });

  it("applies the parser guard to run-sql independently of SQL provenance", () => {
    assert.doesNotThrow(() =>
      authorizeRunSqlQuery(
        'SELECT * FROM "enrich"."weather_context_v"',
        securityContext(),
        OPTIONS,
      ),
    );
    assert.throws(
      () =>
        authorizeRunSqlQuery(
          "SELECT * FROM /* misleading enrich.day_context_v */ enrich.release_pointer",
          securityContext(),
          OPTIONS,
        ),
      (error) => error.status === 403 && !/release_pointer/.test(error.message),
    );
  });

  it("applies the same guard to native CSV and Arrow export SQL", () => {
    const nativeSql = `
      -- FROM enrich.day_context
      SELECT * FROM \`enrich\`.\`day_context_v\`
      JOIN \"enrich\".\"weather_context_v\" USING (date)
    `;
    for (const format of ["csv", "arrow"]) {
      assert.doesNotThrow(() =>
        authorizeNativeEnrichmentSql(nativeSql, securityContext(), OPTIONS),
      );
      assert.throws(
        () => authorizeNativeEnrichmentSql(nativeSql, {}, OPTIONS),
        (error) =>
          error.status === 403 &&
          error.code === "enrichment_not_available" &&
          !error.message.includes(format),
      );
    }
  });

  it("cannot be bypassed with quoted, qualified, or commented physical names", () => {
    const blocked = [
      'SELECT * FROM "enrich"."day_context"',
      "SELECT * FROM `enrich`.`weather_context`",
      "SELECT * FROM /* enrich.day_context_v */ enrich.release_manifest",
    ];
    for (const sql of blocked) {
      assert.throws(
        () => authorizeRunSqlQuery(sql, securityContext(), OPTIONS),
        (error) => error.status === 403,
      );
    }
  });
});
