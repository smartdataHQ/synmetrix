import { describe, it } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

import { bucketExpression, fillSelect, parseBinding, parseGrain } from "../contract.js";
import { deriveCube, sourceTableOf } from "../derive.js";
import { generate } from "../generator.js";
import { refreshAggregate } from "../refresh.js";
import { installAggregateRouting } from "../routing.js";
import { decide } from "../suitability.js";
import { COLUMNS, structure } from "./fixtures/salesAggregate.js";

const DAY = 86400_000;
const NOW = Date.UTC(2026, 10, 24, 6, 30); // 2026-11-24T06:30:00Z
const TODAY_UTC = Date.UTC(2026, 10, 24, 0, 0);

// Minimal EXPLAIN AST stub for unit testing deriveCube without live ClickHouse.
function fakeClassifyBatch(expressions) {
  // Parse simple identifiers, literals, function calls, binary ops for test expressions.
  const parseExpr = (text) => {
    const s = String(text || "").trim();
    if (/^'[^']*'$/.test(s) || /^-?\d+(\.\d+)?$/.test(s)) return { type: "Literal", name: s, children: [] };
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return { type: "Identifier", name: s, children: [] };
    if (/^([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=)\s*(.+)$/.test(s)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=)\s*(.+)$/.exec(s);
      return {
        type: "Function",
        name: m[2] === "=" ? "equals" : "notEquals",
        children: [{ type: "ExpressionList", children: [parseExpr(m[1]), parseExpr(m[3])] }],
      };
    }
    const fn = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s.exec(s);
    if (fn) {
      const args = splitTopArgs(fn[2]).map(parseExpr);
      return { type: "Function", name: fn[1], children: [{ type: "ExpressionList", children: args }] };
    }
    return { type: "Literal", name: "1", children: [] };
  };
  return Promise.resolve(expressions.map((expr) => (expr ? { node: parseExpr(expr) } : { cls: "X" })));
}

function splitTopArgs(str) {
  const out = [];
  let depth = 0;
  let start = 0;
  let inStr = false;
  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (c === "'") inStr = !inStr;
    else if (!inStr) {
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      else if (c === "," && depth === 0) {
        out.push(str.slice(start, i));
        start = i + 1;
      }
    }
  }
  if (str.slice(start).trim()) out.push(str.slice(start));
  return out;
}

