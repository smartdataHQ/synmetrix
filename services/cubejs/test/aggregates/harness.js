/**
 * Engine test harness: the disposable ClickHouse of
 * docker-compose.clickhouse.yml, fixtures, the fill path of the contract, and
 * a comparison that treats NULL as equal to NULL and not-a-number as equal to
 * not-a-number.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import ServerCoreModule from "@cubejs-backend/server-core";

import { probeAggregates } from "../../src/utils/aggregates/catalog.js";
import { fillSelect, quote } from "../../src/utils/aggregates/contract.js";

export const ServerCore = ServerCoreModule.default || ServerCoreModule;

const target = new URL(process.env.AGGREGATES_TEST_CLICKHOUSE_URL || "http://test:test@127.0.0.1:18124");
const READS = /^\s*(SELECT|WITH|EXPLAIN|DESCRIBE|SHOW)\b/i;

let driver;
const connection = () => {
  driver ??= ServerCore.createDriver("clickhouse", {
    host: target.hostname,
    port: Number(target.port) || 8123,
    username: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    database: "default",
  });
  return driver;
};

/** Runs one statement of any kind; rows for a read, an empty list otherwise. */
export async function run(sql, values) {
  if (READS.test(sql)) return connection().query(sql, values);
  await connection().command(sql);
  return [];
}

export async function close() {
  await driver?.release?.();
  driver = undefined;
}

/** Runs every statement of fixtures/<name>.sql. */
export async function loadFixture(name) {
  const text = readFileSync(new URL(`./fixtures/${name}.sql`, import.meta.url), "utf8");
  const statements = text
    .split(/;\s*\n/)
    .map((statement) => statement.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  for (const statement of statements) await run(statement);
}

/** The structure the catalog reads for one aggregate, e.g. "agg_test.sales__agg_1day". */
export async function structureOf(table) {
  const entry = await probeAggregates(run);
  const structure = entry.aggregates.find((aggregate) => aggregate.table === table);
  assert.ok(structure, `no accepted aggregate ${table}: ${JSON.stringify(entry.rejected)}`);
  return structure;
}

const stateTable = (structure) => `${quote(structure.database)}.${quote("aggregate_state")}`;
const aggregateRef = (structure) => `${quote(structure.database)}.${quote(structure.name)}`;
const sourceRef = (structure) => `${quote(structure.database)}.${quote(structure.sourceTable)}`;

/** Partition ids and fingerprints of the source, as the refresh reads them. */
export async function sourcePartitions(structure) {
  return run(
    "SELECT partition_id, toString(groupBitXor(cityHash64(name))) AS fingerprint FROM system.parts " +
      `WHERE database = '${structure.database}' AND table = '${structure.sourceTable}' AND active GROUP BY partition_id ORDER BY partition_id`,
  );
}

/**
 * Builds one aggregate partition from a plain read of the source partition
 * (contract.fillSelect), swaps it in and records the fingerprint read before.
 */
export async function fillPartition(structure, { partition_id: partitionId, fingerprint }) {
  const staging = `${quote(structure.database)}.${quote(`${structure.name}__staging`)}`;
  await run(`DROP TABLE IF EXISTS ${staging} SYNC`);
  await run(`CREATE TABLE ${staging} AS ${aggregateRef(structure)}`);
  await run(`ALTER TABLE ${staging} MODIFY COMMENT ''`);
  try {
    const { sql, columns } = fillSelect(structure, partitionId);
    await run(`INSERT INTO ${staging} (${columns.map(quote).join(", ")}) ${sql}`);
    await run(`ALTER TABLE ${aggregateRef(structure)} REPLACE PARTITION ID '${partitionId}' FROM ${staging}`);
    await run(
      `INSERT INTO ${stateTable(structure)} (aggregate, partition_id, fingerprint, verified_at, covered_until, updated_at) ` +
        `VALUES ('${structure.name}', '${partitionId}', ${fingerprint}, now(), 0, now64(3))`,
    );
  } finally {
    await run(`DROP TABLE IF EXISTS ${staging} SYNC`);
  }
}

/** Builds every partition of the source and records a complete pass. */
export async function fillAll(structure, { coveredUntil } = {}) {
  for (const partition of await sourcePartitions(structure)) await fillPartition(structure, partition);
  await recordPass(structure, { coveredUntil });
}

/** Writes the aggregate-level refresh record: verified now, holding data up to `coveredUntil` (default: now). */
export async function recordPass(structure, { verifiedAt = "now()", coveredUntil } = {}) {
  const covered = coveredUntil ? `toDateTime64('${coveredUntil}', 3, 'UTC')` : "now64(3)";
  await run(
    `INSERT INTO ${stateTable(structure)} (aggregate, partition_id, fingerprint, verified_at, covered_until, updated_at) ` +
      `VALUES ('${structure.name}', '', 0, ${verifiedAt}, ${covered}, now64(3))`,
  );
}

/** Lets the database merge the source and remove replaced rows. */
export async function mergeSource(structure) {
  await run(`SYSTEM START MERGES ${sourceRef(structure)}`);
  await run(`OPTIMIZE TABLE ${sourceRef(structure)} FINAL`);
  await run(`SYSTEM STOP MERGES ${sourceRef(structure)}`);
}

let serial = 0;

/** A Cube gateway over the given model files, with nothing of this service around it. */
export function cubeFor(files, options = {}) {
  serial += 1;
  const id = serial;
  const cubejs = new ServerCore({
    apiSecret: "aggregates-harness",
    devServer: false,
    telemetry: false,
    scheduledRefreshTimer: false,
    cacheAndQueueDriver: "memory",
    driverFactory: async () => ({ type: "clickhouse", host: "unused" }),
    contextToAppId: () => `HARNESS_${id}`,
    contextToOrchestratorId: () => `HARNESS_${id}`,
    repositoryFactory: () => ({ dataSchemaFiles: async () => files }),
    ...options,
  });
  return cubejs;
}

/** The statement Cube generates for a query: [text, values]. */
export async function sqlFor(cubejs, query, context = { securityContext: {}, requestId: "harness" }) {
  let answer;
  await cubejs.apiGateway().sql({ query: { timezone: "UTC", ...query }, context, res: (body) => { answer = body; } });
  assert.ok(!answer?.error, `Cube refused the query: ${answer?.error}`);
  const [text, values] = answer.sql.sql;
  return { text, values };
}

/** Runs a statement Cube generated. */
export const execute = ({ text, values }) => run(text, values);

const close9 = (left, right) =>
  Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));

