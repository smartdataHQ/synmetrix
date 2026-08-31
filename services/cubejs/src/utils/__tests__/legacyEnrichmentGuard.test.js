import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertNoDirectLegacyEnrichmentObject,
  assertNoLegacyEnrichmentQuery,
  assertNoLegacyEnrichmentSql,
  collectResolvedMembers,
  parseSqlTableReferences,
  removeLegacyEnrichmentSchema,
} from "../legacyEnrichmentGuard.js";
import { filterLegacyEnrichmentSchemas } from "../repositoryFactory.js";

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

  it("always denies retired cubes without member disclosure", () => {
    assert.throws(
      () =>
        assertNoLegacyEnrichmentQuery({
          filters: [{ member: "CtxDayContext.secretMarker" }],
        }),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "enrichment_not_available");
        assert.doesNotMatch(error.message, /Ctx|weather|day|marker/i);
        return true;
      },
    );
  });

  it("allows the ordinary semantic query surface", () => {
    assert.doesNotThrow(() =>
      assertNoLegacyEnrichmentQuery({ measures: ["FftWeather.temperatureAvg"] }),
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

  it("denies every retired physical object", () => {
    for (const table of [
      "day_context",
      "weather_context",
      "release_manifest",
      "release_pointer",
    ]) {
      assert.throws(
        () =>
          assertNoLegacyEnrichmentSql(`SELECT * FROM enrich.${table}`),
        (error) => error.status === 403 && !error.message.includes(table),
      );
    }
  });

  it("allows the current FFT physical query surface", () => {
    assert.doesNotThrow(() =>
      assertNoLegacyEnrichmentSql("SELECT * FROM public.fft_weather"),
    );
    assert.throws(
      () => assertNoLegacyEnrichmentSql("SELECT * FROM enrich.day_context_v"),
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
    const filtered = filterLegacyEnrichmentSchemas(schemas);
    assert.equal(filtered.length, 2);
    assert.doesNotMatch(filtered[0].code, /CtxDayContext|ctx-enrichment/);
    assert.match(filtered[0].code, /TeamAuthored/);
    assert.equal(filtered[1], schemas[1]);
  });

  it("hides the enrich database and rejects direct helper object access", () => {
    const schema = { cst: { events: [] }, enrich: { day_context_v: [] } };
    assert.deepEqual(removeLegacyEnrichmentSchema(schema), {
      cst: { events: [] },
    });
    assert.throws(
      () =>
        assertNoDirectLegacyEnrichmentObject("enrich", "day_context_v"),
      (error) => error.status === 403 && !/day_context/.test(error.message),
    );
    assert.doesNotThrow(() =>
      assertNoDirectLegacyEnrichmentObject("cst", "events"),
    );
  });
});