describe("1-month grain contract & suitability", () => {
  it("accepts 1 month and rejects 1 week", async () => {
    assert.equal(parseGrain("1 month")?.text, "1 month");
    assert.equal(parseGrain("1 week"), null);
    assert.equal(parseGrain("2 month"), null);
    assert.equal(
      bucketExpression("timestamp", "1 month"),
      "toDateTime(toStartOfMonth(src.`timestamp`, 'UTC'), 'UTC')",
    );
    const { binding } = parseBinding(
      '{"aggregate_of": "cst.sales_lines", "time_column": "timestamp", "grain": "1 month", "min_age": "7 day", "min_window": "90 day", "max_staleness": "1 day"}',
    );
    assert.equal(binding.grain, "1 month");
    assert.ok(binding.grainSeconds > 86400);

    // generate() accepts 1 month + custom --name on a monthly-partitioned table
    const queryFn = async (sql) => {
      if (/FROM system\.tables/.test(sql)) {
        return [{ engine: "ReplicatedReplacingMergeTree", engine_full: "ReplicatedReplacingMergeTree SETTINGS min_age_to_force_merge_seconds = 604800", partition_key: "(partition, toStartOfMonth(timestamp))", sorting_key: "partition, timestamp", server_timezone: "UTC" }];
      }
      if (/FROM system\.columns/.test(sql)) {
        return [
          { name: "partition", type: "LowCardinality(String)", default_kind: "", default_expression: "", is_in_sorting_key: 1, is_in_partition_key: 1 },
          { name: "timestamp", type: "DateTime64(3, 'UTC')", default_kind: "", default_expression: "", is_in_sorting_key: 1, is_in_partition_key: 1 },
          { name: "sold_location", type: "LowCardinality(String)", default_kind: "", default_expression: "", is_in_sorting_key: 0, is_in_partition_key: 0 },
          { name: "units", type: "Float64", default_kind: "", default_expression: "", is_in_sorting_key: 0, is_in_partition_key: 0 },
        ];
      }
      if (/^DESCRIBE /.test(sql)) {
        return [
          { name: "units", type: "Float64" },
          { name: "units__count", type: "UInt64" },
          { name: "units__min", type: "Float64" },
          { name: "units__max", type: "Float64" },
          { name: "_rows", type: "UInt64" },
        ];
      }
      return [];
    };
    const gen = await generate(queryFn, {
      source: "cst.sales_lines",
      timeColumn: "timestamp",
      grain: "1 month",
      groupBy: ["partition", "sold_location"],
      minAge: "7 day",
      minWindow: "90 day",
      maxStaleness: "1 day",
      cluster: "fraios",
    });
    assert.equal(gen.declined, undefined);
    assert.equal(gen.table, "cst.sales_lines__agg_1month");
    assert.match(gen.definition, /"grain": "1 month"/);

    // Opt-out --exclude mode keeps all non-numeric groupable columns except those excluded
    const optOutQueryFn = async (sql) => {
      if (/FROM system\.columns/.test(sql)) {
        return [
          { name: "partition", type: "LowCardinality(String)", default_kind: "", default_expression: "", is_in_sorting_key: 1, is_in_partition_key: 1 },
          { name: "timestamp", type: "DateTime64(3, 'UTC')", default_kind: "", default_expression: "", is_in_sorting_key: 1, is_in_partition_key: 1 },
          { name: "checkout_id", type: "String", default_kind: "", default_expression: "", is_in_sorting_key: 1, is_in_partition_key: 0 },
          { name: "sold_location", type: "LowCardinality(String)", default_kind: "", default_expression: "", is_in_sorting_key: 0, is_in_partition_key: 0 },
          { name: "product_id", type: "LowCardinality(String)", default_kind: "", default_expression: "", is_in_sorting_key: 1, is_in_partition_key: 0 },
          { name: "units", type: "Float64", default_kind: "", default_expression: "", is_in_sorting_key: 0, is_in_partition_key: 0 },
        ];
      }
      return queryFn(sql);
    };
    const genOptOut = await generate(optOutQueryFn, {
      source: "cst.sales_lines",
      timeColumn: "timestamp",
      grain: "1 day",
      exclude: ["checkout_id"],
      minAge: "1 day",
      minWindow: "60 day",
      maxStaleness: "1 day",
      cluster: "fraios",
    });
    assert.equal(genOptOut.declined, undefined);
    assert.equal(genOptOut.table, "cst.sales_lines__agg_1day");
    assert.match(genOptOut.definition, /ORDER BY \(`partition`, `timestamp`, `sold_location`, `product_id`\)/);
    assert.ok(genOptOut.leftOut.some((c) => c.name === "checkout_id" && c.reason === "excluded by --exclude"));

    // Declines excluding partition or time column, or passing both --group-by and --exclude
    assert.match((await generate(optOutQueryFn, { source: "cst.sales_lines", timeColumn: "timestamp", grain: "1 day", exclude: ["partition"], minAge: "1 day", minWindow: "60 day", maxStaleness: "1 day" })).declined, /cannot be excluded/);
    assert.match((await generate(optOutQueryFn, { source: "cst.sales_lines", timeColumn: "timestamp", grain: "1 day", groupBy: ["partition"], exclude: ["checkout_id"], minAge: "1 day", minWindow: "60 day", maxStaleness: "1 day" })).declined, /not both/);
  });

  it("routes whole-month queries to 1-month aggregate and falls back to 1-day for partial-month or daily/weekly queries", () => {
    const monthStruct = structure(COLUMNS, "sales__agg_1month", {
      grain: "1 month",
      grainSeconds: 31 * 86400,
      verifiedAt: NOW,
      coveredUntil: Date.UTC(2026, 10, 1),
      totalRows: 500_000,
    });
    const dayStruct = structure(COLUMNS, "sales__agg_1day", {
      grain: "1 day",
      grainSeconds: 86400,
      verifiedAt: NOW,
      coveredUntil: TODAY_UTC,
      totalRows: 5_000_000,
    });
    const derived = new Map([
      [monthStruct.table, { cube: "line_items", aggregate: monthStruct.table, variantKey: "vk-month", available: new Set(["line_items.timestamp", "line_items.units"]), leftOut: new Map(), timeMembers: new Set(["line_items.timestamp"]), ineligible: null }],
      [dayStruct.table, { cube: "line_items", aggregate: dayStruct.table, variantKey: "vk-day", available: new Set(["line_items.timestamp", "line_items.units"]), leftOut: new Map(), timeMembers: new Set(["line_items.timestamp"]), ineligible: null }],
    ]);
    const entry = { aggregates: [dayStruct, monthStruct] };

    // Whole-month range + month granularity -> picks 1-month (coarsest)
    const monthly = decide(
      [{ measures: ["line_items.units"], timeDimensions: [{ dimension: "line_items.timestamp", granularity: "month", dateRange: ["2026-05-01T00:00:00.000", "2026-10-31T23:59:59.999"] }] }],
      derived,
      entry,
      () => NOW,
    );
    assert.equal(monthly.aggregate, monthStruct.table);

    // Mid-month range + month granularity -> falls back to 1-day
    const midMonth = decide(
      [{ measures: ["line_items.units"], timeDimensions: [{ dimension: "line_items.timestamp", granularity: "month", dateRange: ["2026-05-18T00:00:00.000", "2026-11-23T23:59:59.999"] }] }],
      derived,
      entry,
      () => NOW,
    );
    assert.equal(midMonth.aggregate, dayStruct.table);

    // Week granularity -> never uses 1-month; falls back to 1-day
    const weekly = decide(
      [{ measures: ["line_items.units"], timeDimensions: [{ dimension: "line_items.timestamp", granularity: "week", dateRange: ["2026-05-01T00:00:00.000", "2026-10-31T23:59:59.999"] }] }],
      derived,
      entry,
      () => NOW,
    );
    assert.equal(weekly.aggregate, dayStruct.table);
  });
});

