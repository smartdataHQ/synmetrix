/**
 * The life of an aggregate under the real refresh pass (US4): built from plain
 * reads, held only once old enough, rebuilt when the source changes or the
 * database consolidates it, and unused without a recent pass. Needs the
 * disposable ClickHouse (docker-compose.clickhouse.yml).
 */
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { refreshAll } from "../../src/utils/aggregates/refresh.js";
import * as h from "./harness.js";

await h.stubSchemaLoader(mock, () => [{ id: "f1", name: "line_items.yml", code: h.MODEL }]);

const AGGREGATE = "agg_test.sales__agg_1day";
const SOURCE = "agg_test.sales";
const m = (name) => `line_items.${name}`;
const over = (granularity, from, to) => [
  { dimension: m("timestamp"), ...(granularity ? { granularity } : {}), dateRange: [from, to] },
];
const day = (offsetDays = 0) => new Date(Date.now() - offsetDays * 86400_000).toISOString().slice(0, 10);
const BINDING = (minAge) =>
  `{"aggregate_of": "agg_test.sales", "time_column": "timestamp", "grain": "1 day", "min_age": "${minAge}", "min_window": "60 day", "max_staleness": "1 day"}`;

let routed;
let plain;
const reasonOf = () => /reason=(\S+)/.exec(routed.lines.at(-1))?.[1];
const pass = async () => {
  const { results } = await refreshAll(h.run, { only: AGGREGATE });
  assert.equal(results.length, 1);
  assert.ok(results[0].ok, results[0].error);
  await h.reloadCatalog();
  return results[0];
};
const partsOf = async (table) =>
  Object.fromEntries(
    (await h.run(`SELECT partition_id, arraySort(groupArray(name)) AS parts FROM system.parts WHERE database = 'agg_test' AND table = '${table}' AND active GROUP BY partition_id`)).map(
      (row) => [row.partition_id, row.parts.join(",")],
    ),
  );
/** Both paths for one query: the table the routed one read, and both results. */
async function both(query) {
  const viaHook = await h.sqlFor(routed, query, h.requestContext());
  const viaSource = await h.sqlFor(plain, query, h.requestContext());
  return { table: h.tablesOf(viaHook)[0], actual: await h.execute(viaHook), expected: await h.execute(viaSource) };
}

before(async () => {
  await h.loadFixture("sales_like");
  // Rows of the current month, the newest about a minute old: a partition that is still changing.
  await h.run(
    "INSERT INTO agg_test.sales (partition, timestamp, event_gid, position, sold_location, main_category, product_id, uom, units, checkout_id, loaded_at) " +
      "SELECT ['t1', 't2'][1 + number % 2], " +
      "toStartOfMonth(now()) + toIntervalSecond(intDiv(number * greatest(dateDiff('second', toStartOfMonth(now()), now()) - 60, 1), 2000)), " +
      "concat('recent-', toString(number)), 0, concat('store', toString(number % 3)), 'food', concat('p', toString(number % 10)), 'pc', 1 + number % 3, " +
      "concat('rc', toString(number)), now64(3) FROM numbers(2000)",
  );
  await h.run(`ALTER TABLE ${AGGREGATE} MODIFY COMMENT '${BINDING("1 day")}'`);
  routed = await h.service({ routing: true });
  plain = await h.service({ routing: false });
});

after(async () => {
  await h.close();
});

