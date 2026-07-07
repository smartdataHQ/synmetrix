// Fleet-wide change detection (013, research D7): ONE GROUP BY partition
// probe per configured table answers "which teams' data moved" for the whole
// fleet — expensive per-team profiling then runs only for changed teams
// (SC-006/SC-007). Executes against the common store over the ClickHouse
// HTTP interface (no driver dependency in the actions service); connection
// details come from the same default-datasources config the provisioner uses.

import { readFileSync } from "fs";

const CONFIG_PATH =
  process.env.DEFAULT_DATASOURCES_CONFIG ||
  "/etc/synmetrix/default-datasources.json";

export const buildDriftQuery = ({ table, timeColumn }) =>
  `SELECT partition, count() AS row_count, max(${timeColumn}) AS max_event_time FROM ${table} GROUP BY partition FORMAT JSON`;

const resolveConnection = (config) => {
  let templates;
  try {
    templates = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
  const entry = (templates || []).find(
    (t) => t.name === config.targetDatasourceName
  );
  if (!entry?.db_params?.host) return null;

  const password = entry.secret_key ? process.env[entry.secret_key] : undefined;
  if (entry.secret_key && !password) return null;

  const { host, port, user, ssl } = entry.db_params;
  return {
    url: `${ssl ? "https" : "http"}://${host}:${port || (ssl ? 8443 : 8123)}/`,
    user: user || "default",
    password: password || "",
  };
};

const clickhouseExecute = async (sql, config) => {
  const connection = resolveConnection(config);
  if (!connection) {
    throw new Error(
      "drift probe: no ClickHouse connection resolvable from default-datasources config"
    );
  }
  const res = await fetch(connection.url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": connection.user,
      "X-ClickHouse-Key": connection.password,
    },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`drift probe failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text).data || [];
};

/**
 * Run every configured drift probe and merge into
 * partition -> { row_count, max_event_time }. Returns null when no probes
 * are configured — callers treat null as "every team changed".
 */
export const captureDriftSnapshot = async (config, deps = {}) => {
  const { executeSql = (sql) => clickhouseExecute(sql, config) } = deps;

  if (!config.driftProbes || config.driftProbes.length === 0) {
    return null;
  }

  const snapshot = {};
  for (const probe of config.driftProbes) {
    const rows = await executeSql(buildDriftQuery(probe));
    for (const row of rows) {
      const partition = row.partition;
      if (!partition) continue;
      const rowCount = Number(row.row_count) || 0;
      const maxTime = row.max_event_time || null;
      const existing = snapshot[partition];
      if (!existing) {
        snapshot[partition] = { row_count: rowCount, max_event_time: maxTime };
      } else {
        existing.row_count += rowCount;
        if (maxTime && (!existing.max_event_time || maxTime > existing.max_event_time)) {
          existing.max_event_time = maxTime;
        }
      }
    }
  }
  return snapshot;
};

/**
 * Diff two snapshots into the set of changed partitions. `null` (either
 * side missing) means "treat every team as changed". Partitions that
 * appeared, changed, or vanished all count as drift.
 */
export const diffDriftSnapshots = (previous, current) => {
  if (!previous || !current) {
    return null;
  }

  const changed = new Set();
  for (const [partition, stats] of Object.entries(current)) {
    const before = previous[partition];
    if (
      !before ||
      before.row_count !== stats.row_count ||
      before.max_event_time !== stats.max_event_time
    ) {
      changed.add(partition);
    }
  }
  for (const partition of Object.keys(previous)) {
    if (!(partition in current)) {
      changed.add(partition);
    }
  }
  return changed;
};
