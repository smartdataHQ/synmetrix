import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { main } from "../../../../scripts/aggregates.mjs";
import { prepare, replay } from "./fixtures/ast/replay.js";

const NOW = Date.UTC(2026, 10, 20, 12);
const saf = (fn, type) => `SimpleAggregateFunction(${fn}, ${type})`;
const KEY = "(partition, toStartOfMonth(timestamp))";
const binding = (grain) =>
  `{"aggregate_of": "agg_test.sales", "time_column": "timestamp", "grain": "${grain}", "min_age": "7 day", "min_window": "60 day", "max_staleness": "1 day"}`;
const columnsOf = (table) => [
  { database: "agg_test", table, name: "partition", type: "String", is_in_sorting_key: 1 },
  { database: "agg_test", table, name: "timestamp", type: "DateTime64(3)", is_in_sorting_key: 1 },
  { database: "agg_test", table, name: "units", type: saf("sum", "Float64"), is_in_sorting_key: 0 },
];

/** A fake server with two aggregates of one source; writes that mention `broken` fail. */
function server({ broken } = {}) {
  const statements = [];
  const queryFn = async (sql) => {
    statements.push(sql);
    if (/FROM system\.tables WHERE startsWith/.test(sql)) {
      return [
        { database: "agg_test", name: "sales__agg_1day", comment: binding("1 day"), partition_key: KEY, sorting_key: "partition, timestamp", total_rows: "10" },
        { database: "agg_test", name: "sales__agg_30minute", comment: binding("30 minute"), partition_key: KEY, sorting_key: "partition, timestamp", total_rows: "20" },
        { database: "agg_test", name: "half_done", comment: '{"aggregate_of": "agg_test.sales"}', partition_key: KEY, sorting_key: "", total_rows: "0" },
        { database: "agg_test", name: "aggregate_state", comment: "", partition_key: "", sorting_key: "", total_rows: "0" },
      ];
    }
    if (/partition_key FROM system\.tables WHERE \(database, name\) IN/.test(sql)) return [{ database: "agg_test", name: "sales", partition_key: KEY }];
    if (/FROM system\.columns/.test(sql)) {
      return [...columnsOf("sales__agg_1day"), ...columnsOf("sales__agg_30minute"), { database: "agg_test", table: "sales", name: "timestamp", type: "DateTime64(3)", is_in_sorting_key: 1 }];
    }
    if (/UNION ALL/.test(sql)) return [{ database: "", aggregate: "", verified_ms: "0", covered_ms: "0", now_ms: String(NOW) }];
    if (broken && sql.includes(broken) && !/^SELECT/.test(sql)) throw new Error("disk full");
    if (/now_ms$/.test(sql)) return [{ now_ms: String(NOW) }];
    if (/groupBitXor/.test(sql)) return [{ partition_id: "p09", fingerprint: "109" }];
    if (/GROUP BY _partition_id$/.test(sql)) return [{ partition_id: "p09", oldest_ms: String(Date.UTC(2026, 8, 1)), newest_ms: String(Date.UTC(2026, 8, 28)) }];
    if (/^SELECT count\(\) AS strays/.test(sql)) return [{ strays: "0" }];
    return [];
  };
  return { queryFn, statements };
}

/** Runs the command line against a fake connection; collects what it prints. */
async function cli(args, { queryFn, connectError } = {}) {
  const printed = { out: [], err: [] };
  let closed = 0;
  const code = await main(args, {
    env: { AGGREGATES_CLICKHOUSE_URL: "http://unused:8123" },
    connect: async () => {
      if (connectError) throw new Error(connectError);
      return { queryFn, close: async () => { closed += 1; } };
    },
    out: (text) => printed.out.push(text),
    err: (text) => printed.err.push(text),
  });
  return { code, closed, out: printed.out.join("\n"), err: printed.err.join("\n"), lines: printed.out };
}

describe("aggregates.mjs refresh", () => {
  it("exits 0 when every aggregate was verified, with one line per aggregate", async () => {
    const { queryFn } = server();
    const { code, lines, err, closed } = await cli(["refresh"], { queryFn });
    assert.equal(code, 0);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^refresh {2}aggregate=agg_test\.sales__agg_1day {2}checked=1 {2}built=1 {2}dropped=0 {2}ms=\d+$/);
    assert.match(lines[1], /^refresh {2}aggregate=agg_test\.sales__agg_30minute {2}checked=1 {2}built=1 {2}dropped=0 {2}ms=\d+$/);
    assert.equal(err, "refresh  ignored=agg_test.half_done  reason=invalid_binding");
    assert.equal(closed, 1);
  });

  it("limits the pass with --only", async () => {
    const { queryFn, statements } = server();
    const { code, lines } = await cli(["refresh", "--only", "agg_test.sales__agg_30minute"], { queryFn });
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /aggregate=agg_test\.sales__agg_30minute /);
    assert.ok(!statements.some((sql) => sql.includes("sales__agg_1day__staging")));
  });

  it("exits 3 when an aggregate failed, and still refreshes the others", async () => {
    const { queryFn } = server({ broken: "sales__agg_1day__staging" });
    const { code, lines, err } = await cli(["refresh"], { queryFn });
    assert.equal(code, 3);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /aggregate=agg_test\.sales__agg_30minute /);
    assert.match(err, /^refresh {2}aggregate=agg_test\.sales__agg_1day {2}failed {2}ms=\d+ {2}disk full$/m);
  });

  it("exits 3 when --only names something that is not an accepted aggregate", async () => {
    const { queryFn } = server();
    const { code, err } = await cli(["refresh", "--only", "agg_test.half_done"], { queryFn });
    assert.equal(code, 3);
    assert.match(err, /aggregate=agg_test\.half_done {2}failed {2}ms=0 {2}not an accepted aggregate/);
  });

  it("exits 1 when it cannot connect or the server cannot be read", async () => {
    const refused = await cli(["refresh"], { connectError: "ECONNREFUSED" });
    assert.deepEqual([refused.code, refused.err], [1, "error: ECONNREFUSED"]);
    const unreadable = await cli(["refresh"], { queryFn: async () => { throw new Error("authentication failed"); } });
    assert.deepEqual([unreadable.code, unreadable.err, unreadable.closed], [1, "error: authentication failed", 1]);
  });
});

