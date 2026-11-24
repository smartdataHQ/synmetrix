import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyColumns,
  fillSelect,
  parseBinding,
  parseInterval,
  structureFingerprint,
} from "../contract.js";

const BINDING = {
  aggregate_of: "cst.sales_lines",
  time_column: "timestamp",
  grain: "1 day",
  min_age: "7 day",
  min_window: "60 day",
  max_staleness: "1 day",
};
const comment = (patch = {}) => JSON.stringify({ ...BINDING, ...patch });
const col = (name, type, key = 0) => ({ name, type, is_in_sorting_key: key });
const saf = (fn, type) => `SimpleAggregateFunction(${fn}, ${type})`;

describe("parseInterval", () => {
  it("reads '<n> <unit>' for second, minute, hour and day", () => {
    assert.equal(parseInterval("30 minute").seconds, 1800);
    assert.equal(parseInterval("1 day").seconds, 86400);
    assert.equal(parseInterval("0 second").seconds, 0);
    assert.equal(parseInterval("2 hour").seconds, 7200);
  });

  it("rejects everything else", () => {
    for (const text of ["1 week", "1 month", "day", "1day", "1 days", "-1 day", "1.5 hour", "", null, 5]) {
      assert.equal(parseInterval(text), null, String(text));
    }
  });
});

describe("parseBinding", () => {
  it("accepts exactly the six fields", () => {
    const { binding, reason } = parseBinding(comment());
    assert.equal(reason, undefined);
    assert.deepEqual(binding, {
      source: "cst.sales_lines",
      database: "cst",
      sourceTable: "sales_lines",
      timeColumn: "timestamp",
      grain: "1 day",
      grainSeconds: 86400,
      minAgeSeconds: 7 * 86400,
      minWindowSeconds: 60 * 86400,
      maxStalenessSeconds: 86400,
    });
  });

  it("lets min_age be zero", () => {
    assert.equal(parseBinding(comment({ min_age: "0 second" })).binding.minAgeSeconds, 0);
  });

  it("rejects a missing, extra or malformed field", () => {
    const { time_column: _dropped, ...missing } = BINDING;
    const bad = [
      JSON.stringify(missing),
      comment({ timezone: "UTC" }),
      comment({ aggregate_of: "sales_lines" }),
      comment({ aggregate_of: "cst.sales lines" }),
      comment({ time_column: "time stamp" }),
      comment({ grain: "7 hour" }), // does not divide a day
      comment({ grain: "0 second" }),
      comment({ grain: "1 week" }),
      comment({ max_staleness: "0 second" }),
      comment({ min_window: "soon" }),
      comment({ min_age: 7 }),
      "not json",
      "[]",
      "",
      null,
    ];
    for (const text of bad) {
      assert.deepEqual(parseBinding(text), { reason: "invalid_binding" }, String(text));
    }
  });
});

describe("classifyColumns", () => {
  const { binding } = parseBinding(comment());
  const roles = (columns) =>
    Object.fromEntries([...classifyColumns(columns, binding)].map(([name, c]) => [name, c.role]));

  it("reads every role from name, type and sorting key", () => {
    assert.deepEqual(
      roles([
        col("partition", "LowCardinality(String)", 1),
        col("timestamp", "DateTime64(3)", 1),
        col("unit_price", "Nullable(Float64)", 1),
        col("units", saf("sum", "Float64")),
        col("units__count", saf("sum", "UInt64")),
        col("units__min", saf("min", "Float32")),
        col("units__max", saf("max", "Float32")),
        col("metrics", saf("sumMap", "Map(String, Float64)")),
        col("checkout_id__uniq", "AggregateFunction(uniq, String)"),
        col("_rows", saf("sum", "UInt64")),
      ]),
      {
        partition: "group",
        timestamp: "time",
        unit_price: "group",
        units: "sum",
        units__count: "count",
        units__min: "min",
        units__max: "max",
        metrics: "sumMap",
        checkout_id__uniq: "uniq",
        _rows: "rows",
      },
    );
  });

  it("links a suffixed column to its sum or source column", () => {
    const columns = classifyColumns(
      [
        col("units", saf("sum", "Float64")),
        col("units__count", saf("sum", "UInt64")),
        col("checkout_id__uniq", "AggregateFunction(uniq, String)"),
        col("external_order_id__uniq", "AggregateFunction(1, uniq, String)"),
        col("customer_id__uniq", "AggregateFunction(uniq, Nullable(String))"),
      ],
      binding,
    );
    assert.equal(columns.get("units__count").of, "units");
    assert.equal(columns.get("checkout_id__uniq").of, "checkout_id");
    assert.equal(columns.get("external_order_id__uniq").role, "uniq");
    assert.equal(columns.get("external_order_id__uniq").of, "external_order_id");
    assert.equal(columns.get("customer_id__uniq").of, "customer_id");
  });

  it("marks what fits no role as unusable, without rejecting anything", () => {
    assert.deepEqual(
      roles([
        col("timestamp", "DateTime64(3)", 1),
        col("note", "String", 0), // plain column outside the sorting key
        col("price__count", saf("sum", "UInt64")), // no sum column `price`
        col("price__min", saf("min", "Float64")),
        col("latest", saf("max", "Float64")), // not a sum under a bare name
        col("buyers", "AggregateFunction(uniq, String)"), // no __uniq suffix
        col("__uniq", "AggregateFunction(uniq, String)"), // empty source column name
        col("buyers__uniq", "AggregateFunction(uniqExact, String)"), // wrong aggregate function
        col("units", saf("sum", "Float64")),
        col("units__count", saf("sum", "UInt32")), // count must be UInt64
        col("units__min", saf("max", "Float64")), // wrong function for the suffix
        col("_rows", saf("sum", "UInt32")),
        col("tags", saf("sumMap", "Map(LowCardinality(String), Float64)")),
        col("maybe", saf("sumMap", "Map(String, Nullable(Float64))")),
        col("names", saf("sumMap", "Map(String, String)")),
      ]),
      {
        timestamp: "time",
        note: "unusable",
        price__count: "unusable",
        price__min: "unusable",
        latest: "unusable",
        buyers: "unusable",
        __uniq: "unusable",
        buyers__uniq: "unusable",
        units: "sum",
        units__count: "unusable",
        units__min: "unusable",
        _rows: "unusable",
        tags: "unusable",
        maybe: "unusable",
        names: "unusable",
      },
    );
  });

  it("does not give the time role to a time column outside the sorting key or of another type", () => {
    assert.equal(roles([col("timestamp", "DateTime64(3)", 0)]).timestamp, "unusable");
    assert.equal(roles([col("timestamp", "String", 1)]).timestamp, "unusable");
    assert.equal(roles([col("timestamp", "DateTime('UTC')", "1")]).timestamp, "time");
  });
});

