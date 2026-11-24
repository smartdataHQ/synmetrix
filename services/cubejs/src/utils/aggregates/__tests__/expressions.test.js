import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classify, classifyBatch, memberExpression, parseAst } from "../expressions.js";

// Captured from ClickHouse 26.8 with fixtures/ast/capture.mjs: the tree of
// `EXPLAIN AST SELECT tuple(<e1>), tuple(<e2>), …` for the cases in cases.json.
const fixture = (name) => readFileSync(new URL(`./fixtures/ast/${name}`, import.meta.url), "utf8");
const CASES = JSON.parse(fixture("cases.json"));
const BATCH = fixture("batch.txt");
const batchRows = () => BATCH.trimEnd().split("\n").map((explain) => ({ explain }));

// K: grouping column, S: sum, M: summed map, T: the time column, X: unusable.
const COLUMNS = new Map(
  Object.entries({
    sold_location: "K", uom: "K", is_volume_pack: "K", bundled_units: "K", unit_size: "K",
    unit_price: "K", cart_id: "K",
    units: "S", net: "S", tax: "S", cost: "S",
    metrics: "M", timestamp: "T", note: "X",
  }),
);

describe("parseAst", () => {
  it("builds a tree from the indented dump", () => {
    const root = parseAst(
      [
        "SelectWithUnionQuery (children 1)",
        " ExpressionList (children 1)",
        "  SelectQuery (children 1)",
        "   ExpressionList (children 2)",
        "    Function multiply (children 1)",
        "     ExpressionList (children 2)",
        "      Identifier units (alias u)",
        "      Literal UInt64_1",
        "    Function now (children 1)",
        "     ExpressionList",
      ].join("\n"),
    );
    const select = root.children[0].children[0].children[0];
    assert.equal(select.children.length, 2);
    const [multiply, now] = select.children;
    assert.deepEqual(
      { type: multiply.type, name: multiply.name, args: multiply.children[0].children.map((n) => [n.type, n.name]) },
      { type: "Function", name: "multiply", args: [["Identifier", "units"], ["Literal", "UInt64_1"]] },
    );
    assert.equal(multiply.children[0].children[0].alias, "u");
    assert.deepEqual([now.name, now.children[0].children.length], ["now", 0]);
  });
});

