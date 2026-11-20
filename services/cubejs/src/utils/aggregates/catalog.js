/**
 * Which aggregate tables a data source has, what they hold and how current
 * they are. Read with at most four statements per data source and kept for a
 * minute. A lookup never waits: it answers from memory and refreshes in the
 * background, so the first queries after a start are simply not routed.
 */
import { IDENTIFIER, classifyColumns, parseBinding, quote, structureFingerprint } from "./contract.js";

const DEFAULT_TTL_MS = 60_000;
const MAX_DATA_SOURCES = 500;
const STATE_TABLE = "aggregate_state";
const BINDING_PREFIX = '{"aggregate_of"';

const literal = (text) => `'${text}'`; // only ever called with validated identifiers
const pairs = (tables) => tables.map(({ database, name }) => `(${literal(database)}, ${literal(name)})`).join(", ");
const normalised = (expression) => String(expression || "").replace(/\s+/g, " ").trim();

const emptyEntry = (loadedAt) => ({ loadedAt, serverNowAtLoad: null, aggregates: [], rejected: [] });

/** The server's clock now: its value at the probe, advanced by the time passed in this process. */
export const serverNow = (entry, now) =>
  entry.serverNowAtLoad == null ? Date.now() : entry.serverNowAtLoad + (now() - entry.loadedAt);

/**
 * Reads the aggregates of one data source.
 *
 * @param {(sql: string) => Promise<object[]>} queryFn
 * @returns {Promise<{loadedAt: number, serverNowAtLoad: number|null, aggregates: object[], rejected: object[]}>}
 */
export async function probeAggregates(queryFn, now = () => performance.now()) {
  const entry = emptyEntry(now());

  // 1. Tables that declare a binding, and the databases that keep refresh records.
  const tables = await queryFn(
    "SELECT database, name, comment, partition_key, sorting_key, primary_key, storage_policy, total_rows FROM system.tables " +
      `WHERE startsWith(comment, '${BINDING_PREFIX}') OR name = '${STATE_TABLE}'`,
  );
  const stateDatabases = new Set();
  const candidates = [];
  for (const row of tables) {
    if (row.name === STATE_TABLE && !String(row.comment || "").startsWith(BINDING_PREFIX)) {
      if (IDENTIFIER.test(row.database)) stateDatabases.add(row.database);
      continue;
    }
    const table = `${row.database}.${row.name}`;
    const { binding } = parseBinding(row.comment);
    if (!binding || !IDENTIFIER.test(row.database) || !IDENTIFIER.test(row.name) || binding.database !== row.database) {
      entry.rejected.push({ table, reason: "invalid_binding" });
      continue;
    }
    candidates.push({ row, table, binding });
  }
  if (candidates.length === 0) return entry;

  // 2. The tables they summarise.
  const sourceTables = unique(candidates.map(({ binding }) => ({ database: binding.database, name: binding.sourceTable })));
  const sources = new Map(
    (await queryFn(`SELECT database, name, partition_key FROM system.tables WHERE (database, name) IN (${pairs(sourceTables)})`)).map(
      (row) => [`${row.database}.${row.name}`, row],
    ),
  );

  // 3. Their columns, and the time column of each source.
  const timeColumns = [...new Set(candidates.map(({ binding }) => binding.timeColumn))];
  const columnRows = await queryFn(
    "SELECT database, table, name, type, is_in_sorting_key FROM system.columns " +
      `WHERE (database, table) IN (${pairs(candidates.map(({ row }) => row))}) ` +
      `OR ((database, table) IN (${pairs(sourceTables)}) AND name IN (${timeColumns.map(literal).join(", ")})) ` +
      "ORDER BY database, table, position",
  );
  const columnsOf = new Map();
  for (const row of columnRows) {
    const key = `${row.database}.${row.table}`;
    if (!columnsOf.has(key)) columnsOf.set(key, []);
    columnsOf.get(key).push(row);
  }

  // 4. Refresh records, with the server's clock.
  const records = new Map();
  const withState = [...new Set(candidates.map(({ row }) => row.database))].filter((database) => stateDatabases.has(database));
  if (withState.length > 0) {
    const perDatabase = withState.map(
      (database) =>
        `SELECT ${literal(database)} AS database, aggregate, ` +
        "toUnixTimestamp64Milli(toDateTime64(argMax(verified_at, updated_at), 3)) AS verified_ms, " +
        "toUnixTimestamp64Milli(argMax(covered_until, updated_at)) AS covered_ms, " +
        "toUnixTimestamp64Milli(now64(3)) AS now_ms " +
        `FROM ${quote(database)}.${quote(STATE_TABLE)} WHERE partition_id = '' GROUP BY aggregate`,
    );
    const rows = await queryFn(
      "SELECT '' AS database, '' AS aggregate, 0 AS verified_ms, 0 AS covered_ms, toUnixTimestamp64Milli(now64(3)) AS now_ms " +
        `UNION ALL ${perDatabase.join(" UNION ALL ")}`,
    );
    for (const row of rows) {
      entry.serverNowAtLoad = Number(row.now_ms);
      if (row.aggregate) records.set(`${row.database}.${row.aggregate}`, row);
    }
  }

  for (const { row, table, binding } of candidates) {
    const source = sources.get(binding.source);
    const sourceColumns = columnsOf.get(binding.source) || [];
    const columns = classifyColumns(columnsOf.get(table) || [], binding);
    let reason = null;
    if (!source) reason = "source_missing";
    else if (
      !sourceColumns.some((column) => column.name === binding.timeColumn) ||
      columns.get(binding.timeColumn)?.role !== "time"
    ) {
      reason = "time_column_missing";
    } else if (normalised(row.partition_key) !== normalised(source.partition_key)) reason = "partition_key_mismatch";
    if (reason) {
      entry.rejected.push({ table, reason });
      continue;
    }
    const record = records.get(table);
    entry.aggregates.push({
      table,
      name: row.name,
      ...binding,
      partitionKey: row.partition_key,
      sortingKey: row.sorting_key,
      primaryKey: row.primary_key,
      storagePolicy: row.storage_policy,
      totalRows: Number(row.total_rows) || 0,
      columns,
      verifiedAt: record ? Number(record.verified_ms) : null,
      coveredUntil: record ? Number(record.covered_ms) : null,
      fingerprint: structureFingerprint(binding, columnsOf.get(table) || []),
    });
  }
  return entry;
}

