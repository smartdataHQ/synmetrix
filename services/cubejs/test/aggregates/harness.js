/**
 * Engine test harness: the disposable ClickHouse of
 * docker-compose.clickhouse.yml, fixtures, the fill path of the contract, and
 * a comparison that treats NULL as equal to NULL and not-a-number as equal to
 * not-a-number.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import ServerCoreModule from "@cubejs-backend/server-core";

import { createCatalog, probeAggregates } from "../../src/utils/aggregates/catalog.js";
import { fillSelect, quote } from "../../src/utils/aggregates/contract.js";

// The planner the deployed service runs with.
process.env.CUBEJS_TESSERACT_SQL_PLANNER ??= "true";
process.env.CUBEJS_LOG_LEVEL ??= "error";

export const ServerCore = ServerCoreModule.default || ServerCoreModule;

const target = new URL(process.env.AGGREGATES_TEST_CLICKHOUSE_URL || "http://test:test@127.0.0.1:18124");
const READS = /^\s*(SELECT|WITH|EXPLAIN|DESCRIBE|SHOW)\b/i;

const connectionParams = {
  host: target.hostname,
  port: Number(target.port) || 8123,
  username: decodeURIComponent(target.username),
  password: decodeURIComponent(target.password),
  database: "default",
};

let driver;
const connection = () => {
  driver ??= ServerCore.createDriver("clickhouse", connectionParams);
  return driver;
};

/** Runs one statement of any kind; rows for a read, an empty list otherwise. */
export async function run(sql, values) {
  if (READS.test(sql)) return connection().query(sql, values);
  await connection().command(sql);
  return [];
}

const others = [];

export async function close() {
  await driver?.release?.();
  driver = undefined;
  for (const other of others.splice(0)) await other.release?.();
}

/** `run` as another account of the test database. */
export function runAs(username, password) {
  const other = ServerCore.createDriver("clickhouse", { ...connectionParams, username, password });
  others.push(other);
  return async (sql, values) => {
    if (READS.test(sql)) return other.query(sql, values);
    await other.command(sql);
    return [];
  };
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

/** The statements Cube generates for a request, one per query: {text, values}. */
export async function sqlAll(cubejs, query, context = { securityContext: {}, requestId: "harness" }) {
  let answer;
  const withZone = (one) => ({ timezone: "UTC", ...one });
  await cubejs.apiGateway().sql({
    query: Array.isArray(query) ? query.map(withZone) : withZone(query),
    context,
    res: (body) => { answer = body; },
  });
  assert.ok(!answer?.error, `Cube refused the query: ${answer?.error}`);
  // one query: {sql: {…}}; several: [{sql: {…}}, …]
  return [answer].flat().map((one) => ({ text: one.sql.sql[0], values: one.sql.sql[1] }));
}

/** The statement Cube generates for a single query. */
export async function sqlFor(cubejs, query, context) {
  const statements = await sqlAll(cubejs, query, context);
  assert.equal(statements.length, 1);
  return statements[0];
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
  const textual = (value) => (typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) ? null : value);
  const key = (row) => JSON.stringify(Object.values(row).map(textual));
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

// ---------------------------------------------------------------------------
// The service's own wiring (index.js) around a real Cube gateway.

export const MODEL = readFileSync(
  new URL("../../src/utils/aggregates/__tests__/fixtures/sales_model.yml", import.meta.url),
  "utf8",
);

/** Statements issued by routing itself (catalog probes and expression parsing). */
export const issued = { statements: 0 };
const counted = async (sql) => {
  issued.statements += 1;
  return run(sql);
};
const routingDriver = async () => ({ query: counted });

/**
 * Replaces the loader of tenant model files (a Hasura call) with `schemas()`.
 * Call before anything imports repositoryFactory or routing.
 */
export async function stubSchemaLoader(mock, schemas) {
  const path = new URL("../../src/utils/dataSourceHelpers.js", import.meta.url).href;
  const real = await import(`${path}?real`);
  mock.module(path, { namedExports: { ...real, findDataSchemasByIds: async () => schemas() } });
}

export const securityContext = (patch = {}) => ({
  userScope: {
    dataSource: {
      dbType: "clickhouse",
      dataSourceVersion: "dsv-test",
      schemaVersion: "sv-test",
      files: ["f1"],
      dbParams: { database: "default" },
      ...patch,
    },
  },
});

let requests = 0;
export const requestContext = (patch) => {
  requests += 1;
  return { securityContext: securityContext(patch), requestId: `req-${requests}` };
};

// One catalog for every service of a test file; replaced when a test changes the database.
let catalog = null;
const currentCatalog = { lookup: (context) => (catalog ? catalog.lookup(context) : null) };

/** Reads the aggregates again and waits until they are in memory. */
export async function reloadCatalog() {
  const fresh = createCatalog({ driverFor: routingDriver, ttlMs: 3_600_000 });
  const context = securityContext();
  fresh.lookup(context);
  for (let attempt = 0; attempt < 200 && !fresh.lookup(context); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(fresh.lookup(context), "the catalog did not load");
  catalog = fresh;
  return fresh.lookup(context);
}

/**
 * A Cube server wired the way index.js wires it: the variant suffix in the app
 * id, the real repositoryFactory, and (with `routing`) the real hook.
 * `lines` receives the decision log.
 */
export async function service({ routing = true, lines = [], ...options } = {}) {
  const { default: repositoryFactory } = await import("../../src/utils/repositoryFactory.js");
  const { aggregateAppIdSuffix, installAggregateRouting } = await import("../../src/utils/aggregates/routing.js");
  const scope = (context) => context.securityContext?.userScope?.dataSource;
  const cubejs = new ServerCore({
    apiSecret: "aggregates-harness",
    devServer: false,
    telemetry: false,
    scheduledRefreshTimer: false,
    cacheAndQueueDriver: "memory",
    driverFactory: async () => ({ type: "clickhouse", ...connectionParams }),
    contextToAppId: (context) =>
      `CUBEJS_APP_${scope(context)?.dataSourceVersion}_${scope(context)?.schemaVersion}}${aggregateAppIdSuffix(context)}`,
    contextToOrchestratorId: (context) => `CUBEJS_APP_${scope(context)?.dataSourceVersion}_${scope(context)?.schemaVersion}}`,
    schemaVersion: (context) => scope(context)?.schemaVersion,
    repositoryFactory,
    ...options,
  });
  // As index.js: routes that issue SQL themselves (exports) get a driver instance from here.
  cubejs.tenantDriverFactory = async () => ServerCore.createDriver("clickhouse", connectionParams);
  cubejs.lines = lines;
  cubejs.routingInstalled = installAggregateRouting(cubejs, {
    enabled: routing,
    driverFor: routingDriver,
    catalog: currentCatalog,
    log: (line) => lines.push(line),
  });
  return cubejs;
}

/** Tables a statement reads, e.g. ["agg_test.sales__agg_1day"]. */
export const tablesOf = ({ text }) => [...new Set([...text.matchAll(/\bagg_test\.[A-Za-z0-9_]+/g)].map((match) => match[0]))];
