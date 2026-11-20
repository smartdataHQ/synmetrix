/**
 * Keeps aggregates in step with their sources. Run by a scheduled job with
 * its own write credentials (scripts/aggregates.mjs refresh), never by query
 * pods.
 *
 * A source partition is summarised from a plain read, without duplicate
 * removal. What makes an aggregate partition exact is that it is rebuilt
 * whenever the source partition's set of parts has changed, which includes
 * the database merging the partition and dropping replaced rows.
 */
import { probeAggregates } from "./catalog.js";
import { PARTITION_ID, fillSelect, quote } from "./contract.js";

const STATE_COLUMNS = "(aggregate, partition_id, fingerprint, verified_at, covered_until, updated_at)";
// A change of the aggregate's partitions waits until every replica that is up has it. Without
// that, a replica could receive the refresh record, which is replicated on its own, a moment
// before the partition the record describes. A replica that is down is not waited for.
const ON_EVERY_REPLICA = "SETTINGS alter_sync = 2, replication_wait_for_inactive_replica_timeout = 0";
const stamp = (ms) => `fromUnixTimestamp64Milli(toInt64(${Math.trunc(ms)}), 'UTC')`;

/**
 * The staging table is local to the server the job is connected to and never
 * replicated, whatever the aggregate is: a copy of a replicated table's own
 * engine could claim the same replication path. It has the aggregate's keys
 * and storage policy, which swapping a partition requires.
 */
function stagingEngine({ partitionKey, sortingKey, primaryKey, storagePolicy }) {
  const settings = ["allow_nullable_key = 1", "allow_suspicious_low_cardinality_types = 1"];
  if (storagePolicy && storagePolicy !== "default") settings.push(`storage_policy = '${String(storagePolicy).replace(/[^A-Za-z0-9_-]/g, "")}'`);
  return (
    `ENGINE = AggregatingMergeTree PARTITION BY ${partitionKey} ORDER BY (${sortingKey})` +
    `${primaryKey && primaryKey !== sortingKey ? ` PRIMARY KEY (${primaryKey})` : ""} SETTINGS ${settings.join(", ")}`
  );
}

/**
 * One pass over one aggregate.
 *
 * @param {(sql: string) => Promise<object[]>} queryFn runs any statement; rows for a read
 * @param {object} structure the aggregate, as the catalog describes it
 * @returns {Promise<{checked: number, built: string[], dropped: string[], verifiedAt: number, coveredUntil: number}>}
 */
