import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";

import { deriveCube, sourceTableOf, variantKey } from "../derive.js";
import { classifyBatch } from "../expressions.js";
import { replay } from "./fixtures/ast/replay.js";
import { COLUMNS, structure } from "./fixtures/salesAggregate.js";

const MODEL = YAML.parse(readFileSync(new URL("./fixtures/sales_model.yml", import.meta.url), "utf8"));
const CUBE = MODEL.cubes[0];

/** Derives with ClickHouse's recorded parse trees and counts the statements issued. */
async function derive(cube, target = structure(), options) {
  let statements = 0;
  const classify = (expressions, columns) =>
    classifyBatch(async (sql) => { statements += 1; return replay(sql); }, expressions, columns);
  const derived = await deriveCube(cube, target, classify, "sv1", options);
  const parsed = derived.files.length ? YAML.parse(derived.files[0].content).cubes[0] : null;
  const member = (kind, name) => parsed?.[kind]?.find((entry) => entry.name === name);
  return { derived, parsed, member, statements };
}

const canonical = (kind, name) => CUBE[kind].find((entry) => entry.name === name);
const withCube = (patch) => ({ ...CUBE, ...patch });
const withMember = (kind, definition) => ({
  name: "line_items",
  sql: "SELECT * FROM agg_test.sales",
  dimensions: [{ name: "timestamp", sql: "{CUBE}.timestamp", type: "time" }],
  [kind]: [...(kind === "dimensions" ? [{ name: "timestamp", sql: "{CUBE}.timestamp", type: "time" }] : []), definition],
});

