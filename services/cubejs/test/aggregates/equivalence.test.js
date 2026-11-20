/**
 * SC-001: a routed answer equals the answer of the source, cell for cell, with
 * the same output columns in the same order. Needs the disposable ClickHouse
 * (docker-compose.clickhouse.yml).
 */
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import * as h from "./harness.js";

await h.stubSchemaLoader(mock, () => [{ id: "f1", name: "line_items.yml", code: h.MODEL }]);

const m = (name) => `line_items.${name}`;
const over = (granularity, from, to) => [
  { dimension: m("timestamp"), ...(granularity ? { granularity } : {}), dateRange: [from, to] },
];

let routed;
let plain;

/** Runs a query on both paths and asserts the routed one read `table` and returned the same rows. */
async function same(label, query, table = "agg_test.sales__agg_1day") {
  const viaAggregate = await h.sqlFor(routed, query, h.requestContext());
  const viaSource = await h.sqlFor(plain, query, h.requestContext());
  assert.deepEqual(h.tablesOf(viaAggregate), [table], `${label}: ${routed.lines.at(-1)}`);
  assert.deepEqual(h.tablesOf(viaSource), ["agg_test.sales"], label);
  const [actual, expected] = [await h.execute(viaAggregate), await h.execute(viaSource)];
  assert.ok(expected.length > 0, `${label}: the source returned no rows`);
  h.assertSameRows(actual, expected, { label });
  return actual;
}

before(async () => {
  await h.loadFixture("sales_like");
  await h.fillAll(await h.structureOf("agg_test.sales__agg_1day"));
  await h.reloadCatalog();
  routed = await h.service({ routing: true });
  plain = await h.service({ routing: false });
});

after(async () => {
  await h.close();
});

describe("a routed query equals the source (US1)", () => {
  it("month by sums over whole days", async () => {
    const rows = await same("month by sums", {
      measures: [m("units"), m("quantity"), m("gross_revenue")],
      timeDimensions: over("month", "2026-01-01", "2026-04-30"),
    });
    assert.equal(rows.length, 4);
    assert.deepEqual(Object.keys(rows[0]), [
      "line_items__timestamp_month", "line_items__units", "line_items__quantity", "line_items__gross_revenue",
    ]);
  });

  it("day by dimension by sum, with a filter", async () => {
    await same("day by category", {
      measures: [m("quantity")],
      dimensions: [m("main_category")],
      timeDimensions: over("day", "2026-02-01", "2026-03-02"),
      filters: [{ member: m("sold_location"), operator: "equals", values: ["store1"] }],
    });
  });

  it("totals", async () => {
    const rows = await same("totals", {
      measures: [m("units"), m("gross_revenue"), m("count")],
      timeDimensions: over(undefined, "2026-02-01", "2026-02-28"),
    });
    assert.equal(rows.length, 1);
  });

  it("a dimension value list, with and without a date range", async () => {
    const rows = await same("stores in a range", {
      dimensions: [m("sold_location")],
      timeDimensions: over(undefined, "2026-01-01", "2026-03-31"),
    });
    assert.equal(rows.length, 3);
    await same("all categories", { dimensions: [m("main_category")] });
  });

  it("average, minimum, maximum and count of a stored metric", async () => {
    await same("stored fields", {
      measures: [m("avg_units"), m("min_units"), m("max_units"), m("avg_discount"), m("count")],
      dimensions: [m("main_category")],
      timeDimensions: over("month", "2026-01-01", "2026-04-30"),
    });
  });

  it("a filtered count that matches nothing is 0, not empty", async () => {
    const rows = await same("no match", {
      measures: [m("store0_lines"), m("store0_units")],
      filters: [{ member: m("sold_location"), operator: "equals", values: ["store1"] }],
    });
    assert.equal(Number(rows[0].line_items__store0_lines), 0);
  });

  it("a product of one summed column and a grouping column", async () => {
    await same("revenue by store", { measures: [m("gross_revenue")], dimensions: [m("sold_location")] });
  });

  it("filtered measures, a share, a map key and its average", async () => {
    await same("filtered and map", {
      measures: [m("store0_lines"), m("store0_avg_units"), m("store0_share"), m("weight"), m("avg_weight")],
      dimensions: [m("main_category")],
      timeDimensions: over("week", "2026-03-02", "2026-03-29"),
    });
  });

  it("a rewritten grouping column, a derived dimension, a case dimension and a segment", async () => {
    await same("dimensions", {
      measures: [m("units"), m("unique_products"), m("max_price")],
      dimensions: [m("is_volume_pack"), m("is_time_unit"), m("price_tier")],
      segments: [m("store0")],
    });
  });

  it("a month that holds unmerged duplicates, as the source reports it today", async () => {
    const rows = await same("april", {
      measures: [m("count"), m("units")],
      timeDimensions: over("month", "2026-04-01", "2026-04-30"),
    });
    const [{ merged }] = await h.run(
      "SELECT count() AS merged FROM agg_test.sales FINAL WHERE partition = 't1' AND toStartOfMonth(timestamp) = '2026-04-01'",
    );
    assert.equal(Number(rows[0].line_items__count), 2 * Number(merged));
  });
});

describe("with two grains, the coarsest one that is exact answers (US3)", () => {
  const FINE = "agg_test.sales__agg_30minute";
  const COARSE = "agg_test.sales__agg_1day";

  before(async () => {
    await h.loadFixture("sales_like_30minute");
    await h.fillAll(await h.structureOf(FINE));
    await h.reloadCatalog();
  });

  /** Asserts the query runs on the source, for the given reason. */
  async function onSource(query, expected) {
    const statement = await h.sqlFor(routed, query, h.requestContext());
    assert.deepEqual(h.tablesOf(statement), ["agg_test.sales"]);
    assert.match(routed.lines.at(-1), new RegExp(`reason=${expected}$`));
  }

  it("an hourly bucket over whole days reads the 30-minute table", async () => {
    const rows = await same("hour", { measures: [m("units"), m("count")], timeDimensions: over("hour", "2026-02-03", "2026-02-04") }, FINE);
    assert.ok(rows.length > 24, `${rows.length} hourly buckets`);
  });

  it("day, week and month buckets read the one-day table", async () => {
    for (const granularity of ["day", "week", "month"]) {
      await same(granularity, { measures: [m("units"), m("avg_units")], timeDimensions: over(granularity, "2026-02-02", "2026-03-29") }, COARSE);
    }
  });

  it("a range from 10:30 to 10:30 reads the 30-minute table", async () => {
    await same(
      "10:30",
      { measures: [m("quantity"), m("count")], dimensions: [m("main_category")], timeDimensions: over(undefined, "2026-02-03T10:30:00.000", "2026-02-05T10:29:59.999") },
      FINE,
    );
  });

  it("a minute bucket, or a range from 10:15, reads the source", async () => {
    await onSource({ measures: [m("units")], timeDimensions: over("minute", "2026-02-03", "2026-02-03") }, "granularity");
    await onSource(
      { measures: [m("units")], timeDimensions: over(undefined, "2026-02-03T10:15:00.000", "2026-02-05T10:14:59.999") },
      "range_not_aligned",
    );
  });
});