describe("classifyBatch", () => {
  it("classifies every case with one statement", async () => {
    const statements = [];
    const queryFn = async (sql) => {
      statements.push(sql);
      return batchRows();
    };
    const results = await classifyBatch(queryFn, CASES.map(([, expression]) => expression), COLUMNS);

    assert.equal(statements.length, 1);
    assert.match(statements[0], /^SELECT explain FROM \(EXPLAIN AST SELECT .*\)$/s);
    for (const [, expression] of CASES) assert.ok(statements[0].includes(expression), expression);

    const actual = Object.fromEntries(
      CASES.map(([name], index) => [name, [results[index].cls, results[index].detail].filter(Boolean).join(":")]),
    );
    const expected = Object.fromEntries(
      CASES.map(([name, , cls, detail]) => [name, [cls, detail].filter(Boolean).join(":")]),
    );
    assert.deepEqual(actual, expected);
  });

  it("does not send an expression that still holds a template, and marks it unsupported", async () => {
    const statements = [];
    const queryFn = async (sql) => {
      statements.push(sql);
      return [
        "SelectWithUnionQuery (children 1)",
        " ExpressionList (children 1)",
        "  SelectQuery (children 1)",
        "   ExpressionList (children 1)",
        "    Function tuple (children 1)",
        "     ExpressionList (children 1)",
        "      Identifier units",
      ].map((explain) => ({ explain }));
    };
    const results = await classifyBatch(
      queryFn,
      [null, "units", "{FILTER_PARAMS.c.m.filter('x')}", "partition = {SECURITY_CONTEXT.p.unsafeValue()}"],
      COLUMNS,
    );
    assert.deepEqual(results.map((r) => `${r.cls}:${r.detail || ""}`), [
      "X:unsupported_member", "S:", "X:unsupported_member", "X:unsupported_member",
    ]);
    assert.equal(statements.length, 1);
    assert.doesNotMatch(statements[0], /FILTER_PARAMS|SECURITY_CONTEXT/);
  });

  it("sends nothing when there is nothing to parse", async () => {
    let calls = 0;
    const results = await classifyBatch(async () => { calls += 1; return []; }, [null], COLUMNS);
    assert.equal(calls, 0);
    assert.equal(results[0].cls, "X");
  });

  it("throws when the answer does not hold one tree per expression", async () => {
    const rows = batchRows();
    await assert.rejects(classifyBatch(async () => rows, ["units", "net"], COLUMNS));
    await assert.rejects(
      classifyBatch(
        async () => ["SelectWithUnionQuery (children 2)", " ExpressionList (children 1)"].map((explain) => ({ explain })),
        ["units"],
        COLUMNS,
      ),
    );
  });

  it("accepts the table ClickHouse adds to a SELECT without FROM, and no other", async () => {
    const tree = (table) =>
      [
        "SelectWithUnionQuery (children 1)",
        " ExpressionList (children 1)",
        "  SelectQuery (children 2)",
        "   ExpressionList (children 1)",
        "    Function tuple (children 1)",
        "     ExpressionList (children 1)",
        "      Identifier units",
        "   TablesInSelectQuery (children 1)",
        "    TablesInSelectQueryElement (children 1)",
        "     TableExpression (children 1)",
        `      TableIdentifier ${table}`,
      ].map((explain) => ({ explain }));
    assert.equal((await classifyBatch(async () => tree("system.one"), ["units"], COLUMNS))[0].cls, "S");
    await assert.rejects(classifyBatch(async () => tree("cst.sales_lines"), ["units"], COLUMNS));
  });

  it("keeps the parsed tree, so a caller can tell a plain column from an expression", async () => {
    const [plain, expression] = await classifyBatch(
      async () =>
        [
          "SelectWithUnionQuery (children 1)",
          " ExpressionList (children 1)",
          "  SelectQuery (children 1)",
          "   ExpressionList (children 2)",
          "    Function tuple (children 1)",
          "     ExpressionList (children 1)",
          "      Identifier timestamp",
          "    Function tuple (children 1)",
          "     ExpressionList (children 1)",
          "      Function toDate (children 1)",
          "       ExpressionList (children 1)",
          "        Identifier timestamp",
        ].map((explain) => ({ explain })),
      ["timestamp", "toDate(timestamp)"],
      COLUMNS,
    );
    assert.deepEqual([plain.node.type, plain.node.name], ["Identifier", "timestamp"]);
    assert.equal(expression.node.type, "Function");
  });
});

