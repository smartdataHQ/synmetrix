import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fillSelect } from "../contract.js";
import { refreshAggregate, refreshAll } from "../refresh.js";
import { COLUMNS, structure } from "./fixtures/salesAggregate.js";

const DAY = 86400_000;
const NOW = Date.UTC(2026, 10, 20, 12);
const month = (index) => Date.UTC(2026, index, 1);
/** A source partition: one month, with rows from its first day to `lastDay`. */
const partition = (id, monthIndex, fingerprint, lastDay = 28) => ({
  partition_id: id,
  fingerprint: String(fingerprint),
  oldest_ms: String(month(monthIndex)),
  newest_ms: String(month(monthIndex) + (lastDay - 1) * DAY + 3600_000),
});
const SEPTEMBER = partition("p09", 8, 109);
const OCTOBER = partition("p10", 9, 110);
const NOVEMBER = partition("p11", 10, 111, 20); // newest row on 20 November: an hour and a half ago at most

const AGGREGATE = (patch = {}) => structure(COLUMNS, "sales__agg_1day", { minAgeSeconds: 7 * 86400, ...patch });
const STAGING = "`agg_test`.`sales__agg_1day__staging`";
const TARGET = "`agg_test`.`sales__agg_1day`";
const STATE = "`agg_test`.`aggregate_state`";

/** A fake database: answers the reads of a pass from `world` and records every other statement. */
function database(world) {
  const writes = [];
  const reads = [];
  const queryFn = async (sql) => {
    if (world.failOn?.test(sql)) throw new Error("statement failed");
    const read = (rows) => { reads.push(sql); return rows; };
    if (/^SELECT toUnixTimestamp64Milli\(now64\(3\)\) AS now_ms$/.test(sql)) return read([{ now_ms: String(world.now ?? NOW) }]);
    if (/groupBitXor\(cityHash64\(name\)\)/.test(sql)) {
      return read(world.source.map(({ partition_id, fingerprint }) => ({ partition_id, fingerprint })));
    }
    if (/GROUP BY _partition_id$/.test(sql)) {
      return read(world.source.map(({ partition_id, oldest_ms, newest_ms }) => ({ partition_id, oldest_ms, newest_ms })));
    }
    if (/^SELECT partition_id, toString\(argMax\(fingerprint, updated_at\)\)/.test(sql)) {
      return read(Object.entries(world.recorded || {}).map(([partition_id, fingerprint]) => ({ partition_id, fingerprint: String(fingerprint) })));
    }
    if (/^SELECT DISTINCT partition_id FROM system\.parts/.test(sql)) return read((world.held || []).map((partition_id) => ({ partition_id })));
    if (/^SELECT count\(\) AS strays FROM system\.parts/.test(sql)) return [{ strays: String(world.strays ?? 0) }];
    if (/^SELECT /.test(sql)) throw new Error(`unexpected read: ${sql}`);
    writes.push(sql);
    return [];
  };
  return { queryFn, writes, reads };
}

const recordOf = (writes, partitionId) =>
  writes.filter((sql) => sql.startsWith(`INSERT INTO ${STATE} `) && sql.includes(`VALUES ('sales__agg_1day', '${partitionId}', `));
const passRecord = (writes) => recordOf(writes, "")[0];