describe("deriveCube: an eligible cube", () => {
  it("keeps the cube name and reads the aggregate table instead of the source, and nothing else changes", async () => {
    const { derived, parsed, statements } = await derive(CUBE);
    assert.equal(derived.ineligible, null);
    assert.equal(derived.cube, "line_items");
    assert.equal(derived.aggregate, "agg_test.sales__agg_1day");
    assert.equal(parsed.name, "line_items");
    assert.equal(
      parsed.sql,
      "SELECT * REPLACE (if(is_volume_pack, 'yes', 'no') AS is_volume_pack, " +
        "(toFloat64(units * ifNull(bundled_units, 1)) * if(uom IN ('d', 'wk'), toFloat64(unit_size * transform(uom, ['d', 'wk'], [1, 7], 1)), 1)) AS quantity) " +
        "FROM agg_test.sales__agg_1day WHERE partition = 't1' SETTINGS asterisk_include_alias_columns = 1",
    );
    assert.equal(statements, 1); // one round trip per cube
    assert.equal(derived.files.length, 1);
    assert.equal(YAML.parse(derived.files[0].content).cubes.length, 1);
  });

  it("removes a REPLACE item whose target the aggregate lacks", async () => {
    const { parsed } = await derive(CUBE);
    assert.doesNotMatch(parsed.sql, /checkout_id/);
  });

  it("copies title, description and meta of the cube, and drops joins", async () => {
    const { parsed } = await derive(withCube({ joins: [{ name: "stores", sql: "{CUBE}.sold_location = {stores}.id", relationship: "many_to_one" }] }));
    assert.deepEqual(
      [parsed.title, parsed.description, parsed.meta, parsed.joins],
      ["Line Items", "Sales lines of one tenant.", { source_table: "sales" }, undefined],
    );
  });

  it("keeps dimensions and segments that read grouping columns only", async () => {
    const { parsed, member, derived } = await derive(CUBE);
    assert.deepEqual(
      parsed.dimensions.map((dimension) => dimension.name),
      ["partition", "sold_location", "main_category", "product_id", "uom", "is_volume_pack", "is_time_unit", "price_tier", "timestamp"],
    );
    assert.deepEqual(member("dimensions", "sold_location"), canonical("dimensions", "sold_location"));
    assert.deepEqual(member("dimensions", "price_tier"), canonical("dimensions", "price_tier"));
    assert.deepEqual(member("dimensions", "timestamp"), canonical("dimensions", "timestamp"));
    assert.deepEqual(parsed.segments, [canonical("segments", "store0")]);
    assert.deepEqual([...derived.timeMembers], ["line_items.timestamp"]);
  });

  it("keeps a sum whose expression is exact when summed, with its title, format and meta", async () => {
    const { member } = await derive(CUBE);
    for (const name of ["units", "quantity", "gross_revenue", "weight", "store0_units", "units_this_year"]) {
      assert.deepEqual(member("measures", name), canonical("measures", name), name);
    }
  });

  it("counts rows from the stored row count, and gives 0 when a filter matches nothing", async () => {
    const { member } = await derive(CUBE);
    assert.deepEqual(member("measures", "count"), { name: "count", type: "number", sql: "sum({CUBE}._rows)" });
    assert.deepEqual(member("measures", "store0_lines"), {
      name: "store0_lines",
      type: "number",
      sql: "sumIf({CUBE}._rows, ({CUBE}.sold_location = 'store0'))",
    });
  });

  it("averages from the stored sum and non-null count", async () => {
    const { member } = await derive(CUBE);
    assert.deepEqual(member("measures", "avg_units"), {
      name: "avg_units",
      sql: "toFloat64(sum({CUBE}.units)) / nullIf(sum({CUBE}.units__count), 0)",
      type: "number",
      title: "Average Units",
    });
    assert.equal(member("measures", "avg_discount").sql, "toFloat64(sum({CUBE}.discount)) / nullIf(sum({CUBE}.discount__count), 0)");
    assert.equal(
      member("measures", "store0_avg_units").sql,
      "toFloat64(sumIf({CUBE}.units, ({CUBE}.sold_location = 'store0'))) / nullIf(sumIf({CUBE}.units__count, ({CUBE}.sold_location = 'store0')), 0)",
    );
    assert.equal(member("measures", "store0_avg_units").filters, undefined);
  });

  it("averages one key of a summed map over the row count", async () => {
    const { member } = await derive(CUBE);
    assert.deepEqual(member("measures", "avg_weight"), {
      name: "avg_weight",
      sql: "toFloat64(sum({CUBE}.metrics['weight'])) / nullIf(sum({CUBE}._rows), 0)",
      type: "number",
    });
  });

  it("reads minimum and maximum from the stored fields, or unchanged over a grouping column", async () => {
    const { member } = await derive(CUBE);
    assert.deepEqual(member("measures", "min_units"), { name: "min_units", sql: "{CUBE}.units__min", type: "min" });
    assert.deepEqual(member("measures", "max_units"), { name: "max_units", sql: "{CUBE}.units__max", type: "max" });
    assert.deepEqual(member("measures", "max_price"), canonical("measures", "max_price"));
  });

  it("keeps distinct counts over grouping columns and a calculation over derived measures", async () => {
    const { member } = await derive(CUBE);
    assert.deepEqual(member("measures", "unique_products"), canonical("measures", "unique_products"));
    assert.deepEqual(member("measures", "approx_products"), canonical("measures", "approx_products"));
    assert.deepEqual(member("measures", "store0_share"), canonical("measures", "store0_share"));
  });

  it("lists what is available under the cube's own member names", async () => {
    const { derived } = await derive(CUBE);
    for (const name of ["sold_location", "timestamp", "store0", "units", "avg_units", "count", "approx_products", "store0_share"]) {
      assert.ok(derived.available.has(`line_items.${name}`), name);
    }
    assert.equal(derived.available.size, 9 + 1 + 18);
  });

  it("derives a cube that names its table with sql_table", async () => {
    const { derived, parsed } = await derive({
      name: "line_items",
      sql_table: "agg_test.sales",
      dimensions: [{ name: "timestamp", sql: "{CUBE}.timestamp", type: "time" }],
      measures: [{ name: "units", sql: "{CUBE}.units", type: "sum" }],
    });
    assert.equal(derived.ineligible, null);
    assert.equal(parsed.sql_table, "agg_test.sales__agg_1day");
    assert.equal(parsed.sql, undefined);
  });

  it("resolves an unqualified table with the connection's database", async () => {
    const cube = withCube({ sql: "SELECT * FROM sales WHERE partition = 't1'" });
    assert.equal((await derive(cube, structure(), { defaultDatabase: "agg_test" })).derived.ineligible, null);
    assert.equal((await derive(cube)).derived.ineligible, "not_plain_read");
    assert.equal(sourceTableOf(cube, "agg_test"), "agg_test.sales");
    assert.equal(sourceTableOf(CUBE), "agg_test.sales");
    assert.equal(sourceTableOf({ name: "x", sql_table: "`agg_test`.`sales`" }), "agg_test.sales");
    assert.equal(sourceTableOf({ name: "x", sql: "SELECT 1" }), null);
  });
});

