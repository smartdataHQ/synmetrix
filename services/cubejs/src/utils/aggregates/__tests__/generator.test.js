import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyColumns, parseBinding } from "../contract.js";
import { generate, render } from "../generator.js";
import { prepare, replay } from "./fixtures/ast/replay.js";

// Answers recorded from ClickHouse 26.8 for the tables of
// test/aggregates/fixtures/generator_sources.sql.
before(() => prepare("generator_sources"));

const RETAIL = {
  source: "gen_test.retail_lines",
  timeColumn: "timestamp",
  grain: "1 day",
  groupBy: ["partition", "store", "category", "product_id", "uom", "bundled_units", "unit_price", "tax_rate"],
  minAge: "7 day",
  minWindow: "60 day",
  maxStaleness: "1 day",
};
const POINTS = { ...RETAIL, source: "gen_test.series_points", grain: "30 minute", groupBy: ["partition", "period", "access", "unit"] };
const EVENTS = { ...RETAIL, source: "gen_test.wide_events", grain: "1 hour", groupBy: ["partition", "type", "event", "country", "is_bot"] };

/** Runs the generator on recorded answers; `patch` rewrites the source's row of system.tables. */
async function run(options, patch) {
  const statements = [];
  const queryFn = async (sql) => {
    statements.push(sql);
    const rows = await replay(sql);
    return patch && /FROM system\.tables/.test(sql) ? rows.map((row) => ({ ...row, ...patch })) : rows;
  };
  return { ...(await generate(queryFn, options)), statements };
}