describe("aggregates.mjs generate", () => {
  before(() => prepare("generator_sources"));

  const OPTIONS = [
    "--source", "gen_test.retail_lines", "--time-column", "timestamp", "--grain", "1 day",
    "--group-by", "partition,store,category,product_id,uom,bundled_units,unit_price,tax_rate",
    "--min-age", "7 day", "--min-window", "60 day", "--max-staleness", "1 day",
  ];
  /** Recorded answers of the disposable ClickHouse; `patch` rewrites the source's row of system.tables. */
  const recorded = (patch) => {
    const statements = [];
    const queryFn = async (sql) => {
      statements.push(sql);
      const rows = await replay(sql);
      return patch && /FROM system\.tables/.test(sql) ? rows.map((row) => ({ ...row, ...patch })) : rows;
    };
    return { queryFn, statements };
  };

  it("prints the definition, then the left-out columns", async () => {
    const { queryFn, statements } = recorded();
    const { code, out, err, closed } = await cli(["generate", ...OPTIONS], { queryFn });
    assert.deepEqual([code, err, closed], [0, "", 1]);
    assert.ok(out.startsWith("CREATE TABLE IF NOT EXISTS gen_test.retail_lines__agg_1day\n("));
    const [definitionAt, leftOutAt] = [out.indexOf("COMMENT '"), out.indexOf("-- Left out:")];
    assert.ok(definitionAt > 0 && leftOutAt > definitionAt);
    assert.doesNotMatch(out, /MODIFY SETTING/);
    for (const sql of statements) assert.match(sql, /^(SELECT|DESCRIBE) /); // nothing that changes data
  });

  it("prints the forced-merge statement last when the source needs it, and passes --cluster on", async () => {
    const { queryFn } = recorded({ engine: "ReplicatedReplacingMergeTree", engine_full: "ReplicatedReplacingMergeTree ORDER BY y" });
    const { code, out } = await cli(["generate", ...OPTIONS, "--cluster", "main"], { queryFn });
    assert.equal(code, 0);
    assert.match(out, /^CREATE TABLE IF NOT EXISTS gen_test\.retail_lines__agg_1day ON CLUSTER main\n/);
    assert.ok(out.indexOf("-- Left out:") < out.indexOf("-- The source is a ReplicatedReplacingMergeTree table"));
    assert.ok(out.trimEnd().endsWith("--   ALTER TABLE gen_test.retail_lines ON CLUSTER main MODIFY SETTING min_age_to_force_merge_seconds = 604800, min_age_to_force_merge_on_partition_only = 1;"));
  });

  it("exits 2 with the reason on standard error when it declines", async () => {
    const { queryFn } = recorded();
    const args = OPTIONS.map((value) => (value === "1 day" ? "7 hour" : value));
    const { code, out, err } = await cli(["generate", ...args], { queryFn });
    assert.deepEqual([code, out, err], [2, "", "declined: the grain does not divide one day"]);
  });

  it("requires every option but --cluster", async () => {
    for (const option of ["--source", "--time-column", "--grain", "--group-by", "--min-age", "--min-window", "--max-staleness"]) {
      const at = OPTIONS.indexOf(option);
      const args = [...OPTIONS.slice(0, at), ...OPTIONS.slice(at + 2)];
      const { code, err, out } = await cli(["generate", ...args], { queryFn: async () => [] });
      assert.deepEqual([code, out, err], [1, "", `error: missing option ${option}`], option);
    }
  });

  it("exits 1 on a connection error, an unknown option or an unknown command", async () => {
    assert.equal((await cli(["generate", ...OPTIONS], { connectError: "ECONNREFUSED" })).code, 1);
    const unknownOption = await cli(["generate", ...OPTIONS, "--execute"], { queryFn: async () => [] });
    assert.equal(unknownOption.code, 1);
    assert.match(unknownOption.err, /^error: /);
    const unknownCommand = await cli(["rebuild"], { queryFn: async () => [] });
    assert.deepEqual([unknownCommand.code, unknownCommand.err], [1, "error: usage: aggregates.mjs generate|refresh [options]"]);
  });
});