describe("refreshAggregate", () => {
  it("reads fingerprints from the names of active parts, and times from a plain read", async () => {
    const { queryFn, reads } = database({ source: [SEPTEMBER], recorded: { p09: 109 }, held: ["p09"] });
    await refreshAggregate(queryFn, AGGREGATE());
    assert.deepEqual(reads, [
      "SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms",
      "SELECT partition_id, toString(groupBitXor(cityHash64(name))) AS fingerprint FROM system.parts " +
        "WHERE database = 'agg_test' AND table = 'sales' AND active GROUP BY partition_id",
      "SELECT _partition_id AS partition_id, toUnixTimestamp64Milli(toDateTime64(min(src.`timestamp`), 3)) AS oldest_ms, " +
        "toUnixTimestamp64Milli(toDateTime64(max(src.`timestamp`), 3)) AS newest_ms FROM `agg_test`.`sales` AS src GROUP BY _partition_id",
      `SELECT partition_id, toString(argMax(fingerprint, updated_at)) AS fingerprint FROM ${STATE} ` +
        "WHERE aggregate = 'sales__agg_1day' AND partition_id != '' GROUP BY partition_id",
      "SELECT DISTINCT partition_id FROM system.parts WHERE database = 'agg_test' AND table = 'sales__agg_1day' AND active",
    ]);
    for (const sql of reads) assert.doesNotMatch(sql, /\bFINAL\b/i);
  });

  it("builds a missing partition from a plain read, swaps it in with one statement and records the fingerprint read before", async () => {
    const target = AGGREGATE();
    const { queryFn, writes } = database({ source: [SEPTEMBER], recorded: {}, held: [] });
    const result = await refreshAggregate(queryFn, target);

    const fill = fillSelect(target, "p09");
    assert.deepEqual(writes.slice(0, 7), [
      `DROP TABLE IF EXISTS ${STAGING} SYNC`,
      `CREATE TABLE ${STAGING} AS ${TARGET}`,
      `ALTER TABLE ${STAGING} MODIFY COMMENT ''`,
      `INSERT INTO ${STAGING} (${fill.columns.map((name) => `\`${name}\``).join(", ")}) ${fill.sql}`,
      `ALTER TABLE ${TARGET} REPLACE PARTITION ID 'p09' FROM ${STAGING}`,
      `TRUNCATE TABLE ${STAGING}`,
      `INSERT INTO ${STATE} (aggregate, partition_id, fingerprint, verified_at, covered_until, updated_at) ` +
        "VALUES ('sales__agg_1day', 'p09', 109, now(), 0, now64(3))",
    ]);
    assert.equal(writes.filter((sql) => /REPLACE PARTITION/.test(sql)).length, 1);
    for (const sql of writes) assert.doesNotMatch(sql, /\bFINAL\b/i);
    assert.deepEqual([result.checked, result.built, result.dropped], [1, ["p09"], []]);
  });

  it("rebuilds a partition whose source changed, and leaves an unchanged one alone", async () => {
    const { queryFn, writes } = database({
      source: [SEPTEMBER, { ...OCTOBER, fingerprint: "999" }],
      recorded: { p09: 109, p10: 110 },
      held: ["p09", "p10"],
    });
    const result = await refreshAggregate(queryFn, AGGREGATE());
    assert.deepEqual(result.built, ["p10"]);
    assert.equal(recordOf(writes, "p10").length, 1);
    assert.match(recordOf(writes, "p10")[0], /'p10', 999, /);
    assert.equal(recordOf(writes, "p09").length, 0);
    assert.ok(!writes.some((sql) => sql.includes("'p09'")));
  });

  it("rebuilds a partition the aggregate lost although its record is current", async () => {
    const { queryFn } = database({ source: [SEPTEMBER], recorded: { p09: 109 }, held: [] });
    assert.deepEqual((await refreshAggregate(queryFn, AGGREGATE())).built, ["p09"]);
  });

  it("holds only partitions whose newest row is older than min_age", async () => {
    const world = { source: [SEPTEMBER, OCTOBER, NOVEMBER], recorded: {}, held: [] };
    assert.deepEqual((await refreshAggregate(database(world).queryFn, AGGREGATE())).built, ["p09", "p10"]);
    // October's newest row is 23 days and 11 hours older than the pass
    assert.deepEqual((await refreshAggregate(database(world).queryFn, AGGREGATE({ minAgeSeconds: 24 * 86400 }))).built, ["p09"]);
    assert.deepEqual((await refreshAggregate(database(world).queryFn, AGGREGATE({ minAgeSeconds: 23 * 86400 }))).built, ["p09", "p10"]);
  });

  it("holds every partition when min_age is zero", async () => {
    const future = partition("p12", 11, 112);
    const { queryFn } = database({ source: [OCTOBER, NOVEMBER, future], recorded: {}, held: [] });
    assert.deepEqual((await refreshAggregate(queryFn, AGGREGATE({ minAgeSeconds: 0 }))).built, ["p10", "p11", "p12"]);
  });

  it("drops a partition whose source is gone or no longer belongs, and records fingerprint 0", async () => {
    const { queryFn, writes } = database({
      source: [SEPTEMBER, NOVEMBER],
      recorded: { p08: 108, p09: 109, p11: 111 },
      held: ["p08", "p09", "p11"],
    });
    const result = await refreshAggregate(queryFn, AGGREGATE());
    assert.deepEqual([result.built, result.dropped], [[], ["p08", "p11"]]);
    assert.ok(writes.includes(`ALTER TABLE ${TARGET} DROP PARTITION ID 'p08'`));
    assert.ok(writes.includes(`ALTER TABLE ${TARGET} DROP PARTITION ID 'p11'`));
    assert.match(recordOf(writes, "p08")[0], /'p08', 0, /);
    assert.match(recordOf(writes, "p11")[0], /'p11', 0, /);
    assert.ok(!writes.some((sql) => /staging/.test(sql))); // nothing was built, so no staging table
  });

  it("records the pass start and what the aggregate holds once every step succeeded", async () => {
    const some = database({ source: [SEPTEMBER, OCTOBER, NOVEMBER], recorded: {}, held: [] });
    const result = await refreshAggregate(some.queryFn, AGGREGATE());
    assert.deepEqual([result.verifiedAt, result.coveredUntil], [NOW, month(10)]); // November is not held
    assert.equal(
      passRecord(some.writes),
      `INSERT INTO ${STATE} (aggregate, partition_id, fingerprint, verified_at, covered_until, updated_at) VALUES ` +
        `('sales__agg_1day', '', 0, toDateTime(fromUnixTimestamp64Milli(toInt64(${NOW}), 'UTC')), ` +
        `fromUnixTimestamp64Milli(toInt64(${month(10)}), 'UTC'), now64(3))`,
    );
    assert.equal(some.writes.at(-1), `DROP TABLE IF EXISTS ${STAGING} SYNC`);
    assert.equal(some.writes.at(-2), passRecord(some.writes));

    const all = database({ source: [SEPTEMBER, OCTOBER], recorded: { p09: 109, p10: 110 }, held: ["p09", "p10"] });
    assert.equal((await refreshAggregate(all.queryFn, AGGREGATE())).coveredUntil, NOW); // holds everything: covered up to the pass
    assert.equal(all.writes.length, 1); // only the pass record
  });

  it("records neither when a step fails, and still drops the staging table", async () => {
    for (const failOn of [/^INSERT INTO `agg_test`\.`sales__agg_1day__staging`/, /REPLACE PARTITION/, /DROP PARTITION/, /GROUP BY _partition_id$/]) {
      const { queryFn, writes } = database({
        source: [SEPTEMBER, NOVEMBER],
        recorded: { p11: 111 },
        held: ["p11"],
        failOn,
      });
      await assert.rejects(refreshAggregate(queryFn, AGGREGATE()), /statement failed/, String(failOn));
      assert.equal(passRecord(writes), undefined, String(failOn));
      const created = writes.some((sql) => sql.startsWith("CREATE TABLE"));
      assert.equal(writes.at(-1) === `DROP TABLE IF EXISTS ${STAGING} SYNC`, created, String(failOn));
    }
  });

  it("does not swap in a build whose buckets fall outside the partition", async () => {
    const { queryFn, writes } = database({ source: [SEPTEMBER], recorded: {}, held: [], strays: 1 });
    await assert.rejects(refreshAggregate(queryFn, AGGREGATE()), /do not nest inside the source's partitions/);
    assert.ok(!writes.some((sql) => /REPLACE PARTITION/.test(sql)));
    assert.equal(passRecord(writes), undefined);
    assert.equal(writes.at(-1), `DROP TABLE IF EXISTS ${STAGING} SYNC`);
  });

  it("refuses a partition id or fingerprint that is not plain", async () => {
    const bad = database({ source: [{ ...SEPTEMBER, partition_id: "x' OR '1" }], recorded: {}, held: [] });
    await assert.rejects(refreshAggregate(bad.queryFn, AGGREGATE()));
    assert.ok(!bad.writes.some((sql) => sql.includes("OR '1")));
    const worse = database({ source: [{ ...SEPTEMBER, fingerprint: "1); DROP" }], recorded: {}, held: [] });
    await assert.rejects(refreshAggregate(worse.queryFn, AGGREGATE()));
  });
});

describe("refreshAll", () => {
  const saf = (fn, type) => `SimpleAggregateFunction(${fn}, ${type})`;
  const binding = '{"aggregate_of": "agg_test.sales", "time_column": "timestamp", "grain": "1 day", "min_age": "7 day", "min_window": "60 day", "max_staleness": "1 day"}';
  const key = "(partition, toStartOfMonth(timestamp))";
  const columnsOf = (table) => [
    { database: "agg_test", table, name: "partition", type: "String", is_in_sorting_key: 1 },
    { database: "agg_test", table, name: "timestamp", type: "DateTime64(3)", is_in_sorting_key: 1 },
    { database: "agg_test", table, name: "units", type: saf("sum", "Float64"), is_in_sorting_key: 0 },
  ];

  /** Two aggregates of one source; statements that touch `broken` fail. */
  function cluster({ broken } = {}) {
    const writes = [];
    const queryFn = async (sql) => {
      if (/FROM system\.tables WHERE startsWith/.test(sql)) {
        return [
          { database: "agg_test", name: "sales__agg_1day", comment: binding, partition_key: key, sorting_key: "partition, timestamp", total_rows: "10" },
          { database: "agg_test", name: "sales__agg_30minute", comment: binding.replace("1 day\", \"min_age", "30 minute\", \"min_age"), partition_key: key, sorting_key: "partition, timestamp", total_rows: "20" },
          { database: "agg_test", name: "ignored", comment: '{"aggregate_of": "nope"}', partition_key: key, sorting_key: "", total_rows: "0" },
          { database: "agg_test", name: "aggregate_state", comment: "", partition_key: "", sorting_key: "", total_rows: "0" },
        ];
      }
      if (/partition_key FROM system\.tables WHERE \(database, name\) IN/.test(sql)) return [{ database: "agg_test", name: "sales", partition_key: key }];
      if (/FROM system\.columns/.test(sql)) {
        return [...columnsOf("sales__agg_1day"), ...columnsOf("sales__agg_30minute"), { database: "agg_test", table: "sales", name: "timestamp", type: "DateTime64(3)", is_in_sorting_key: 1 }];
      }
      if (/UNION ALL/.test(sql)) return [{ database: "", aggregate: "", verified_ms: "0", covered_ms: "0", now_ms: String(NOW) }];
      if (broken && sql.includes(broken) && !/^SELECT/.test(sql)) throw new Error("disk full");
      if (/now_ms$/.test(sql)) return [{ now_ms: String(NOW) }];
      if (/groupBitXor/.test(sql)) return [{ partition_id: "p09", fingerprint: "109" }];
      if (/GROUP BY _partition_id$/.test(sql)) return [{ partition_id: "p09", oldest_ms: String(month(8)), newest_ms: String(month(8) + DAY) }];
      if (/^SELECT count\(\) AS strays/.test(sql)) return [{ strays: "0" }];
      if (/^SELECT/.test(sql)) return [];
      writes.push(sql);
      return [];
    };
    return { queryFn, writes };
  }

  it("refreshes every accepted aggregate and reports each one", async () => {
    const { queryFn } = cluster();
    const { results, rejected } = await refreshAll(queryFn);
    assert.deepEqual(results.map(({ aggregate, ok, built }) => [aggregate, ok, built]), [
      ["agg_test.sales__agg_1day", true, ["p09"]],
      ["agg_test.sales__agg_30minute", true, ["p09"]],
    ]);
    assert.deepEqual(rejected, [{ table: "agg_test.ignored", reason: "invalid_binding" }]);
    for (const result of results) assert.equal(typeof result.durationMs, "number");
  });

  it("goes on with the others when one aggregate fails", async () => {
    const { queryFn, writes } = cluster({ broken: "sales__agg_1day__staging" });
    const { results } = await refreshAll(queryFn);
    assert.deepEqual(results.map(({ aggregate, ok }) => [aggregate, ok]), [
      ["agg_test.sales__agg_1day", false],
      ["agg_test.sales__agg_30minute", true],
    ]);
    assert.equal(results[0].error, "disk full");
    assert.ok(writes.some((sql) => sql.includes("VALUES ('sales__agg_30minute', '', 0,")));
    assert.ok(!writes.some((sql) => sql.includes("VALUES ('sales__agg_1day', '', 0,")));
  });

  it("limits the pass to one aggregate with `only`", async () => {
    const { queryFn } = cluster();
    const { results } = await refreshAll(queryFn, { only: "agg_test.sales__agg_30minute" });
    assert.deepEqual(results.map(({ aggregate }) => aggregate), ["agg_test.sales__agg_30minute"]);
    const missing = await refreshAll(queryFn, { only: "agg_test.nowhere" });
    assert.deepEqual(missing.results, [{ aggregate: "agg_test.nowhere", ok: false, error: "not an accepted aggregate", durationMs: 0 }]);
  });
});