describe("structureFingerprint", () => {
  const { binding } = parseBinding(comment());
  const columns = [col("timestamp", "DateTime64(3)", 1), col("units", saf("sum", "Float64"))];

  it("is stable and independent of column order", () => {
    assert.equal(
      structureFingerprint(binding, columns),
      structureFingerprint(binding, [...columns].reverse()),
    );
  });

  it("changes with the binding and with any column", () => {
    const base = structureFingerprint(binding, columns);
    assert.notEqual(base, structureFingerprint(parseBinding(comment({ min_age: "1 day" })).binding, columns));
    assert.notEqual(base, structureFingerprint(binding, [...columns, col("_rows", saf("sum", "UInt64"))]));
    assert.notEqual(base, structureFingerprint(binding, [columns[0], col("units", saf("sum", "Float32"))]));
  });
});

describe("fillSelect", () => {
  const { binding } = parseBinding(comment({ grain: "30 minute" }));
  const structure = {
    ...binding,
    columns: classifyColumns(
      [
        col("partition", "LowCardinality(String)", 1),
        col("timestamp", "DateTime64(3)", 1),
        col("store", "String", 1),
        col("units", saf("sum", "Float64")),
        col("units__count", saf("sum", "UInt64")),
        col("units__min", saf("min", "Float32")),
        col("units__max", saf("max", "Float32")),
        col("metrics", saf("sumMap", "Map(String, Float64)")),
        col("_rows", saf("sum", "UInt64")),
        col("note", "String", 0),
      ],
      binding,
    ),
  };
  const { sql, columns } = fillSelect(structure, "a1b2c3");
  const bucket = "toDateTime(toStartOfInterval(src.`timestamp`, INTERVAL 30 minute, 'UTC'), 'UTC')";

  it("lists output columns in table order, without unusable ones, for inserting by name", () => {
    assert.deepEqual(columns, [
      "partition", "timestamp", "store", "units", "units__count", "units__min", "units__max", "metrics", "_rows",
    ]);
  });

  it("qualifies every source column and buckets the time column in UTC", () => {
    assert.equal(
      sql,
      "SELECT src.`partition` AS `partition`, " +
        `${bucket} AS \`timestamp\`, ` +
        "src.`store` AS `store`, " +
        "sum(src.`units`) AS `units`, count(src.`units`) AS `units__count`, " +
        "min(src.`units`) AS `units__min`, max(src.`units`) AS `units__max`, " +
        "sumMap(src.`metrics`) AS `metrics`, count() AS `_rows` " +
        "FROM `cst`.`sales_lines` AS src WHERE src._partition_id = 'a1b2c3' " +
        `GROUP BY src.\`partition\`, ${bucket}, src.\`store\``,
    );
  });

  it("never removes duplicates while reading", () => {
    assert.doesNotMatch(sql, /\bFINAL\b/i);
  });

  it("fills uniq sketch columns with uniqState", () => {
    const withUniq = {
      ...binding,
      columns: classifyColumns(
        [
          col("partition", "LowCardinality(String)", 1),
          col("timestamp", "DateTime64(3)", 1),
          col("external_order_id__uniq", "AggregateFunction(uniq, String)"),
          col("_rows", saf("sum", "UInt64")),
        ],
        binding,
      ),
    };
    const out = fillSelect(withUniq, "a1b2c3");
    assert.deepEqual(out.columns, ["partition", "timestamp", "external_order_id__uniq", "_rows"]);
    assert.equal(
      out.sql,
      "SELECT src.`partition` AS `partition`, " +
        `${bucket} AS \`timestamp\`, ` +
        "uniqState(src.`external_order_id`) AS `external_order_id__uniq`, count() AS `_rows` " +
        "FROM `cst`.`sales_lines` AS src WHERE src._partition_id = 'a1b2c3' " +
        `GROUP BY src.\`partition\`, ${bucket}`,
    );
  });

  it("refuses a partition id that is not a plain identifier", () => {
    assert.throws(() => fillSelect(structure, "x' OR 1 = 1 --"));
    assert.throws(() => fillSelect(structure, ""));
  });
});