export async function refreshAggregate(queryFn, structure) {
  const { database, name, sourceTable, timeColumn } = structure;
  const target = `${quote(database)}.${quote(name)}`;
  const staging = `${quote(database)}.${quote(`${name}__staging`)}`;
  const state = `${quote(database)}.${quote("aggregate_state")}`;
  const time = `src.${quote(timeColumn)}`;

  // 1. The pass start, on the server's clock.
  const [{ now_ms: nowMs }] = await queryFn("SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms");
  const passStart = Number(nowMs);

  // 2. Every source partition: its fingerprint, then its oldest and newest time.
  //    A fingerprint read before a change makes the next pass rebuild; never the other way round.
  const fingerprints = await queryFn(
    "SELECT partition_id, toString(groupBitXor(cityHash64(name))) AS fingerprint FROM system.parts " +
      `WHERE database = '${database}' AND table = '${sourceTable}' AND active GROUP BY partition_id`,
  );
  const times = new Map(
    (
      await queryFn(
        `SELECT _partition_id AS partition_id, toUnixTimestamp64Milli(toDateTime64(min(${time}), 3)) AS oldest_ms, ` +
          `toUnixTimestamp64Milli(toDateTime64(max(${time}), 3)) AS newest_ms ` +
          `FROM ${quote(database)}.${quote(sourceTable)} AS src GROUP BY _partition_id`,
      )
    ).map((row) => [row.partition_id, { oldest: Number(row.oldest_ms), newest: Number(row.newest_ms) }]),
  );
  const source = fingerprints
    .filter((row) => times.has(row.partition_id))
    .map((row) => ({ id: row.partition_id, fingerprint: String(row.fingerprint), ...times.get(row.partition_id) }));
  for (const partition of source) {
    if (!PARTITION_ID.test(partition.id) || !/^\d+$/.test(partition.fingerprint)) {
      throw new Error("a partition id or fingerprint of the source is not plain");
    }
  }

  // 3. What was recorded, and what the aggregate has.
  const recorded = new Map(
    (
      await queryFn(
        `SELECT partition_id, toString(argMax(fingerprint, updated_at)) AS fingerprint FROM ${state} ` +
          `WHERE aggregate = '${name}' AND partition_id != '' GROUP BY partition_id`,
      )
    ).map((row) => [row.partition_id, String(row.fingerprint)]),
  );
  const held = (
    await queryFn(`SELECT DISTINCT partition_id FROM system.parts WHERE database = '${database}' AND table = '${name}' AND active`)
  ).map((row) => row.partition_id);
  for (const id of held) if (!PARTITION_ID.test(id)) throw new Error("a partition id of the aggregate is not plain");

  // 4. A partition belongs once its newest row is older than min_age.
  const cutoff = passStart - structure.minAgeSeconds * 1000;
  const belongs = (partition) => structure.minAgeSeconds === 0 || partition.newest < cutoff;
  const record = (partitionId, fingerprint) =>
    queryFn(`INSERT INTO ${state} ${STATE_COLUMNS} VALUES ('${name}', '${partitionId}', ${fingerprint}, now(), 0, now64(3))`);

  const alterPartition = async (statement) => {
    try {
      await queryFn(`${statement} ${ON_EVERY_REPLICA}`);
    } catch (error) {
      // UNFINISHED: applied on every replica that is up; one that is down applies it from the
      // replication log when it returns. Anything else is a failure.
      if (!/UNFINISHED/.test(String(error?.message || error))) throw error;
    }
  };

  const built = [];
  const dropped = [];
  let stagingCreated = false;
  try {
    for (const partition of source) {
      if (!belongs(partition)) continue;
      if (held.includes(partition.id) && recorded.get(partition.id) === partition.fingerprint) continue;
      if (!stagingCreated) {
        await queryFn(`DROP TABLE IF EXISTS ${staging} SYNC`);
        await queryFn(`CREATE TABLE ${staging} AS ${target} ${stagingEngine(structure)}`);
        stagingCreated = true;
        // The copy carries the binding comment; without it nothing takes the staging table for an aggregate.
        await queryFn(`ALTER TABLE ${staging} MODIFY COMMENT ''`);
      }
      const fill = fillSelect(structure, partition.id);
      await queryFn(`INSERT INTO ${staging} (${fill.columns.map(quote).join(", ")}) ${fill.sql}`);
      // Every bucket of a source partition must fall into the aggregate partition of the same id.
      // If one does not (a grain or a time zone that does not nest), swapping would lose it.
      const [{ strays }] = await queryFn(
        `SELECT count() AS strays FROM system.parts WHERE database = '${database}' AND table = '${name}__staging' ` +
          `AND active AND partition_id != '${partition.id}'`,
      );
      if (Number(strays) > 0) throw new Error("the aggregate's buckets do not nest inside the source's partitions");
      // One step: a reader sees the partition's old content or its new content.
      await alterPartition(`ALTER TABLE ${target} REPLACE PARTITION ID '${partition.id}' FROM ${staging}`);
      await queryFn(`TRUNCATE TABLE ${staging}`);
      await record(partition.id, partition.fingerprint);
      built.push(partition.id);
    }

    // 5. Partitions whose source is gone, or that no longer belong.
    const belonging = new Set(source.filter(belongs).map((partition) => partition.id));
    for (const id of held) {
      if (belonging.has(id)) continue;
      await alterPartition(`ALTER TABLE ${target} DROP PARTITION ID '${id}'`);
      await record(id, 0);
      dropped.push(id);
    }

    // 6. Every step succeeded: the aggregate is verified as of the pass start,
    //    and holds everything before the oldest row of a partition it does not hold.
    const notHeld = source.filter((partition) => !belonging.has(partition.id));
    const coveredUntil = notHeld.length ? Math.min(...notHeld.map((partition) => partition.oldest)) : passStart;
    await queryFn(
      `INSERT INTO ${state} ${STATE_COLUMNS} VALUES ('${name}', '', 0, toDateTime(${stamp(passStart)}), ${stamp(coveredUntil)}, now64(3))`,
    );
    return { checked: source.length, built, dropped, verifiedAt: passStart, coveredUntil };
  } finally {
    // 7.
    if (stagingCreated) {
      try {
        await queryFn(`DROP TABLE IF EXISTS ${staging} SYNC`);
      } catch {
        // the next pass starts by dropping it
      }
    }
  }
}

/**
 * One pass over every accepted aggregate of the server, each on its own: a
 * failure in one does not stop the others.
 *
 * @param {(sql: string) => Promise<object[]>} queryFn
 * @param {{only?: string}} [options] `only`: "database.aggregate"
 */
export async function refreshAll(queryFn, { only } = {}) {
  const entry = await probeAggregates(queryFn);
  const targets = entry.aggregates.filter((aggregate) => !only || aggregate.table === only);
  const results = [];
  if (only && targets.length === 0) {
    results.push({ aggregate: only, ok: false, error: "not an accepted aggregate", durationMs: 0 });
  }
  for (const structure of targets) {
    const started = performance.now();
    try {
      const outcome = await refreshAggregate(queryFn, structure);
      results.push({ aggregate: structure.table, ok: true, ...outcome, durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      results.push({
        aggregate: structure.table,
        ok: false,
        error: error?.message || String(error),
        durationMs: Math.round(performance.now() - started),
      });
    }
  }
  return { results, rejected: entry.rejected };
}
