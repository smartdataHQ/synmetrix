/**
 * The generate and refresh commands on a replicated cluster: one shard, three
 * replicas, as in production. Needs the disposable cluster of
 * docker-compose.yml in this directory (ports 18131 to 18133).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { main } from "../../../scripts/aggregates.mjs";
import { probeAggregates } from "../../../src/utils/aggregates/catalog.js";

const CLUSTER = "test_cluster";
const REPLICAS = [18131, 18132, 18133];
const AGGREGATE = "agg_cluster.sales__agg_1day";
const ADMIN = { user: "test", password: "test" };
const READS = /^\s*(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i;
// Only this test's aggregate: the cluster may hold others.
const REFRESH = ["refresh", "--only", AGGREGATE];

/** Runs one statement on one replica; rows for a read. */
async function sql(port, statement, { user, password } = ADMIN) {
  const read = READS.test(statement);
  const response = await fetch(
    `http://127.0.0.1:${port}/?user=${user}&password=${password}${read ? "&default_format=JSON" : ""}`,
    { method: "POST", body: statement },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`${text.slice(0, 400)}\n${statement.slice(0, 200)}`);
  return read ? JSON.parse(text).data : [];
}

/** Runs the command line against one replica. */
async function cli(args, port, { user, password } = ADMIN) {
  const out = [];
  const err = [];
  const code = await main(args, {
    env: {
      AGGREGATES_CLICKHOUSE_URL: `http://127.0.0.1:${port}`,
      AGGREGATES_CLICKHOUSE_USER: user,
      AGGREGATES_CLICKHOUSE_PASSWORD: password,
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const everyReplica = (work) => Promise.all(REPLICAS.map(work));
const synced = (...tables) =>
  everyReplica(async (port) => {
    for (const table of tables) await sql(port, `SYSTEM SYNC REPLICA ${table}`);
  });

const BY_MONTH = (table, rows) =>
  `SELECT partition, toString(toStartOfMonth(timestamp)) AS month, sum(units) AS units, ${rows} AS lines, sum(metrics['weight']) AS weight ` +
  `FROM ${table} GROUP BY partition, month ORDER BY partition, month`;
/** Asserts that every replica's aggregate answers like the source read on that same replica. */
async function assertAggregateEqualsSourceEverywhere() {
  await synced("agg_cluster.sales", AGGREGATE, "agg_cluster.aggregate_state");
  const answers = await everyReplica(async (port) => ({
    source: await sql(port, BY_MONTH("agg_cluster.sales", "count()")),
    aggregate: await sql(port, BY_MONTH(AGGREGATE, "sum(_rows)")),
  }));
  for (const { source, aggregate } of answers) {
    assert.equal(source.length, 8);
    assert.deepEqual(aggregate, source);
  }
  assert.deepEqual(answers[1].aggregate, answers[0].aggregate);
  assert.deepEqual(answers[2].aggregate, answers[0].aggregate);
  return answers[0].aggregate;
}

before(async () => {
  await sql(REPLICAS[0], `DROP DATABASE IF EXISTS agg_cluster ON CLUSTER ${CLUSTER} SYNC`);
  await sql(REPLICAS[0], `CREATE DATABASE agg_cluster ON CLUSTER ${CLUSTER}`);
  await sql(
    REPLICAS[0],
    `CREATE TABLE agg_cluster.sales ON CLUSTER ${CLUSTER} (partition LowCardinality(String), timestamp DateTime64(3), event_gid String, ` +
      "store LowCardinality(String), product_id String, unit_price Nullable(Float64), units Float32, " +
      "metrics Map(LowCardinality(String), Float32), loaded_at DateTime64(3)) " +
      "ENGINE = ReplicatedReplacingMergeTree(loaded_at) PARTITION BY (partition, toStartOfMonth(timestamp)) " +
      "ORDER BY (partition, store, product_id, event_gid, timestamp)",
  );
  // Refresh records, with the engine and replication path of the schema repository's definition.
  await sql(
    REPLICAS[0],
    `CREATE TABLE agg_cluster.aggregate_state ON CLUSTER ${CLUSTER} (aggregate String, partition_id String, fingerprint UInt64, ` +
      "verified_at DateTime('UTC'), covered_until DateTime64(3, 'UTC'), updated_at DateTime64(3, 'UTC')) " +
      "ENGINE = ReplicatedReplacingMergeTree('/clickhouse/{cluster}/tables/{database}/{table}/{shard}', '{replica}', updated_at) " +
      "ORDER BY (aggregate, partition_id)",
  );
  // Replaced rows stay until a test lets the cluster merge.
  await sql(REPLICAS[0], `SYSTEM STOP MERGES ON CLUSTER ${CLUSTER} agg_cluster.sales`);
  // Four months of 2026 for two tenants.
  await sql(
    REPLICAS[0],
    "INSERT INTO agg_cluster.sales SELECT ['t1', 't2'][1 + intDiv(number, 30) % 2], " +
      "toDateTime64('2026-01-01 00:00:00', 3, 'UTC') + toIntervalSecond(number * 345), toString(number), " +
      "concat('store', toString(intDiv(number, 10) % 3)), concat('p', toString(number % 10)), if(number % 10 = 9, NULL, 10 + number % 10), " +
      "1 + (number % 5) * 0.5, map('weight', (number % 9) * 0.5), toDateTime64('2026-05-01 00:00:00', 3, 'UTC') FROM numbers(30000)",
  );
  await synced("agg_cluster.sales");
});

describe("generate on a cluster", () => {
  let printed;

  it("prints a definition that every replica accepts", async () => {
    const { code, out, err } = await cli(
      [
        "generate", "--source", "agg_cluster.sales", "--time-column", "timestamp", "--grain", "1 day",
        "--group-by", "partition,store,product_id,unit_price", "--min-age", "0 second", "--min-window", "60 day",
        "--max-staleness", "1 day", "--cluster", CLUSTER,
      ],
      REPLICAS[2],
    );
    assert.deepEqual([code, err], [0, ""]);
    printed = out;
    const definition = out.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim().replace(/;$/, "");
    assert.match(definition, /^CREATE TABLE IF NOT EXISTS agg_cluster\.sales__agg_1day ON CLUSTER test_cluster\n/);
    await sql(REPLICAS[0], definition);

    const engines = await everyReplica((port) =>
      sql(port, "SELECT engine, comment FROM system.tables WHERE database = 'agg_cluster' AND name = 'sales__agg_1day'"),
    );
    for (const [table] of engines) {
      assert.equal(table.engine, "ReplicatedAggregatingMergeTree");
      assert.match(table.comment, /^\{"aggregate_of": "agg_cluster\.sales"/);
    }
  });

  it("prints a forced-merge statement for the replacing source that the cluster accepts", async () => {
    const statement = /^-- {3}(ALTER TABLE agg_cluster\.sales ON CLUSTER test_cluster MODIFY SETTING .*);$/m.exec(printed)?.[1];
    assert.ok(statement, printed.slice(-400));
    await sql(REPLICAS[1], statement);
    const settings = await everyReplica((port) =>
      sql(port, "SELECT engine_full FROM system.tables WHERE database = 'agg_cluster' AND name = 'sales'"),
    );
    for (const [table] of settings) {
      assert.match(table.engine_full, /min_age_to_force_merge_seconds = 86400, min_age_to_force_merge_on_partition_only = 1/);
    }
  });
});

describe("refresh on a cluster", () => {
  it("fills the aggregate on all three replicas from a pass run against one", async () => {
    const { code, out, err } = await cli(REFRESH, REPLICAS[1]);
    assert.deepEqual([code, err], [0, ""]);
    assert.match(out, /^refresh {2}aggregate=agg_cluster\.sales__agg_1day {2}checked=8 {2}built=8 {2}dropped=0 {2}ms=\d+$/);
    const rows = await assertAggregateEqualsSourceEverywhere();
    assert.ok(rows.every((row) => Number(row.lines) > 0));
  });

  it("leaves no staging table on any replica", async () => {
    const left = await everyReplica((port) =>
      sql(port, "SELECT count() AS tables FROM system.tables WHERE database = 'agg_cluster' AND name LIKE '%__staging'"),
    );
    assert.deepEqual(left.map(([row]) => Number(row.tables)), [0, 0, 0]);
  });

  it("is read as verified by the catalog through any replica", async () => {
    for (const port of REPLICAS) {
      const entry = await probeAggregates((statement) => sql(port, statement));
      const aggregate = entry.aggregates.find((candidate) => candidate.table === AGGREGATE);
      assert.ok(aggregate, JSON.stringify(entry.rejected));
      assert.ok(aggregate.verifiedAt > 0 && aggregate.coveredUntil > 0);
      assert.ok(![...aggregate.columns.values()].some((column) => column.role === "unusable"));
    }
  });

  it("picks up rows loaded through another replica, with a pass run against a third", async () => {
    await sql(
      REPLICAS[2],
      "INSERT INTO agg_cluster.sales SELECT partition, timestamp, event_gid, store, product_id, unit_price, units, metrics, loaded_at + toIntervalSecond(5) " +
        "FROM agg_cluster.sales WHERE partition = 't1' AND toStartOfMonth(timestamp) = '2026-02-01'",
    );
    await synced("agg_cluster.sales");
    const { code, out } = await cli(REFRESH, REPLICAS[0]);
    assert.equal(code, 0);
    assert.match(out, / checked=8 {2}built=1 {2}dropped=0 /);
    await assertAggregateEqualsSourceEverywhere();
  });

  it("rebuilds the month once the cluster has consolidated it, duplicate-free on every replica", async () => {
    const [{ id }] = await sql(
      REPLICAS[0],
      "SELECT any(_partition_id) AS id FROM agg_cluster.sales WHERE partition = 't1' AND toStartOfMonth(timestamp) = '2026-02-01'",
    );
    const [{ plain, distinct }] = await sql(
      REPLICAS[0],
      `SELECT count() AS plain, uniqExact(event_gid) AS distinct FROM agg_cluster.sales WHERE _partition_id = '${id}'`,
    );
    assert.equal(Number(plain), 2 * Number(distinct));

    await sql(REPLICAS[0], `SYSTEM START MERGES ON CLUSTER ${CLUSTER} agg_cluster.sales`);
    await sql(REPLICAS[2], `OPTIMIZE TABLE agg_cluster.sales PARTITION ID '${id}' FINAL SETTINGS alter_sync = 2`);
    await sql(REPLICAS[0], `SYSTEM STOP MERGES ON CLUSTER ${CLUSTER} agg_cluster.sales`);
    await synced("agg_cluster.sales");

    const { code, out } = await cli(REFRESH, REPLICAS[1]);
    assert.equal(code, 0);
    assert.match(out, / checked=8 {2}built=1 {2}dropped=0 /);
    const rows = await assertAggregateEqualsSourceEverywhere();
    const february = rows.find((row) => row.partition === "t1" && row.month === "2026-02-01");
    assert.equal(Number(february.lines), Number(distinct));
  });

  it("returns only once every replica that is up has the rebuilt partition, also a slow one", async () => {
    const lines = (port) => sql(port, `SELECT sum(_rows) AS lines FROM ${AGGREGATE} WHERE partition = 't2' AND toStartOfMonth(timestamp) = '2026-01-01'`);
    const [[before]] = [await lines(REPLICAS[0])];
    await sql(
      REPLICAS[0],
      "INSERT INTO agg_cluster.sales VALUES ('t2', '2026-01-15 12:00:00', 'slow-replica-row', 'store0', 'p1', 11, 5, {'weight': 1}, now64(3))",
    );
    await synced("agg_cluster.sales");
    // Replica 3 is up but cannot fetch for a while.
    await sql(REPLICAS[2], `SYSTEM STOP FETCHES ${AGGREGATE}`);
    const resumed = new Promise((resolve) => setTimeout(() => resolve(sql(REPLICAS[2], `SYSTEM START FETCHES ${AGGREGATE}`)), 3000));
    const { code, out } = await cli(REFRESH, REPLICAS[0]);
    assert.equal(code, 0);
    assert.match(out, / built=1 /);
    // No waiting, no SYNC REPLICA: the pass itself waited.
    const after = await everyReplica(lines);
    assert.deepEqual(after.map(([row]) => Number(row.lines)), Array(3).fill(Number(before.lines) + 1));
    await resumed;
  });

  it("does nothing when nothing changed", async () => {
    const { code, out } = await cli(REFRESH, REPLICAS[2]);
    assert.equal(code, 0);
    assert.match(out, / checked=8 {2}built=0 {2}dropped=0 /);
  });
});

describe("the refresh account on a cluster", () => {
  const JOB = { user: "aggregate_refresh_test", password: "refresh-test" };

  before(async () => {
    const run = (statement) => sql(REPLICAS[0], statement);
    await run(`DROP USER IF EXISTS ${JOB.user} ON CLUSTER ${CLUSTER}`);
    // The statements of the deployment's account job, for this database.
    await run(`CREATE USER IF NOT EXISTS ${JOB.user} ON CLUSTER ${CLUSTER} IDENTIFIED BY '${JOB.password}'`);
    for (const grant of [
      "SELECT ON system.parts",
      "SELECT ON system.tables",
      "SELECT ON system.columns",
      "SELECT, INSERT ON agg_cluster.aggregate_state",
      "SELECT ON agg_cluster.sales",
      "SELECT, INSERT, ALTER DELETE ON agg_cluster.sales__agg_1day",
      "CREATE TABLE, DROP TABLE, SELECT, INSERT, TRUNCATE, ALTER MODIFY COMMENT ON agg_cluster.sales__agg_1day__staging",
    ]) {
      await run(`GRANT ON CLUSTER ${CLUSTER} ${grant} TO ${JOB.user}`);
    }
  });

  it("can run a pass through any replica with the documented privileges, and nothing more", async () => {
    await sql(
      REPLICAS[0],
      "INSERT INTO agg_cluster.sales VALUES ('t2', '2026-03-10 12:00:00', 'late-row', 'store0', 'p1', 11, 5, {'weight': 1}, now64(3))",
    );
    await synced("agg_cluster.sales");
    const { code, out, err } = await cli(REFRESH, REPLICAS[2], JOB);
    assert.deepEqual([code, err], [0, ""]);
    assert.match(out, / checked=8 {2}built=1 {2}dropped=0 /);
    await assertAggregateEqualsSourceEverywhere();

    await assert.rejects(sql(REPLICAS[1], "INSERT INTO agg_cluster.sales (partition) VALUES ('x')", JOB), /Not enough privileges/);
    await assert.rejects(sql(REPLICAS[1], `DROP TABLE ${AGGREGATE}`, JOB), /Not enough privileges/);
  });
});