describe("a refresh pass builds what is old enough and records what the aggregate holds", () => {
  let coveredUntil;

  it("builds every old partition, whatever its number of parts, and leaves the current month out", async () => {
    const sourceParts = await h.run(
      "SELECT partition_id, count() AS parts, toString(max(max_time)) AS x FROM system.parts WHERE database = 'agg_test' AND table = 'sales' AND active GROUP BY partition_id",
    );
    assert.equal(sourceParts.length, 10); // four months of 2026 and the current month, for two tenants
    assert.ok(sourceParts.some((row) => Number(row.parts) > 1)); // the month that holds unmerged duplicates

    const result = await pass();
    assert.deepEqual([result.checked, result.built.length, result.dropped.length], [10, 8, 0]);
    assert.equal(Object.keys(await partsOf("sales__agg_1day")).length, 8);
  });

  it("records the pass and the coverage boundary", async () => {
    const [record] = await h.run(
      "SELECT toUnixTimestamp64Milli(argMax(covered_until, updated_at)) AS covered_ms, toUnixTimestamp(argMax(verified_at, updated_at)) AS verified_s, toUnixTimestamp(now()) AS now_s " +
        "FROM agg_test.aggregate_state WHERE aggregate = 'sales__agg_1day' AND partition_id = ''",
    );
    const [{ oldest_ms: oldest }] = await h.run(
      "SELECT toUnixTimestamp64Milli(min(timestamp)) AS oldest_ms FROM agg_test.sales WHERE timestamp >= toStartOfMonth(now())",
    );
    coveredUntil = Number(record.covered_ms);
    assert.equal(coveredUntil, Number(oldest)); // the oldest row of a partition the aggregate does not hold
    assert.ok(Number(record.now_s) - Number(record.verified_s) < 120);
    assert.deepEqual((await h.run(`SELECT count() AS n FROM system.tables WHERE database = 'agg_test' AND name LIKE '%__staging'`))[0].n, "0");
  });

  it("answers a window inside the held partitions from the aggregate, equal to the source", async () => {
    const { table, actual, expected } = await both({ measures: [m("units"), m("count")], dimensions: [m("main_category")], timeDimensions: over("month", "2026-01-01", "2026-04-30") });
    assert.equal(table, AGGREGATE);
    h.assertSameRows(actual, expected, { label: "held window" });
  });

  it("answers a long window that reaches the present from the aggregate alone: exact before the boundary, the newest part missing", async () => {
    const { table, actual, expected } = await both({ measures: [m("units"), m("count")], timeDimensions: over("month", "2026-01-01", day()) });
    assert.equal(table, AGGREGATE);
    const boundary = new Date(coveredUntil).toISOString().slice(0, 23);
    const before = expected.filter((row) => row.line_items__timestamp_month < boundary.slice(0, 7));
    assert.equal(before.length, 4);
    assert.equal(expected.length, 5); // the source also has the current month
    h.assertSameRows(actual, before, { label: "long window" });
  });

  it("answers a short window that reaches the present from the source", async () => {
    const { table, actual, expected } = await both({ measures: [m("units")], timeDimensions: over("day", day(6), day()) });
    assert.equal(table, SOURCE);
    assert.equal(reasonOf(), "window_too_short");
    h.assertSameRows(actual, expected, { label: "short window" });
  });
});