/** The generated table as the catalog would read it: [{name, type, is_in_sorting_key}]. */
function columnsOf(definition) {
  const body = definition.slice(definition.indexOf("(\n") + 2, definition.indexOf("\n)\nENGINE"));
  const order = /\nORDER BY \((.*)\)\n/.exec(definition)[1].split(", ").map((name) => name.replaceAll("`", ""));
  return body.split(",\n").map((line) => {
    const [, name, type] = /^\s*`([^`]+)` (.*)$/.exec(line);
    return { name, type, is_in_sorting_key: order.includes(name) ? 1 : 0 };
  });
}
const rolesOf = (definition) => {
  const { binding } = parseBinding(/\nCOMMENT '(.*)';$/.exec(definition)[1]);
  return Object.fromEntries([...classifyColumns(columnsOf(definition), binding)].map(([name, column]) => [name, column.role]));
};

describe("generate: a definition that follows the contract", () => {
  it("assigns every source column a role or a reason", async () => {
    const { definition, leftOut, declined } = await run(RETAIL);
    assert.equal(declined, undefined);
    assert.deepEqual(rolesOf(definition), {
      partition: "group", timestamp: "time", store: "group", category: "group", product_id: "group", uom: "group",
      bundled_units: "group", unit_price: "group", tax_rate: "group",
      units: "sum", units__count: "count", units__min: "min", units__max: "max",
      unit_cost: "sum", unit_cost__count: "count", unit_cost__min: "min", unit_cost__max: "max",
      discount: "sum", discount__count: "count", discount__min: "min", discount__max: "max",
      points: "sum", points__count: "count", points__min: "min", points__max: "max",
      scans: "sum", scans__count: "count", scans__min: "min", scans__max: "max",
      quantity: "sum", quantity__count: "count", quantity__min: "min", quantity__max: "max",
      revenue: "sum", revenue__count: "count", revenue__min: "min", revenue__max: "max",
      cost: "sum", cost__count: "count", cost__min: "min", cost__max: "max",
      margin: "sum", margin__count: "count", margin__min: "min", margin__max: "max",
      metrics: "sumMap",
      _rows: "rows",
    });
    assert.deepEqual(Object.fromEntries(leftOut.map(({ name, reason }) => [name, reason])), {
      entity_gid: "not numeric and not in --group-by",
      business_day: "not numeric and not in --group-by",
      event_gid: "not numeric and not in --group-by",
      position: "numeric column in the source's sorting key: an identifier, not a metric",
      checkout_id: "not numeric and not in --group-by",
      customer_id: "not numeric and not in --group-by",
      store_id: "not numeric and not in --group-by",
      product: "not numeric and not in --group-by",
      is_return: "not numeric and not in --group-by",
      is_volume_pack: "not numeric and not in --group-by",
      delivered_at: "not numeric and not in --group-by",
      dimensions: "type cannot be summarised (Map(LowCardinality(String), LowCardinality(String)))",
      flags: "type cannot be summarised (Map(LowCardinality(String), Bool))",
      properties: "type cannot be summarised (JSON)",
      loaded_at: "not numeric and not in --group-by",
      store_label: "not numeric and not in --group-by",
    });
  });

  it("declares the binding, the source's partition expression and every grouping column in the sorting key", async () => {
    const { definition, table } = await run(RETAIL);
    assert.equal(table, "gen_test.retail_lines__agg_1day");
    assert.match(definition, /^CREATE TABLE IF NOT EXISTS gen_test\.retail_lines__agg_1day\n\(\n/);
    assert.match(definition, /\nENGINE = AggregatingMergeTree\nPARTITION BY \(partition, toStartOfMonth\(timestamp\)\)\n/);
    assert.match(
      definition,
      /\nORDER BY \(`partition`, `timestamp`, `store`, `category`, `product_id`, `uom`, `bundled_units`, `unit_price`, `tax_rate`\)\n/,
    );
    assert.match(definition, /\nSETTINGS allow_nullable_key = 1, allow_suspicious_low_cardinality_types = 1\n/);
    assert.ok(
      definition.endsWith(
        `COMMENT '{"aggregate_of": "gen_test.retail_lines", "time_column": "timestamp", "grain": "1 day", "min_age": "7 day", "min_window": "60 day", "max_staleness": "1 day"}';`,
      ),
    );
    assert.doesNotMatch(definition, /ON CLUSTER|Replicated/);
  });

  it("takes exact types from ClickHouse's description of the fill statement", async () => {
    const { definition, statements } = await run(RETAIL);
    assert.equal(statements.filter((sql) => sql.startsWith("DESCRIBE (SELECT ")).length, 1);
    const types = Object.fromEntries(columnsOf(definition).map(({ name, type }) => [name, type]));
    assert.deepEqual(
      [types.partition, types.timestamp, types.unit_price, types.tax_rate],
      ["LowCardinality(String)", "DateTime64(3)", "Nullable(Float64)", "LowCardinality(Float32)"],
    );
    assert.deepEqual(
      [types.units, types.units__count, types.units__min, types.points, types.scans, types.quantity, types.metrics, types._rows],
      [
        "SimpleAggregateFunction(sum, Nullable(Float64))",
        "SimpleAggregateFunction(sum, UInt64)",
        "SimpleAggregateFunction(min, Nullable(Float32))",
        "SimpleAggregateFunction(sum, Nullable(Int64))",
        "SimpleAggregateFunction(sum, UInt64)",
        "SimpleAggregateFunction(sum, Nullable(Float64))",
        "SimpleAggregateFunction(sumMap, Map(String, Float64))",
        "SimpleAggregateFunction(sum, UInt64)",
      ],
    );
  });

  it("issues only reads", async () => {
    for (const options of [RETAIL, POINTS, EVENTS]) {
      const { statements } = await run(options);
      assert.equal(statements.length, 3);
      for (const sql of statements) assert.match(sql, /^(SELECT|DESCRIBE) /);
    }
  });

  it("replicates on a cluster when asked to", async () => {
    const { definition } = await run({ ...RETAIL, cluster: "main" });
    assert.match(definition, /^CREATE TABLE IF NOT EXISTS gen_test\.retail_lines__agg_1day ON CLUSTER main\n\(/);
    assert.match(definition, /\nENGINE = ReplicatedAggregatingMergeTree\n/);
  });

  it("handles a table that keeps its metrics in maps", async () => {
    const { definition, leftOut, table } = await run(POINTS);
    assert.equal(table, "gen_test.series_points__agg_30minute");
    assert.deepEqual(rolesOf(definition), {
      partition: "group", timestamp: "time", period: "group", access: "group", unit: "group",
      revision: "sum", revision__count: "count", revision__min: "min", revision__max: "max",
      metrics: "sumMap", counters: "sumMap", _rows: "rows",
    });
    assert.match(definition, /\nPARTITION BY \(partition, toYYYYMM\(timestamp\)\)\n/);
    assert.doesNotMatch(definition, /\nSETTINGS /);
    assert.match(definition, /`timestamp` DateTime64\(3, 'UTC'\)/);
    assert.equal(leftOut.length, 20 - 4 - 1 - 3);
  });

  it("handles a very wide table built on arrays", async () => {
    const { definition, leftOut } = await run(EVENTS);
    const roles = rolesOf(definition);
    assert.deepEqual(
      Object.keys(roles).filter((name) => roles[name] === "sum"),
      ["duration_ms", "scroll_depth", "revenue", "amount", "sequence"],
    );
    assert.equal(roles.measurements, "sumMap");
    assert.ok(!Object.values(roles).includes("unusable"));
    assert.equal(leftOut.find(({ name }) => name === "product_prices").reason, "type cannot be summarised (Array(Nullable(Float64)))");
    assert.match(definition, /`amount` SimpleAggregateFunction\(sum, Decimal\(38, 4\)\)/);
    assert.match(definition, /\nSETTINGS allow_nullable_key = 1\n/); // is_bot is nullable
  });
});

describe("generate: what it prints besides the definition", () => {
  it("lists the left-out columns as a comment block after the definition", async () => {
    const result = await run(RETAIL);
    const text = render(result);
    assert.ok(text.startsWith(result.definition));
    assert.match(text, /\n\n-- Left out: source columns the aggregate does not carry\n--   entity_gid: not numeric and not in --group-by\n/);
    assert.equal(text.split("\n").filter((line) => line.startsWith("--   ")).length, result.leftOut.length);
  });

  it("prints the forced-merge statement for a source whose merges change what a read returns", async () => {
    const replacing = await run(RETAIL, { engine: "ReplicatedReplacingMergeTree", engine_full: "ReplicatedReplacingMergeTree('/p', '{replica}', loaded_at) PARTITION BY x ORDER BY y SETTINGS index_granularity = 8192" });
    assert.equal(
      replacing.forcedMerge,
      "ALTER TABLE gen_test.retail_lines MODIFY SETTING min_age_to_force_merge_seconds = 604800, min_age_to_force_merge_on_partition_only = 1;",
    );
    const text = render(replacing);
    assert.match(text, /\n-- The source is a ReplicatedReplacingMergeTree table/);
    assert.ok(text.trimEnd().endsWith(`--   ${replacing.forcedMerge}`));

    const onCluster = await run({ ...RETAIL, cluster: "main", minAge: "0 second" }, { engine: "ReplacingMergeTree", engine_full: "ReplacingMergeTree ORDER BY y" });
    assert.equal(
      onCluster.forcedMerge,
      "ALTER TABLE gen_test.retail_lines ON CLUSTER main MODIFY SETTING min_age_to_force_merge_seconds = 86400, min_age_to_force_merge_on_partition_only = 1;",
    );
  });

  it("prints no forced-merge statement when it is configured, or for a plain MergeTree", async () => {
    const configured = await run(RETAIL, {
      engine: "ReplicatedReplacingMergeTree",
      engine_full: "ReplicatedReplacingMergeTree('/p', '{replica}') ORDER BY y SETTINGS index_granularity = 8192, min_age_to_force_merge_seconds = 604800, min_age_to_force_merge_on_partition_only = 1",
    });
    assert.equal(configured.forcedMerge, null);
    const plain = await run(RETAIL);
    assert.equal(plain.forcedMerge, null);
    assert.doesNotMatch(render(plain), /MODIFY SETTING/);
    const replicatedPlain = await run(RETAIL, { engine: "ReplicatedMergeTree", engine_full: "ReplicatedMergeTree('/p', '{replica}') ORDER BY y" });
    assert.equal(replicatedPlain.forcedMerge, null);
  });
});

describe("generate: when it declines", () => {
  const declined = async (patch, tablePatch) => {
    const result = await run({ ...RETAIL, ...patch }, tablePatch);
    assert.equal(result.definition, undefined, JSON.stringify(patch));
    return result.declined;
  };

  it("names the table or column that does not exist", async () => {
    assert.equal(await declined({ source: "gen_test.nowhere" }), "the source table gen_test.nowhere does not exist");
    assert.equal(await declined({ timeColumn: "created" }), "the source has no column `created`");
    assert.equal(await declined({ groupBy: ["partition", "shop"] }), "the source has no column `shop`");
  });

  it("needs a date-time column that the source is partitioned by", async () => {
    assert.equal(await declined({ timeColumn: "business_day" }), "`business_day` is not a date-time column");
    assert.equal(await declined({ timeColumn: "delivered_at" }), "`delivered_at` is not a date-time column");
    assert.equal(await declined({ timeColumn: "loaded_at" }), "the source's partition expression does not involve `loaded_at`");
  });

  it("needs a grain that divides one day and nests inside the source's partitions", async () => {
    assert.equal(await declined({ grain: "7 hour" }), "the grain does not divide one day");
    assert.equal(await declined({ grain: "1 week" }), "--grain must be \"<n> <unit>\" with unit second, minute, hour or day");
    assert.equal(
      await declined({}, { partition_key: "(partition, toStartOfHour(timestamp))" }),
      "a grain of 1 day does not nest inside the source's partition expression",
    );
    assert.equal(
      await declined({}, { partition_key: "(partition, sipHash64(timestamp) % 16)" }),
      "cannot tell whether the grain nests inside the source's partition expression",
    );
    assert.equal(await run({ ...RETAIL, grain: "30 minute" }, { partition_key: "(partition, toStartOfHour(timestamp))" }).then((r) => r.declined), undefined);
  });

  it("needs grouping columns of a type that can be a key, including those the partition expression reads", async () => {
    assert.equal(await declined({ groupBy: ["partition", "metrics"] }), "`metrics` (Map(LowCardinality(String), Float32)) cannot be a grouping column");
    assert.equal(await declined({ groupBy: ["partition", "properties"] }), "`properties` (JSON) cannot be a grouping column");
    assert.equal(await declined({ groupBy: ["partition", "timestamp"] }), "`timestamp` is the time column and cannot also be a grouping column");
    assert.equal(await declined({ groupBy: ["store"] }), "the source's partition expression reads `partition`, which must be listed in --group-by");
    assert.equal(
      await declined({ source: "gen_test.wide_events", groupBy: ["partition", "product_ids"] }),
      "`product_ids` (Array(LowCardinality(String))) cannot be a grouping column",
    );
  });

  it("checks its options", async () => {
    assert.equal(await declined({ source: "retail_lines" }), "--source must be <database>.<table>");
    assert.equal(await declined({ minAge: "soon" }), "--min-age must be \"<n> <unit>\" with unit second, minute, hour or day");
    assert.equal(await declined({ maxStaleness: "0 second" }), "--max-staleness must be greater than zero");
    assert.equal(await declined({ cluster: "main; DROP" }), "--cluster must be a plain name");
    assert.equal(await declined({ groupBy: ["partition", "bad name"] }), "--group-by must be a list of plain column names");
  });
});