describe("deriveCube: two-branch UNION ALL FINAL and many_to_one joins", () => {
  const LIVE_LINE_ITEMS = {
    name: "line_items",
    sql: `SELECT * FROM (
      SELECT * FROM agg_test.sales
      WHERE partition = 'bonus.is' AND timestamp < toDateTime(toStartOfMonth(today()) - INTERVAL 2 MONTH)
      SETTINGS asterisk_include_alias_columns = 1
      UNION ALL
      SELECT * FROM agg_test.sales FINAL
      WHERE partition = 'bonus.is' AND timestamp >= toDateTime(toStartOfMonth(today()) - INTERVAL 2 MONTH)
      SETTINGS do_not_merge_across_partitions_select_final = 1, asterisk_include_alias_columns = 1
    )`,
    joins: [{ name: "bonus_products", relationship: "many_to_one", sql: "{CUBE}.product_id = {bonus_products}.product_id" }],
    dimensions: [
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "sold_location", sql: "sold_location", type: "string" },
      { name: "product_id", sql: "product_id", type: "string" },
      { name: "supplier", sql: "coalesce(nullIf({bonus_products.supplier}, ''), {CUBE}.main_category)", type: "string" },
      { name: "brand", sql: "if({bonus_products.product_id} != '', {bonus_products.brand}, {CUBE}.main_category)", type: "string" },
    ],
    measures: [{ name: "units", sql: "units", type: "sum" }],
  };
  const BONUS_PRODUCTS = {
    name: "bonus_products",
    sql: "SELECT 'p1' AS product_id, 'Sup' AS supplier, 'Br' AS brand",
    dimensions: [
      { name: "product_id", sql: "product_id", type: "string", primary_key: true },
      { name: "supplier", sql: "supplier", type: "string" },
      { name: "brand", sql: "brand", type: "string" },
    ],
  };

  it("extracts source table from two-branch time-split UNION ALL FINAL and keeps many_to_one join when key is in aggregate", async () => {
    assert.equal(sourceTableOf(LIVE_LINE_ITEMS), "agg_test.sales");
    const agg = structure(COLUMNS, "sales__agg_1day_product");
    const availableCubes = new Map([["bonus_products", { cube: BONUS_PRODUCTS, fileName: "bonus_products.yml", content: "" }]]);
    const derived = await deriveCube(LIVE_LINE_ITEMS, agg, fakeClassifyBatch, "v1", { availableCubes });

    assert.equal(derived.ineligible, null);
    assert.ok(derived.available.has("line_items.supplier"));
    assert.ok(derived.available.has("line_items.brand"));
    assert.ok(derived.available.has("line_items.units"));
    assert.equal(derived.files.length, 2);
    const parsed = YAML.parse(derived.files[0].content).cubes[0];
    assert.equal(parsed.sql, "SELECT * FROM agg_test.sales__agg_1day_product WHERE partition = 'bonus.is'");
    assert.equal(parsed.joins?.length, 1);
    assert.equal(parsed.joins[0].name, "bonus_products");
    assert.ok(parsed.dimensions.some((d) => d.name === "__agg_pk" && d.primary_key === true && d.public === false));
    // Verify string scalars like ISO dates stay quoted so Cube's js-yaml (YAML 1.1) doesn't turn them into Date objects.
    const withGranularity = {
      ...LIVE_LINE_ITEMS,
      dimensions: LIVE_LINE_ITEMS.dimensions.map((d) =>
        d.name === "timestamp" ? { ...d, granularities: [{ name: "min_5", interval: "5 minute", origin: "2020-01-01" }] } : d,
      ),
    };
    const dGran = await deriveCube(withGranularity, agg, fakeClassifyBatch, "v2", { availableCubes });
    assert.match(dGran.files[0].content, /origin:\s*"2020-01-01"/);
  });

  it("drops join and joined dimensions when aggregate lacks the join key (1day_store)", async () => {
    const storeCols = COLUMNS.filter((c) => !["product_id", "main_category"].includes(c.name));
    const agg = structure(storeCols, "sales__agg_1day_store");
    const availableCubes = new Map([["bonus_products", { cube: BONUS_PRODUCTS, fileName: "bonus_products.yml", content: "" }]]);
    const derived = await deriveCube(LIVE_LINE_ITEMS, agg, fakeClassifyBatch, "v1", { availableCubes });

    assert.equal(derived.ineligible, null);
    assert.ok(derived.available.has("line_items.sold_location"));
    assert.ok(derived.available.has("line_items.units"));
    assert.ok(!derived.available.has("line_items.supplier"));
    assert.ok(!derived.available.has("line_items.brand"));
    assert.equal(derived.files.length, 1);
    const parsed = YAML.parse(derived.files[0].content).cubes[0];
    assert.equal(parsed.joins, undefined);
  });
});