describe("classify", () => {
  const identifier = (name) => ({ type: "Identifier", name, children: [] });
  const fn = (name, ...args) => ({
    type: "Function", name, children: [{ type: "ExpressionList", children: args }],
  });

  it("treats a function without arguments as grouping-only", () => {
    assert.equal(classify(fn("now"), COLUMNS).cls, "K");
  });

  it("reports the unknown column before the shape of the expression", () => {
    assert.deepEqual(classify(fn("multiply", identifier("units"), identifier("gone")), COLUMNS), {
      cls: "X", detail: "column_not_in_aggregate",
    });
  });

  it("emits bare EXPLAIN AST when directExplain is true (avoids ClickHouse 26.10 CREATE TEMPORARY TABLE)", async () => {
    const statements = [];
    const results = await classifyBatch(
      async (sql) => {
        statements.push(sql);
        return [
          "SelectWithUnionQuery (children 1)",
          " ExpressionList (children 1)",
          "  SelectQuery (children 1)",
          "   ExpressionList (children 1)",
          "    Function tuple (children 1)",
          "     ExpressionList (children 1)",
          "      Identifier units",
        ].map((explain) => ({ explain }));
      },
      ["units"],
      COLUMNS,
      { directExplain: true },
    );
    assert.equal(statements.length, 1);
    assert.match(statements[0], /^EXPLAIN AST SELECT tuple\(\nunits\n\)$/);
    assert.equal(results[0].cls, "S");
  });

  const lit = (name) => ({ type: "Literal", name, children: [] });
  const DAY_GRAIN = { grainKind: "day", grainSeconds: 86400 };
  const MONTH_GRAIN = { grainKind: "month", grainSeconds: 2592000 };

  it("classifies linear conditional sums (if / multiIf) over K predicates and S or 0/NULL branches as S", () => {
    assert.equal(classify(fn("if", identifier("is_volume_pack"), identifier("units"), lit("UInt64_0")), COLUMNS).cls, "S");
    assert.equal(classify(fn("multiIf", fn("equals", identifier("uom"), lit("'kg'")), identifier("units"), lit("NULL")), COLUMNS).cls, "S");
    assert.equal(
      classify(
        fn("multiIf", fn("equals", identifier("uom"), lit("'kg'")), identifier("units"), fn("equals", identifier("uom"), lit("'l'")), identifier("net"), lit("Float64_0")),
        COLUMNS,
      ).cls,
      "S",
    );
    // A non-zero constant branch would sum once per aggregate row instead of per raw row.
    assert.deepEqual(
      classify(fn("if", identifier("is_volume_pack"), identifier("units"), lit("UInt64_1")), COLUMNS),
      { cls: "X", detail: "not_exact_when_summed" },
    );
    // A condition reading a summed column is not constant per bucket.
    assert.deepEqual(
      classify(fn("if", fn("greater", identifier("units"), lit("UInt64_0")), identifier("net"), lit("UInt64_0")), COLUMNS),
      { cls: "X", detail: "not_exact_when_summed" },
    );
  });

  it("classifies half-open grain-aligned time predicates in conditional sums as S only on compatible grains", () => {
    // CASE WHEN timestamp >= toStartOfYear(yesterday()) AND timestamp < toStartOfDay(now()) THEN units END
    const ytdDay = fn(
      "multiIf",
      fn(
        "and",
        fn("greaterOrEquals", identifier("timestamp"), fn("toStartOfYear", fn("yesterday"))),
        fn("less", identifier("timestamp"), fn("toStartOfDay", fn("now"))),
      ),
      identifier("units"),
      lit("NULL"),
    );
    // CASE WHEN timestamp >= subtractYears(toStartOfYear(yesterday()), 1) AND timestamp < subtractYears(toStartOfDay(now()), 1) THEN units END
    const priorYtdDay = fn(
      "multiIf",
      fn(
        "and",
        fn("greaterOrEquals", identifier("timestamp"), fn("subtractYears", fn("toStartOfYear", fn("yesterday")), lit("UInt64_1"))),
        fn("less", identifier("timestamp"), fn("subtractYears", fn("toStartOfDay", fn("now")), lit("UInt64_1"))),
      ),
      identifier("units"),
      lit("NULL"),
    );
    // Month-aligned: timestamp >= toStartOfYear(now()) AND timestamp < toStartOfMonth(now())
    const ytdMonth = fn(
      "multiIf",
      fn(
        "and",
        fn("greaterOrEquals", identifier("timestamp"), fn("toStartOfYear", fn("now"))),
        fn("less", identifier("timestamp"), fn("toStartOfMonth", fn("now"))),
      ),
      identifier("units"),
      lit("NULL"),
    );

    assert.equal(classify(ytdDay, COLUMNS, DAY_GRAIN).cls, "S");
    assert.equal(classify(priorYtdDay, COLUMNS, DAY_GRAIN).cls, "S");
    assert.deepEqual(classify(ytdDay, COLUMNS, MONTH_GRAIN), { cls: "X", detail: "reads_time_column" });
    assert.deepEqual(classify(priorYtdDay, COLUMNS, MONTH_GRAIN), { cls: "X", detail: "reads_time_column" });
    assert.equal(classify(ytdMonth, COLUMNS, DAY_GRAIN).cls, "S");
    assert.equal(classify(ytdMonth, COLUMNS, MONTH_GRAIN).cls, "S");
    // Without grain context, time reads remain rejected.
    assert.deepEqual(classify(ytdDay, COLUMNS), { cls: "X", detail: "reads_time_column" });

    // Symmetric forms: bound <= timestamp AND bound > timestamp
    const symmetric = fn(
      "multiIf",
      fn(
        "and",
        fn("lessOrEquals", lit("'2026-01-01'"), identifier("timestamp")),
        fn("greater", lit("'2026-02-01'"), identifier("timestamp")),
      ),
      identifier("units"),
      lit("NULL"),
    );
    assert.equal(classify(symmetric, COLUMNS, DAY_GRAIN).cls, "S");
    assert.equal(classify(symmetric, COLUMNS, MONTH_GRAIN).cls, "S");
  });

  it("rejects intra-day, non-UTC, and boundary-splitting time predicates", () => {
    // Intra-day <= now()
    const intraday = fn(
      "multiIf",
      fn(
        "and",
        fn("greaterOrEquals", identifier("timestamp"), fn("toStartOfYear", fn("now"))),
        fn("lessOrEquals", identifier("timestamp"), fn("now")),
      ),
      identifier("units"),
      lit("NULL"),
    );
    // T <= midnight splits bucket at 00:00:00.000
    const inclusiveEnd = fn("multiIf", fn("lessOrEquals", identifier("timestamp"), fn("toStartOfDay", fn("now"))), identifier("units"), lit("NULL"));
    // T > midnight splits bucket at 00:00:00.000
    const strictStart = fn("multiIf", fn("greater", identifier("timestamp"), fn("toStartOfDay", fn("now"))), identifier("units"), lit("NULL"));
    // Non-UTC timezone truncation
    const nonUtc = fn("multiIf", fn("less", identifier("timestamp"), fn("toStartOfDay", fn("now"), lit("'America/New_York'"))), identifier("units"), lit("NULL"));
    // Mid-day literal
    const midDayLit = fn("multiIf", fn("greaterOrEquals", identifier("timestamp"), lit("'2026-01-01 12:00:00'")), identifier("units"), lit("NULL"));

    for (const expr of [intraday, inclusiveEnd, strictStart, nonUtc, midDayLit]) {
      assert.deepEqual(classify(expr, COLUMNS, DAY_GRAIN), { cls: "X", detail: "reads_time_column" });
    }
  });
});