describe("variantKey", () => {
  it("is stable, and changes with the schema version, the aggregate and its structure", async () => {
    const target = structure();
    const base = variantKey("sv1", "line_items", target);
    assert.match(base, /^[a-f0-9]{32}$/);
    assert.equal(base, variantKey("sv1", "line_items", structure()));
    assert.equal((await derive(CUBE)).derived.variantKey, base);
    assert.notEqual(base, variantKey("sv2", "line_items", target));
    assert.notEqual(base, variantKey("sv1", "other", target));
    assert.notEqual(base, variantKey("sv1", "line_items", structure(COLUMNS, "sales__agg_30minute")));
    assert.notEqual(base, variantKey("sv1", "line_items", structure(COLUMNS.slice(0, -1))));
  });
});

describe("deriveCube: a cube that is not eligible", () => {
  const ineligible = async (cube, options) => {
    const { derived, statements } = await derive(cube, structure(), options);
    assert.deepEqual([derived.files, derived.available.size], [[], 0]);
    return [derived.ineligible, statements];
  };

  it("is not a YAML cube", async () => {
    assert.deepEqual(await ineligible(null), ["not_yaml", 0]);
  });

  it("extends another cube, or declares pre-aggregations", async () => {
    assert.deepEqual(await ineligible(withCube({ extends: "base" })), ["extends", 0]);
    assert.deepEqual(
      await ineligible(withCube({ pre_aggregations: [{ name: "main", measures: ["CUBE.units"] }] })),
      ["pre_aggregations", 0],
    );
  });

  it("does not read its source with a single plain SELECT *", async () => {
    const cases = {
      final: "SELECT * FROM agg_test.sales FINAL WHERE partition = 't1'",
      join: "SELECT * FROM agg_test.sales AS s JOIN agg_test.stores AS t ON s.sold_location = t.id",
      union: "SELECT * FROM agg_test.sales UNION ALL SELECT * FROM agg_test.sales",
      nested: "SELECT * FROM (SELECT * FROM agg_test.sales)",
      grouped: "SELECT * FROM agg_test.sales WHERE partition = 't1' GROUP BY partition",
      columns: "SELECT partition, units FROM agg_test.sales",
      except: "SELECT * EXCEPT (checkout_id) FROM agg_test.sales",
      limit: "SELECT * FROM agg_test.sales LIMIT 10",
      final_setting: "SELECT * FROM agg_test.sales SETTINGS final = 1",
      comment: "SELECT * FROM agg_test.sales -- WHERE partition = 't1'",
      other_table: "SELECT * FROM agg_test.returns",
      not_a_select: "agg_test.sales",
      bad_replace: "SELECT * REPLACE (units) FROM agg_test.sales",
    };
    for (const [label, sql] of Object.entries(cases)) {
      assert.deepEqual(await ineligible(withCube({ sql })), ["not_plain_read", 0], label);
    }
    assert.deepEqual(await ineligible({ ...CUBE, sql: undefined }), ["not_plain_read", 0]);
    assert.deepEqual(await ineligible({ ...CUBE, sql: undefined, sql_table: "agg_test.returns" }), ["not_plain_read", 0]);
  });

  it("filters its source on something other than grouping columns", async () => {
    for (const where of ["units > 0", "checkout_id != ''", "partition = {SECURITY_CONTEXT.partition.unsafeValue()}", "timestamp >= '2026-01-01'"]) {
      const [reason] = await ineligible(withCube({ sql: `SELECT * FROM agg_test.sales WHERE ${where}` }));
      assert.equal(reason, "predicate_not_grouping", where);
    }
  });
});

