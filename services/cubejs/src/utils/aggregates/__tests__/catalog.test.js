import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCatalog, serverNow } from "../catalog.js";

const BINDING = {
  aggregate_of: "cst.sales_lines",
  time_column: "timestamp",
  grain: "1 day",
  min_age: "7 day",
  min_window: "60 day",
  max_staleness: "1 day",
};
const PARTITION_KEY = "(partition, toStartOfMonth(timestamp))";
const saf = (fn, type) => `SimpleAggregateFunction(${fn}, ${type})`;
const aggregateColumns = (table) => [
  { database: "cst", table, name: "partition", type: "LowCardinality(String)", is_in_sorting_key: 1 },
  { database: "cst", table, name: "timestamp", type: "DateTime64(3)", is_in_sorting_key: 1 },
  { database: "cst", table, name: "units", type: saf("sum", "Float64"), is_in_sorting_key: 0 },
  { database: "cst", table, name: "_rows", type: saf("sum", "UInt64"), is_in_sorting_key: 0 },
];
const sourceTimeColumn = { database: "cst", table: "sales_lines", name: "timestamp", type: "DateTime64(3)", is_in_sorting_key: 1 };
const aggregateRow = (name, patch = {}) => ({
  database: "cst",
  name,
  comment: JSON.stringify(BINDING),
  partition_key: PARTITION_KEY,
  sorting_key: "partition, timestamp",
  total_rows: "1000",
  ...patch,
});
const STATE_TABLE = { database: "cst", name: "aggregate_state", comment: "", partition_key: "", sorting_key: "", total_rows: "3" };

const NOW_MS = Date.UTC(2026, 10, 20, 12);
const VERIFIED_MS = NOW_MS - 3600_000;
const COVERED_MS = Date.UTC(2026, 10, 1);