function unique(tables) {
  return [...new Map(tables.map((table) => [`${table.database}.${table.name}`, table])).values()];
}

/**
 * @param {{driverFor: (securityContext: object) => Promise<{query: Function, release?: Function}>,
 *   ttlMs?: number, now?: () => number}} options `now` is a monotonic clock in milliseconds
 */
export function createCatalog({ driverFor, ttlMs = DEFAULT_TTL_MS, now = () => performance.now() }) {
  const slots = new Map();

  const refresh = async (slot, securityContext) => {
    slot.loading = true;
    let driver;
    try {
      driver = await driverFor(securityContext);
      slot.entry = await probeAggregates((sql) => driver.query(sql), now);
    } catch (error) {
      // Fail safe: with no catalog nothing is routed. Tried again after one lifetime.
      console.warn(`aggregate routing: catalog probe failed: ${error?.message || error}`);
      slot.entry = emptyEntry(now());
    } finally {
      slot.loading = false;
      try {
        await driver?.release?.();
      } catch {
        // a driver that fails to close has nothing more to give
      }
    }
  };

  return {
    /** The catalog of the context's data source as it is in memory: null until the first probe is done. */
    lookup(securityContext) {
      const dataSource = securityContext?.userScope?.dataSource;
      const key = dataSource?.dataSourceVersion;
      if (!key) return null;
      if (dataSource.dbType !== "clickhouse") return emptyEntry(now());

      let slot = slots.get(key);
      if (!slot) {
        if (slots.size >= MAX_DATA_SOURCES) slots.delete(slots.keys().next().value);
        slot = { entry: null, loading: false };
        slots.set(key, slot);
      }
      if (!slot.loading && (!slot.entry || now() - slot.entry.loadedAt >= ttlMs)) {
        refresh(slot, securityContext);
      }
      return slot.entry;
    },
  };
}