describe("deriveCube: members that stay on the source", () => {
  it("leaves each one out with its reason", async () => {
    const { derived, parsed } = await derive(CUBE);
    assert.deepEqual(Object.fromEntries(derived.leftOut), {
      "line_items.checkout_id": "column_not_in_aggregate",
      "line_items.sale_date": "reads_time_column",
      "line_items.big_line": "not_grouping_column",
      "line_items.big_lines": "not_grouping_column",
      "line_items.transactions": "column_not_in_aggregate",
      "line_items.units_times_discount": "not_exact_when_summed",
      "line_items.big_line_count": "not_grouping_column",
      "line_items.avg_quantity": "no_stored_field",
      "line_items.min_weight": "no_stored_field",
      "line_items.rolling_units": "unsupported_member",
      "line_items.units_per_transaction": "depends_on_unavailable_member",
      "line_items.raw_ratio": "unsupported_member",
      "line_items.non_null_discounts": "unsupported_member",
    });
    for (const member of derived.leftOut.keys()) assert.ok(!derived.available.has(member), member);
    assert.ok(!parsed.measures.some((measure) => measure.name === "transactions"));
  });

  it("gives a reason per kind of member", async () => {
    const cases = [
      ["measures", { name: "m", sql: "{CUBE}.units", type: "sum", multi_stage: true }, "unsupported_member"],
      ["measures", { name: "m", sql: "{CUBE}.units", type: "sum", time_shift: [{ interval: "1 year", type: "prior" }] }, "unsupported_member"],
      ["measures", { name: "m", sql: "{CUBE}.unit_price", type: "sum" }, "not_exact_when_summed"],
      ["measures", { name: "m", sql: "{CUBE}.units", type: "count_distinct" }, "not_grouping_column"],
      ["measures", { name: "m", sql: "{CUBE}.discount", type: "max" }, "no_stored_field"],
      ["measures", { name: "m", sql: "{CUBE}.nowhere", type: "avg" }, "column_not_in_aggregate"],
      ["measures", { name: "m", sql: "{CUBE}.units + {CUBE}.discount", type: "avg" }, "no_stored_field"],
      ["measures", { name: "m", sql: "{CUBE}.units", type: "sum", filters: [{ sql: "{CUBE}.nowhere = 1" }] }, "column_not_in_aggregate"],
      ["measures", { name: "m", sql: "{other.total} + 1", type: "number" }, "depends_on_unavailable_member"],
      ["measures", { name: "m", sql: "{m}", type: "number" }, "depends_on_unavailable_member"],
      ["measures", { name: "m", sql: "{FILTER_PARAMS.line_items.timestamp.filter('x')}", type: "sum" }, "unsupported_member"],
      ["dimensions", { name: "d", sql: "{CUBE}.id", type: "string", sub_query: true }, "unsupported_member"],
      ["dimensions", { name: "d", type: "geo", latitude: { sql: "{CUBE}.lat" }, longitude: { sql: "{CUBE}.lon" } }, "unsupported_member"],
      ["dimensions", { name: "d", type: "string", case: { when: [{ sql: "{CUBE}.units > 1", label: "many" }], else: { label: "one" } } }, "not_grouping_column"],
      ["segments", { name: "s", sql: "{CUBE}.nowhere = 1" }, "column_not_in_aggregate"],
    ];
    for (const [kind, definition, expected] of cases) {
      const { derived } = await derive(withMember(kind, definition));
      assert.equal(derived.leftOut.get(`line_items.${definition.name}`), expected, JSON.stringify(definition));
    }
  });

  it("leaves out a measure whose drill members are not all available, and keeps one whose are", async () => {
    const measure = (drill) => ({ name: "m", sql: "{CUBE}.units", type: "sum", drill_members: drill });
    const cube = (drill) => ({
      name: "line_items",
      sql: "SELECT * FROM agg_test.sales",
      dimensions: [
        { name: "timestamp", sql: "{CUBE}.timestamp", type: "time" },
        { name: "uom", sql: "{CUBE}.uom", type: "string" },
        { name: "checkout_id", sql: "{CUBE}.checkout_id", type: "string" },
      ],
      measures: [measure(drill)],
    });
    const kept = await derive(cube(["uom", "CUBE.timestamp", "line_items.uom"]));
    assert.deepEqual(kept.member("measures", "m"), measure(["uom", "CUBE.timestamp", "line_items.uom"]));
    const left = await derive(cube(["uom", "checkout_id"]));
    assert.equal(left.derived.leftOut.get("line_items.m"), "depends_on_unavailable_member");
  });

  it("needs the stored row count for counts and map averages", async () => {
    const { derived } = await derive(CUBE, structure(COLUMNS.filter((column) => column.name !== "_rows")));
    assert.equal(derived.leftOut.get("line_items.count"), "no_stored_field");
    assert.equal(derived.leftOut.get("line_items.avg_weight"), "no_stored_field");
    assert.equal(derived.leftOut.get("line_items.store0_share"), "depends_on_unavailable_member");
  });

  it("makes the target of an unsafe REPLACE item unusable and drops the item", async () => {
    const cube = withCube({
      sql: "SELECT * REPLACE (units * discount AS units, upper(uom) AS uom) FROM agg_test.sales WHERE partition = 't1'",
    });
    const { derived, parsed } = await derive(cube);
    assert.equal(parsed.sql, "SELECT * REPLACE (upper(uom) AS uom) FROM agg_test.sales__agg_1day WHERE partition = 't1'");
    assert.equal(derived.leftOut.get("line_items.units"), "column_not_in_aggregate");
    assert.ok(derived.available.has("line_items.uom"));
  });

  it("does not trust a REPLACE item that reads the target of another one", async () => {
    const cube = withCube({
      sql: "SELECT * REPLACE (upper(uom) AS uom, concat(uom, product_id) AS product_id) FROM agg_test.sales",
    });
    const { derived } = await derive(cube);
    assert.equal(derived.leftOut.get("line_items.product_id"), "column_not_in_aggregate");
    assert.ok(derived.available.has("line_items.uom"));
  });

  it("leaves the time dimension out when the cube rewrites the time column", async () => {
    const cube = withCube({ sql: "SELECT * REPLACE (toStartOfHour(timestamp) AS timestamp) FROM agg_test.sales" });
    const { derived } = await derive(cube);
    assert.equal(derived.leftOut.get("line_items.timestamp"), "reads_time_column");
    assert.deepEqual([...derived.timeMembers], []);
  });

  it("derives day-aligned YoY conditional sums and their ratio on 1-day aggregates, but rejects them on 1-month or when intra-day", async () => {
    const ytdAst = () => [
      "SelectWithUnionQuery (children 1)",
      " ExpressionList (children 1)",
      "  SelectQuery (children 1)",
      "   ExpressionList (children 5)",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier timestamp",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Function multiIf (children 1)",
      "       ExpressionList (children 3)",
      "        Function and (children 1)",
      "         ExpressionList (children 2)",
      "          Function greaterOrEquals (children 1)",
      "           ExpressionList (children 2)",
      "            Identifier timestamp",
      "            Function toStartOfYear (children 1)",
      "             ExpressionList (children 1)",
      "              Function yesterday (children 1)",
      "               ExpressionList",
      "          Function less (children 1)",
      "           ExpressionList (children 2)",
      "            Identifier timestamp",
      "            Function toStartOfDay (children 1)",
      "             ExpressionList (children 1)",
      "              Function now (children 1)",
      "               ExpressionList",
      "        Identifier units",
      "        Literal NULL",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Function multiIf (children 1)",
      "       ExpressionList (children 3)",
      "        Function and (children 1)",
      "         ExpressionList (children 2)",
      "          Function greaterOrEquals (children 1)",
      "           ExpressionList (children 2)",
      "            Identifier timestamp",
      "            Function subtractYears (children 1)",
      "             ExpressionList (children 2)",
      "              Function toStartOfYear (children 1)",
      "               ExpressionList (children 1)",
      "                Function yesterday (children 1)",
      "                 ExpressionList",
      "              Literal UInt64_1",
      "          Function less (children 1)",
      "           ExpressionList (children 2)",
      "            Identifier timestamp",
      "            Function subtractYears (children 1)",
      "             ExpressionList (children 2)",
      "              Function toStartOfDay (children 1)",
      "               ExpressionList (children 1)",
      "                Function now (children 1)",
      "                 ExpressionList",
      "              Literal UInt64_1",
      "        Identifier units",
      "        Literal NULL",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Function divide (children 1)",
      "       ExpressionList (children 2)",
      "        Function minus (children 1)",
      "         ExpressionList (children 2)",
      "          Literal UInt64_1",
      "          Literal UInt64_1",
      "        Function nullIf (children 1)",
      "         ExpressionList (children 2)",
      "          Literal UInt64_1",
      "          Literal UInt64_0",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Function multiIf (children 1)",
      "       ExpressionList (children 3)",
      "        Function lessOrEquals (children 1)",
      "         ExpressionList (children 2)",
      "          Identifier timestamp",
      "          Function now (children 1)",
      "           ExpressionList",
      "        Identifier units",
      "        Literal NULL",
    ].map((explain) => ({ explain }));
    const yoyCube = {
      name: "line_items",
      sql: "SELECT * FROM agg_test.sales",
      dimensions: [{ name: "timestamp", sql: "{CUBE}.timestamp", type: "time" }],
      measures: [
        { name: "ytd", sql: "CASE WHEN {CUBE}.timestamp >= toStartOfYear(yesterday()) AND {CUBE}.timestamp < toStartOfDay(now()) THEN {CUBE}.units END", type: "sum" },
        { name: "prior_ytd", sql: "CASE WHEN {CUBE}.timestamp >= subtractYears(toStartOfYear(yesterday()), 1) AND {CUBE}.timestamp < subtractYears(toStartOfDay(now()), 1) THEN {CUBE}.units END", type: "sum" },
        { name: "yoy_pct", sql: "({ytd} - {prior_ytd}) / nullIf({prior_ytd}, 0)", type: "number" },
        { name: "intraday_ytd", sql: "CASE WHEN {CUBE}.timestamp <= now() THEN {CUBE}.units END", type: "sum" },
      ],
    };
    const classify = (expressions, columns) => classifyBatch(async () => ytdAst(), expressions, columns);

    const dayDerived = await deriveCube(yoyCube, structure(), classify, "sv1");
    assert.ok(dayDerived.available.has("line_items.ytd"));
    assert.ok(dayDerived.available.has("line_items.prior_ytd"));
    assert.ok(dayDerived.available.has("line_items.yoy_pct"));
    assert.equal(dayDerived.leftOut.get("line_items.intraday_ytd"), "reads_time_column");

    const monthStructure = { ...structure(COLUMNS, "sales__agg_1month"), grain: "1 month", grainKind: "month", grainSeconds: 2592000 };
    const monthDerived = await deriveCube(yoyCube, monthStructure, classify, "sv1");
    assert.equal(monthDerived.leftOut.get("line_items.ytd"), "reads_time_column");
    assert.equal(monthDerived.leftOut.get("line_items.prior_ytd"), "reads_time_column");
    assert.equal(monthDerived.leftOut.get("line_items.yoy_pct"), "depends_on_unavailable_member");
  });

  it("derives count_distinct_approx from stored uniq sketches (plain, filtered, and derived calculations) and respects REPLACE", async () => {
    const withSketches = structure([
      ...COLUMNS,
      { name: "external_order_id__uniq", type: "AggregateFunction(uniq, String)", is_in_sorting_key: 0 },
      { name: "checkout_id__uniq", type: "AggregateFunction(uniq, String)", is_in_sorting_key: 0 },
    ]);
    const sketchAst = () => [
      "SelectWithUnionQuery (children 1)",
      " ExpressionList (children 1)",
      "  SelectQuery (children 1)",
      "   ExpressionList (children 11)",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier timestamp",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier units",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier external_order_id",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Function equals (children 1)",
      "       ExpressionList (children 2)",
      "        Identifier sold_location",
      "        Literal 'store0'",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier external_order_id",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier checkout_id",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Function divide (children 1)",
      "       ExpressionList (children 2)",
      "        Literal UInt64_1",
      "        Function nullIf (children 1)",
      "         ExpressionList (children 2)",
      "          Literal UInt64_1",
      "          Literal UInt64_0",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier customer_id",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier units",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Function greater (children 1)",
      "       ExpressionList (children 2)",
      "        Identifier units",
      "        Literal UInt64_2",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier external_order_id",
    ].map((explain) => ({ explain }));

    const cube = {
      name: "line_items",
      sql: "SELECT * FROM agg_test.sales",
      dimensions: [{ name: "timestamp", sql: "{CUBE}.timestamp", type: "time" }],
      measures: [
        { name: "units", sql: "{CUBE}.units", type: "sum" },
        { name: "orders", sql: "{CUBE}.external_order_id", type: "count_distinct_approx", title: "Unique Orders" },
        {
          name: "store0_orders",
          sql: "{CUBE}.external_order_id",
          type: "count_distinct_approx",
          filters: [{ sql: "{CUBE}.sold_location = 'store0'" }],
        },
        { name: "transactions", sql: "{CUBE}.checkout_id", type: "count_distinct_approx" },
        { name: "units_per_order", sql: "{units} / nullIf({orders}, 0)", type: "number" },
        { name: "customers", sql: "{CUBE}.customer_id", type: "count_distinct_approx" },
        { name: "approx_units", sql: "{CUBE}.units", type: "count_distinct_approx" },
        {
          name: "big_orders",
          sql: "{CUBE}.external_order_id",
          type: "count_distinct_approx",
          filters: [{ sql: "{CUBE}.units > 2" }],
        },
      ],
    };
    const classify = (expressions, columns) => classifyBatch(async () => sketchAst(), expressions, columns);
    const derived = await deriveCube(cube, withSketches, classify, "sv1");
    const parsed = YAML.parse(derived.files[0].content).cubes[0];
    const m = (name) => parsed.measures.find((entry) => entry.name === name);

    assert.deepEqual(m("orders"), {
      name: "orders",
      sql: "uniqMerge({CUBE}.external_order_id__uniq)",
      type: "number",
      title: "Unique Orders",
    });
    assert.deepEqual(m("store0_orders"), {
      name: "store0_orders",
      sql: "uniqMergeIf({CUBE}.external_order_id__uniq, ({CUBE}.sold_location = 'store0'))",
      type: "number",
    });
    assert.deepEqual(m("transactions"), {
      name: "transactions",
      sql: "uniqMerge({CUBE}.checkout_id__uniq)",
      type: "number",
    });
    assert.deepEqual(m("units_per_order"), {
      name: "units_per_order",
      sql: "{units} / nullIf({orders}, 0)",
      type: "number",
    });
    assert.equal(derived.leftOut.get("line_items.customers"), "column_not_in_aggregate");
    assert.equal(derived.leftOut.get("line_items.approx_units"), "not_grouping_column");
    assert.equal(derived.leftOut.get("line_items.big_orders"), "not_grouping_column");

    // When the cube rewrites a column in REPLACE, do not use the pre-REPLACE sketch.
    const replacedAst = () => [
      "SelectWithUnionQuery (children 1)",
      " ExpressionList (children 1)",
      "  SelectQuery (children 1)",
      "   ExpressionList (children 3)",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Function nullIf (children 1)",
      "       ExpressionList (children 2)",
      "        Identifier checkout_id",
      "        Literal ''",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier timestamp",
      "    Function tuple (children 1)",
      "     ExpressionList (children 1)",
      "      Identifier checkout_id",
    ].map((explain) => ({ explain }));
    const replacedCube = {
      name: "line_items",
      sql: "SELECT * REPLACE (nullIf(checkout_id, '') AS checkout_id) FROM agg_test.sales",
      dimensions: [{ name: "timestamp", sql: "{CUBE}.timestamp", type: "time" }],
      measures: [{ name: "transactions", sql: "{CUBE}.checkout_id", type: "count_distinct_approx" }],
    };
    const replacedDerived = await deriveCube(
      replacedCube,
      withSketches,
      (expressions, columns) => classifyBatch(async () => replacedAst(), expressions, columns),
      "sv1",
    );
    assert.equal(replacedDerived.leftOut.get("line_items.transactions"), "column_not_in_aggregate");
  });
});