describe("refreshAggregate: throttling, batching, and active completed-day coverage", () => {
  it("applies SETTINGS throttle, respects maxPartitions without marking verified, and deduplicates active month with FINAL", async () => {
    const writes = [];
    const oct = { partition_id: "p10", fingerprint: "110", oldest_ms: String(Date.UTC(2026, 9, 1)), newest_ms: String(Date.UTC(2026, 9, 31, 23)) };
    const nov = { partition_id: "p11", fingerprint: "111", oldest_ms: String(Date.UTC(2026, 10, 1)), newest_ms: String(NOW - 60_000) };
    const queryFn = async (sql) => {
      if (/^SELECT toUnixTimestamp64Milli\(now64\(3\)\)/.test(sql)) return [{ now_ms: String(NOW) }];
      if (/groupBitXor/.test(sql)) return [oct, nov].map(({ partition_id, fingerprint }) => ({ partition_id, fingerprint }));
      if (/GROUP BY _partition_id$/.test(sql)) return [oct, nov].map(({ partition_id, oldest_ms, newest_ms }) => ({ partition_id, oldest_ms, newest_ms }));
      if (/argMax\(fingerprint/.test(sql)) return [];
      if (/DISTINCT partition_id/.test(sql)) return [];
      if (/AS strays/.test(sql)) return [{ strays: "0" }];
      writes.push(sql);
      return [];
    };

    const agg = structure(COLUMNS, "sales__agg_1day", { minAgeSeconds: 86400 });

    // Partial batch (maxPartitions: 1, desc -> builds nov first, does NOT emit verified pass record!)
    const first = await refreshAggregate(queryFn, agg, {
      maxPartitions: 1,
      order: "desc",
      includeCompletedDays: true,
      settings: {
        max_threads: 2,
        max_memory_usage: 4000000000,
        max_bytes_before_external_sort: 2000000000,
        priority: 10,
      },
    });
    assert.equal(first.partial, true);
    assert.equal(first.remaining, 1);
    assert.deepEqual(first.built, ["p11"]);
    assert.equal(first.verifiedAt, null);
    const insertNov = writes.find((s) => s.startsWith("INSERT INTO `agg_test`.`sales__agg_1day__staging`"));
    assert.match(insertNov, /AS src FINAL WHERE src\._partition_id = 'p11' AND \(src\.`timestamp` < fromUnixTimestamp64Milli\(toInt64\(1795478400000\), 'UTC'\)\)/);
    assert.match(insertNov, /SETTINGS max_threads = 2, max_memory_usage = 4000000000, max_bytes_before_external_sort = 2000000000, priority = 10$/);
    assert.equal(writes.filter((s) => s.includes("VALUES ('sales__agg_1day', '', ")).length, 0);

    // Complete pass -> builds both and sets coveredUntil = startOfTodayUtc (2026-11-24T00:00:00Z)
    writes.length = 0;
    const full = await refreshAggregate(queryFn, agg, {
      order: "desc",
      includeCompletedDays: true,
      settings: { max_threads: 2, priority: 10 },
    });
    assert.equal(full.partial, false);
    assert.equal(full.remaining, 0);
    assert.equal(full.coveredUntil, TODAY_UTC);
    const insertOct = writes.filter((s) => s.startsWith("INSERT INTO `agg_test`.`sales__agg_1day__staging`"))[1];
    assert.doesNotMatch(insertOct, /\bFINAL\b/); // Oct is >8d old -> plain read
  });
});

describe("installAggregateRouting: opt-in mode and per-request useAggregates toggle", () => {
  it("supports opt-in mode and per-request override in both true and opt-in modes", async () => {
    const gateway = {
      async contextByReq(req, securityContext, requestId) {
        return { securityContext, requestId };
      },
      async getNormalizedQueries(input) {
        return ["regularQuery", [input], [input]];
      },
    };
    const logs = [];
    const cubejs = { apiGateway: () => gateway };
    const installed = installAggregateRouting(cubejs, {
      mode: "opt-in",
      catalog: { lookup: () => ({ aggregates: [], rejected: [] }) },
      log: (line) => logs.push(line),
    });
    assert.equal(installed, true);

    // Default in opt-in mode -> skipped with opt_in_required
    const ctxDefault = await gateway.contextByReq({}, { userScope: { dataSource: {} } }, "r1");
    await gateway.getNormalizedQueries({ measures: ["x.y"] }, ctxDefault);
    assert.equal(ctxDefault.aggregateDecision?.reason, "opt_in_required");

    // Explicit opt-in -> enters routing
    const ctxOn = await gateway.contextByReq({ useAggregates: true }, { userScope: { dataSource: {} } }, "r2");
    await gateway.getNormalizedQueries({ measures: ["x.y"] }, ctxOn);
    assert.equal(ctxOn.aggregateDecision?.reason, "no_aggregate");

    // Explicit opt-out -> disabled_by_request
    const ctxOff = await gateway.contextByReq({ useAggregates: false }, { userScope: { dataSource: {} } }, "r3");
    await gateway.getNormalizedQueries({ measures: ["x.y"] }, ctxOff);
    assert.equal(ctxOff.aggregateDecision?.reason, "disabled_by_request");
  });
});
