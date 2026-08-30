import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  assertEnrichmentQueryAuthorized,
  assertSqlEnrichmentAuthorized,
  collectResolvedMembers,
  parseSqlTableReferences,
  sqlEnrichmentBillingItems,
  validateEnrichmentLease,
  assertNoDirectEnrichmentObject,
  removeEnrichmentSchema,
} from "../enrichmentEntitlement.js";
import { filterUnentitledEnrichmentSchemas } from "../repositoryFactory.js";

const KEY = "test-enrichment-signing-key-at-least-32-bytes";
const PRODUCTS = ["ctx:day-archetype", "ctx:weather-archetype"];
const BILLING_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

const canonicalPayload = (payload) =>
  JSON.stringify({
    schema_version: payload.schema_version,
    account_partition: payload.account_partition,
    enabled: payload.enabled,
    entitlement_revision: payload.entitlement_revision,
    issued_at: payload.issued_at,
    valid_until: payload.valid_until,
    products: payload.products,
    billing_connection_id: payload.billing_connection_id,
  });

function makeSecurityContext(overrides = {}) {
  const payload = {
    schema_version: 1,
    account_partition: "tenant-is",
    enabled: true,
    entitlement_revision: "7",
    issued_at: "2026-08-30T09:00:00.000Z",
    valid_until: "2026-08-30T11:00:00.000Z",
    products: PRODUCTS,
    billing_connection_id: BILLING_CONNECTION_ID,
    ...overrides,
  };
  const signature = createHmac("sha256", KEY)
    .update(canonicalPayload(payload))
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
            signature_version: "hmac-sha256-v1",
            signature,
            products: payload.products,
            billing_connection_id: payload.billing_connection_id,
          },
        },
      },
    },
  };
}

const NOW = new Date("2026-08-30T10:00:00.000Z");

describe("resolved enrichment member guard", () => {
  it("walks dimensions, measures, segments, time dimensions, nested filters, and every order form", () => {
    const members = collectResolvedMembers({
      dimensions: ["Orders.id"],
      measures: ["Orders.count"],
      segments: ["Orders.active"],
      timeDimensions: [{ dimension: "Orders.createdAt" }],
      filters: [
        {
          and: [
            {
              member: "CtxDayContext.dayType",
              operator: "equals",
              values: ["workday"],
            },
            { or: [{ dimension: "CtxWeatherContext.weatherType" }] },
          ],
        },
      ],
      order: [
        ["CtxDayContext.date", "asc"],
        { id: "CtxWeatherContext.temperature", desc: true },
        { member: "Orders.total", direction: "desc" },
      ],
    });
    assert.deepEqual(
      new Set(members),
      new Set([
        "Orders.id",
        "Orders.count",
        "Orders.active",
        "Orders.createdAt",
        "CtxDayContext.dayType",
        "CtxWeatherContext.weatherType",
        "CtxDayContext.date",
        "CtxWeatherContext.temperature",
        "Orders.total",
      ]),
    );

    assert.deepEqual(
      collectResolvedMembers({ order: { "CtxDayContext.date": "asc" } }),
      ["CtxDayContext.date"],
    );
  });

  it("accepts a current, correctly signed lease", () => {
    assert.deepEqual(
      validateEnrichmentLease(makeSecurityContext(), {
        signingKey: KEY,
        now: NOW,
      }),
      { valid: true, connectionId: BILLING_CONNECTION_ID },
    );
    assert.doesNotThrow(() =>
      assertEnrichmentQueryAuthorized(
        { measures: ["CtxWeatherContext.temperatureAvg"] },
        makeSecurityContext(),
        { signingKey: KEY, now: NOW },
      ),
    );
  });

  it("denies missing, expired, disabled, malformed, and incorrectly signed leases without member disclosure", () => {
    const cases = [
      {},
      makeSecurityContext({ valid_until: "2026-08-30T09:59:59.000Z" }),
      makeSecurityContext({ enabled: false }),
      makeSecurityContext({ products: [PRODUCTS[0]] }),
      makeSecurityContext({ billing_connection_id: null }),
      makeSecurityContext(),
    ];
    cases[5].userScope.teamProperties.premium.enrichment.signature = "invalid";

    for (const securityContext of cases) {
      assert.throws(
        () =>
          assertEnrichmentQueryAuthorized(
            { filters: [{ member: "CtxDayContext.secretMarker" }] },
            securityContext,
            { signingKey: KEY, now: NOW },
          ),
        (error) => {
          assert.equal(error.status, 403);
          assert.equal(error.code, "enrichment_not_available");
          assert.doesNotMatch(error.message, /Ctx|weather|day|marker/i);
          return true;
        },
      );
    }
  });

  it("does not require an enrichment lease for unrelated members", () => {
    assert.doesNotThrow(() =>
      assertEnrichmentQueryAuthorized({ measures: ["Orders.count"] }, {}),
    );
  });
});