describe("the aggregate follows its source", () => {
  const february = { measures: [m("units"), m("count")], dimensions: [m("sold_location")], timeDimensions: over("day", "2026-02-01", "2026-02-28") };
  let partition;

  it("is behind after rows are loaded into an old month, until the next pass rebuilds that month", async () => {
    [{ id: partition }] = await h.run(
      "SELECT any(_partition_id) AS id FROM agg_test.sales WHERE partition = 't1' AND toStartOfMonth(timestamp) = '2026-02-01'",
    );
    await h.run(
      "INSERT INTO agg_test.sales (partition, timestamp, event_gid, position, sold_location, main_category, product_id, uom, bundled_units, unit_size, unit_price, is_volume_pack, units, discount, checkout_id, metrics, loaded_at) " +
        "SELECT partition, timestamp, event_gid, position, sold_location, main_category, product_id, uom, bundled_units, unit_size, unit_price, is_volume_pack, units, discount, checkout_id, metrics, loaded_at + toIntervalSecond(5) " +
        "FROM agg_test.sales WHERE partition = 't1' AND toStartOfMonth(timestamp) = '2026-02-01'",
    );
    const behind = await both(february);
    assert.equal(behind.table, AGGREGATE);
    assert.notEqual(Number(behind.actual[0].line_items__count), Number(behind.expected[0].line_items__count));

    const result = await pass();
    assert.deepEqual(result.built, [partition]);
    const caughtUp = await both(february);
    h.assertSameRows(caughtUp.actual, caughtUp.expected, { label: "after the re-load" });
  });

  it("is rebuilt once the database consolidates the month, and only that month", async () => {
    const [{ plainRows, distinctRows }] = await h.run(
      "SELECT count() AS plainRows, uniqExact(event_gid, position) AS distinctRows FROM agg_test.sales WHERE partition = 't1' AND toStartOfMonth(timestamp) = '2026-02-01'",
    );
    assert.equal(Number(plainRows), 2 * Number(distinctRows)); // every row twice, waiting for a merge

    await h.run("SYSTEM START MERGES agg_test.sales");
    await h.run(`OPTIMIZE TABLE agg_test.sales PARTITION ID '${partition}' FINAL`);
    await h.run("SYSTEM STOP MERGES agg_test.sales");

    const partsBefore = await partsOf("sales__agg_1day");
    const result = await pass();
    assert.deepEqual(result.built, [partition]);
    const partsAfter = await partsOf("sales__agg_1day");
    for (const id of Object.keys(partsBefore)) {
      if (id !== partition) assert.equal(partsAfter[id], partsBefore[id], `partition ${id} was touched`);
    }
    assert.notEqual(partsAfter[partition], partsBefore[partition]);

    const exact = await both(february);
    assert.equal(exact.table, AGGREGATE);
    h.assertSameRows(exact.actual, exact.expected, { label: "after consolidation" });
    const total = exact.actual.reduce((sum, row) => sum + Number(row.line_items__count), 0);
    assert.equal(total, Number(distinctRows)); // duplicate-free from here on
  });

  it("does nothing when nothing changed", async () => {
    const partsBefore = await partsOf("sales__agg_1day");
    const result = await pass();
    assert.deepEqual([result.built, result.dropped], [[], []]);
    assert.deepEqual(await partsOf("sales__agg_1day"), partsBefore);
  });

  it("drops what no longer belongs when min_age grows", async () => {
    // With a min_age of 400 days nothing in the fixture is old enough.
    await h.run(`ALTER TABLE ${AGGREGATE} MODIFY COMMENT '${BINDING("400 day")}'`);
    const result = await pass();
    assert.deepEqual([result.built.length, result.dropped.length], [0, 8]);
    assert.equal(Object.keys(await partsOf("sales__agg_1day")).length, 0);
    await h.run(`ALTER TABLE ${AGGREGATE} MODIFY COMMENT '${BINDING("1 day")}'`);
    assert.equal((await pass()).built.length, 8);
  });
});

describe("without a recent pass the aggregate is not used", () => {
  const held = { measures: [m("units")], timeDimensions: over("month", "2026-01-01", "2026-04-30") };

  it("is unused when its refresh record is gone", async () => {
    await h.run("ALTER TABLE agg_test.aggregate_state DELETE WHERE aggregate = 'sales__agg_1day' AND partition_id = '' SETTINGS mutations_sync = 2");
    await h.reloadCatalog();
    const { table } = await both(held);
    assert.equal(table, SOURCE);
    assert.equal(reasonOf(), "not_verified");
  });

  it("is unused when the last pass is older than max_staleness, and used again after the next pass", async () => {
    await h.recordPass(await h.structureOf(AGGREGATE), { verifiedAt: "now() - INTERVAL 25 HOUR" });
    await h.reloadCatalog();
    assert.equal((await both(held)).table, SOURCE);
    assert.equal(reasonOf(), "stale");

    await pass();
    assert.equal((await both(held)).table, AGGREGATE);
  });
});