/** A fake data source: answers each of the four probe statements from `world`. */
function fakeSource(world) {
  const statements = [];
  const queryFn = async (sql) => {
    statements.push(sql);
    if (world.fail) throw new Error("connection refused");
    if (/FROM system\.tables WHERE startsWith/.test(sql)) return world.tables;
    if (/partition_key FROM system\.tables WHERE \(database, name\) IN/.test(sql)) return world.sources;
    if (/FROM system\.columns/.test(sql)) return world.columns;
    if (/aggregate_state/.test(sql)) {
      return [{ database: "", aggregate: "", verified_ms: "0", covered_ms: "0", now_ms: String(NOW_MS) }, ...world.state];
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { statements, queryFn };
}

const world = (patch = {}) => ({
  tables: [aggregateRow("sales_lines__agg_1day"), STATE_TABLE],
  sources: [{ database: "cst", name: "sales_lines", partition_key: PARTITION_KEY }],
  columns: [...aggregateColumns("sales_lines__agg_1day"), sourceTimeColumn],
  state: [
    { database: "cst", aggregate: "sales_lines__agg_1day", verified_ms: String(VERIFIED_MS), covered_ms: String(COVERED_MS), now_ms: String(NOW_MS) },
  ],
  ...patch,
});

const context = (patch = {}) => ({
  userScope: { dataSource: { dbType: "clickhouse", dataSourceVersion: "dsv1", ...patch } },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A catalog over a fake source, with a clock the test moves. */
function setup(state, options = {}) {
  const source = fakeSource(state);
  const clock = { ms: 0 };
  let released = 0;
  const catalog = createCatalog({
    driverFor: async () => ({ query: source.queryFn, release: async () => { released += 1; } }),
    now: () => clock.ms,
    ...options,
  });
  const load = async (securityContext = context()) => {
    catalog.lookup(securityContext);
    await settle();
    return catalog.lookup(securityContext);
  };
  return { catalog, clock, load, statements: source.statements, released: () => released };
}

describe("catalog", () => {
  it("returns nothing until the first probe has finished, and never waits for it", async () => {
    const { catalog, statements } = setup(world());
    assert.equal(catalog.lookup(context()), null);
    assert.equal(catalog.lookup(context()), null); // the probe is still running; no second one starts
    await settle();
    const entry = catalog.lookup(context());
    assert.equal(entry.aggregates.length, 1);
    assert.equal(statements.length, 4);
  });

  it("describes an accepted aggregate", async () => {
    const { load, released } = setup(world());
    const [aggregate] = (await load()).aggregates;
    assert.deepEqual(
      {
        table: aggregate.table,
        name: aggregate.name,
        source: aggregate.source,
        timeColumn: aggregate.timeColumn,
        grainSeconds: aggregate.grainSeconds,
        minAgeSeconds: aggregate.minAgeSeconds,
        minWindowSeconds: aggregate.minWindowSeconds,
        maxStalenessSeconds: aggregate.maxStalenessSeconds,
        totalRows: aggregate.totalRows,
        verifiedAt: aggregate.verifiedAt,
        coveredUntil: aggregate.coveredUntil,
        roles: Object.fromEntries([...aggregate.columns].map(([name, column]) => [name, column.role])),
      },
      {
        table: "cst.sales_lines__agg_1day",
        name: "sales_lines__agg_1day",
        source: "cst.sales_lines",
        timeColumn: "timestamp",
        grainSeconds: 86400,
        minAgeSeconds: 7 * 86400,
        minWindowSeconds: 60 * 86400,
        maxStalenessSeconds: 86400,
        totalRows: 1000,
        verifiedAt: VERIFIED_MS,
        coveredUntil: COVERED_MS,
        roles: { partition: "group", timestamp: "time", units: "sum", _rows: "rows" },
      },
    );
    assert.match(aggregate.fingerprint, /^[a-f0-9]{32}$/);
    assert.equal(released(), 1);
  });

  it("issues at most four statements per probe, and one when there is no aggregate", async () => {
    const full = setup(world());
    await full.load();
    assert.equal(full.statements.length, 4);

    const none = setup(world({ tables: [STATE_TABLE] }));
    assert.deepEqual((await none.load()).aggregates, []);
    assert.equal(none.statements.length, 1);
  });

  it("rejects an aggregate for the four binding reasons, and for nothing else", async () => {
    const tables = [
      aggregateRow("ok"),
      aggregateRow("bad_comment", { comment: '{"aggregate_of": "cst.sales_lines"}' }),
      aggregateRow("other_database", { comment: JSON.stringify({ ...BINDING, aggregate_of: "other.sales_lines" }) }),
      aggregateRow("no_source", { comment: JSON.stringify({ ...BINDING, aggregate_of: "cst.gone" }) }),
      aggregateRow("no_time_in_source", { comment: JSON.stringify({ ...BINDING, time_column: "created" }) }),
      aggregateRow("no_time_in_aggregate"),
      aggregateRow("time_outside_key"),
      aggregateRow("other_partitioning", { partition_key: "toYYYYMM(timestamp)" }),
      aggregateRow("odd_columns"),
      STATE_TABLE,
    ];
    const columns = [
      sourceTimeColumn,
      ...["ok", "bad_comment", "other_database", "no_source", "no_time_in_source", "other_partitioning"].flatMap(aggregateColumns),
      ...aggregateColumns("no_time_in_aggregate").filter((column) => column.name !== "timestamp"),
      ...aggregateColumns("time_outside_key").map((column) => (column.name === "timestamp" ? { ...column, is_in_sorting_key: 0 } : column)),
      ...aggregateColumns("odd_columns"),
      { database: "cst", table: "odd_columns", name: "note", type: "String", is_in_sorting_key: 0 },
      { database: "cst", table: "odd_columns", name: "buyers", type: "AggregateFunction(uniq, String)", is_in_sorting_key: 0 },
    ];
    const { load } = setup(world({ tables, columns, state: [] }));
    const entry = await load();
    assert.deepEqual(entry.aggregates.map((aggregate) => aggregate.name).sort(), ["odd_columns", "ok"]);
    assert.deepEqual(
      Object.fromEntries(entry.rejected.map(({ table, reason }) => [table, reason])),
      {
        "cst.bad_comment": "invalid_binding",
        "cst.other_database": "invalid_binding",
        "cst.no_source": "source_missing",
        "cst.no_time_in_source": "time_column_missing",
        "cst.no_time_in_aggregate": "time_column_missing",
        "cst.time_outside_key": "time_column_missing",
        "cst.other_partitioning": "partition_key_mismatch",
      },
    );
    const odd = entry.aggregates.find((aggregate) => aggregate.name === "odd_columns");
    assert.equal(odd.columns.get("note").role, "unusable");
    assert.equal(odd.columns.get("buyers").role, "unusable");
  });

  it("accepts an aggregate without a refresh record, as unverified", async () => {
    const noRecord = setup(world({ state: [] }));
    const [first] = (await noRecord.load()).aggregates;
    assert.deepEqual([first.verifiedAt, first.coveredUntil], [null, null]);

    const noTable = setup(world({ tables: [aggregateRow("sales_lines__agg_1day")] }));
    const [second] = (await noTable.load()).aggregates;
    assert.deepEqual([second.verifiedAt, second.coveredUntil], [null, null]);
    assert.equal(noTable.statements.length, 3);
  });

  it("tells the server's time from its clock at the probe plus the time passed here", async () => {
    const { load, clock } = setup(world());
    clock.ms = 5_000;
    const entry = await load();
    clock.ms = 5_000 + 90_000;
    assert.equal(serverNow(entry, () => clock.ms), NOW_MS + 90_000);
  });

  it("serves the old catalog while a new probe runs, once the lifetime has passed", async () => {
    const state = world();
    const { catalog, clock, load, statements } = setup(state);
    await load();
    assert.equal(statements.length, 4);

    clock.ms = 59_999;
    catalog.lookup(context());
    await settle();
    assert.equal(statements.length, 4); // still fresh

    state.tables = [STATE_TABLE]; // the comment was cleared
    clock.ms = 60_000;
    assert.equal(catalog.lookup(context()).aggregates.length, 1); // stale answer, probe started
    await settle();
    assert.equal(catalog.lookup(context()).aggregates.length, 0); // gone after one lifetime
  });

  it("gives a changed structure a new fingerprint", async () => {
    const state = world();
    const { catalog, clock, load } = setup(state);
    const before = (await load()).aggregates[0].fingerprint;
    state.columns = [
      ...state.columns,
      { database: "cst", table: "sales_lines__agg_1day", name: "units__count", type: saf("sum", "UInt64"), is_in_sorting_key: 0 },
    ];
    clock.ms = 60_000;
    catalog.lookup(context());
    await settle();
    assert.notEqual(catalog.lookup(context()).aggregates[0].fingerprint, before);
  });

  it("keeps one catalog per data source", async () => {
    const { load, statements } = setup(world());
    await load(context({ dataSourceVersion: "a" }));
    await load(context({ dataSourceVersion: "b" }));
    await load(context({ dataSourceVersion: "a" }));
    assert.equal(statements.length, 8);
  });

  it("has an empty catalog for a data source that is not ClickHouse, without probing", async () => {
    const { catalog, statements } = setup(world());
    assert.deepEqual(catalog.lookup(context({ dbType: "postgres" })).aggregates, []);
    assert.equal(catalog.lookup({}), null);
    await settle();
    assert.equal(statements.length, 0);
  });

  it("has an empty catalog after a failed probe, and tries again after one lifetime", async () => {
    const state = world({ fail: true });
    const { catalog, clock, load, released } = setup(state);
    const entry = await load();
    assert.deepEqual([entry.aggregates, entry.rejected], [[], []]);
    assert.equal(released(), 1);

    state.fail = false;
    clock.ms = 60_000;
    catalog.lookup(context());
    await settle();
    assert.equal(catalog.lookup(context()).aggregates.length, 1);
  });

  it("survives a driver that cannot be created", async () => {
    const catalog = createCatalog({ driverFor: async () => { throw new Error("no driver"); }, now: () => 0 });
    catalog.lookup(context());
    await settle();
    assert.deepEqual(catalog.lookup(context()).aggregates, []);
  });

  it("puts only validated identifiers into statements", async () => {
    const tables = [
      aggregateRow("fine"),
      aggregateRow("bad'name"),
      { ...aggregateRow("fine2"), database: "c st" },
      STATE_TABLE,
    ];
    const { load, statements } = setup(world({ tables, columns: [...aggregateColumns("fine"), sourceTimeColumn], state: [] }));
    const entry = await load();
    assert.deepEqual(entry.aggregates.map((aggregate) => aggregate.name), ["fine"]);
    assert.deepEqual(
      Object.fromEntries(entry.rejected.map(({ table, reason }) => [table, reason])),
      { "cst.bad'name": "invalid_binding", "c st.fine2": "invalid_binding" },
    );
    for (const sql of statements) assert.doesNotMatch(sql, /bad'name|c st/);
  });
});