describe("physical SQL enrichment guard", () => {
  it("parses qualified and quoted table references and ignores comments and string literals", () => {
    const refs = parseSqlTableReferences(`
      /* FROM enrich.release_pointer */
      WITH source AS (
        SELECT * FROM \"enrich\".\"day_context_v\"
      )
      SELECT '-- JOIN enrich.weather_context' AS note
      FROM source
      JOIN \`enrich\`.\`weather_context_v\` AS weather ON 1 = 1
    `);
    assert.deepEqual(refs, [
      { schema: "enrich", table: "day_context_v" },
      { schema: null, table: "source" },
      { schema: "enrich", table: "weather_context_v" },
    ]);
  });

  it("allows only public serving views with a valid lease", () => {
    assert.doesNotThrow(() =>
      assertSqlEnrichmentAuthorized(
        'SELECT * FROM "enrich"."day_context_v" d JOIN enrich.weather_context_v w ON d.date = w.date',
        makeSecurityContext(),
        { signingKey: KEY, now: NOW },
      ),
    );
  });

  it("maps only explicit serving-view references to direct-SQL billing items", () => {
    assert.deepEqual(
      sqlEnrichmentBillingItems(`
        SELECT '-- enrich.weather_context_v' AS note
        FROM enrich.day_context_v
        JOIN enrich.weather_context_v USING (local_date)
      `),
      ["ctx:day-archetype", "ctx:weather-archetype"],
    );
    assert.deepEqual(
      sqlEnrichmentBillingItems("SELECT * FROM cst.semantic_events"),
      [],
    );
  });

  it("denies physical/control tables even when the lease is valid", () => {
    for (const table of [
      "day_context",
      "weather_context",
      "release_manifest",
      "release_pointer",
    ]) {
      assert.throws(
        () =>
          assertSqlEnrichmentAuthorized(
            `SELECT * FROM enrich.${table}`,
            makeSecurityContext(),
            { signingKey: KEY, now: NOW },
          ),
        (error) => error.status === 403 && !error.message.includes(table),
      );
    }
  });

  it("denies a serving view without a valid lease", () => {
    assert.throws(
      () =>
        assertSqlEnrichmentAuthorized("SELECT * FROM enrich.day_context_v", {}),
      (error) =>
        error.status === 403 && error.code === "enrichment_not_available",
    );
  });
});

describe("metadata and helper isolation", () => {
  it("removes only managed enrichment cubes and preserves authored siblings", () => {
    const schemas = [
      {
        name: "ctx_day_context.yml",
        code: `cubes:\n  - name: CtxDayContext\n    meta:\n      managed_by: ctx-enrichment\n  - name: TeamAuthored\n    sql_table: cst.events\n`,
      },
      { name: "orders.yml", code: "cubes:\n  - name: Orders\n" },
    ];
    const filtered = filterUnentitledEnrichmentSchemas(schemas, {});
    assert.equal(filtered.length, 2);
    assert.doesNotMatch(filtered[0].code, /CtxDayContext|ctx-enrichment/);
    assert.match(filtered[0].code, /TeamAuthored/);
    assert.equal(filtered[1], schemas[1]);
  });

  it("keeps managed models when the lease is valid", () => {
    const schemas = [{ name: "ctx_weather_context.yml", code: "cubes: []" }];
    assert.equal(
      filterUnentitledEnrichmentSchemas(schemas, makeSecurityContext(), {
        signingKey: KEY,
        now: NOW,
      }),
      schemas,
    );
  });

  it("hides the enrich database and rejects direct helper object access", () => {
    const schema = { cst: { events: [] }, enrich: { day_context_v: [] } };
    assert.deepEqual(removeEnrichmentSchema(schema), { cst: { events: [] } });
    assert.throws(
      () => assertNoDirectEnrichmentObject("enrich", "day_context_v"),
      (error) => error.status === 403 && !/day_context/.test(error.message),
    );
    assert.doesNotThrow(() => assertNoDirectEnrichmentObject("cst", "events"));
  });
});