function sameValue(left, right) {
  if (left === null || right === null || left === undefined || right === undefined) return left == right;
  const [a, b] = [Number(left), Number(right)];
  const numeric = (value, parsed) => typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(parsed));
  if (Number.isNaN(a) && Number.isNaN(b) && (typeof left === "number" || left === "nan") ) return true;
  if (numeric(left, a) && numeric(right, b)) return close9(a, b);
  return String(left) === String(right);
}

/**
 * Asserts two results hold the same rows with the same column names in the
 * same order. Rows are compared as a set unless `ordered` is given.
 */
export function assertSameRows(actual, expected, { ordered = false, label = "" } = {}) {
  assert.equal(actual.length, expected.length, `${label}: row count ${actual.length} != ${expected.length}`);
  if (expected.length === 0) return;
  assert.deepEqual(Object.keys(actual[0]), Object.keys(expected[0]), `${label}: output columns differ`);
  const key = (row) => JSON.stringify(Object.values(row).map((value) => (typeof value === "number" ? null : value)));
  const sorted = (rows) => (ordered ? rows : [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));
  const [left, right] = [sorted(actual), sorted(expected)];
  left.forEach((row, index) => {
    for (const column of Object.keys(row)) {
      assert.ok(
        sameValue(row[column], right[index][column]),
        `${label}: row ${index}, ${column}: ${row[column]} != ${right[index][column]}\n${JSON.stringify(row)}\n${JSON.stringify(right[index])}`,
      );
    }
  });
}