describe("memberExpression", () => {
  const cube = {
    name: "line_items",
    dimensions: [
      { name: "uom", sql: "{CUBE}.uom", type: "string" },
      { name: "is_bulk", sql: "{CUBE.uom} IN ('kg', 'l')", type: "boolean" },
      { name: "bulk_label", sql: "if({is_bulk}, 'bulk', 'piece')", type: "string" },
      { name: "loop_a", sql: "{loop_b}", type: "string" },
      { name: "loop_b", sql: "{CUBE.loop_a}", type: "string" },
      { name: "tier", type: "string", case: { when: [{ sql: "{CUBE}.units > 1", label: "many" }] } },
    ],
    measures: [{ name: "units", sql: "{CUBE}.units", type: "sum" }],
  };

  it("turns {CUBE}.col into the bare column", () => {
    assert.equal(memberExpression("{CUBE}.units * {CUBE}.unit_price", cube), "units * unit_price");
    assert.equal(memberExpression("{line_items}.units", cube), "units");
  });

  it("inlines references to other dimensions, recursively", () => {
    assert.equal(memberExpression("{bulk_label}", cube), "(if(((uom) IN ('kg', 'l')), 'bulk', 'piece'))");
  });

  it("gives up on anything else", () => {
    for (const sql of [
      "{FILTER_PARAMS.line_items.timestamp.filter('timestamp')}",
      "{SECURITY_CONTEXT.partition.unsafeValue()}",
      "{other_cube.id}",
      "{units}", // a measure, not a dimension
      "{tier}", // a case dimension has no single expression
      "{loop_a}",
      "{CUBE}.units }",
      undefined,
    ]) {
      assert.equal(memberExpression(sql, cube), null, String(sql));
    }
  });
});
