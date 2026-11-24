#!/usr/bin/env node
/**
 * Aggregate tables for query routing (015):
 *
 *   node scripts/aggregates.mjs generate --source db.table --time-column col --grain "1 day" \
 *        (--group-by a,b | --exclude x,y) --min-age "7 day" --min-window "60 day" --max-staleness "1 day" [--cluster name]
 *   node scripts/aggregates.mjs refresh [--only db.aggregate]
 *
 * `generate` prints a definition and executes nothing that changes data.
 * `refresh` brings every aggregate in step with its source; run it on a
 * schedule. Both use their own connection (AGGREGATES_CLICKHOUSE_URL, _USER,
 * _PASSWORD), never a tenant's. The URL must address one replica: refresh
 * builds in a staging table that exists on the server it is connected to.
 *
 * Contract: specs/015-aggregate-routing/contracts/aggregates-cli.md
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { generate, render } from "../src/utils/aggregates/generator.js";
import { refreshAll } from "../src/utils/aggregates/refresh.js";

const READS = /^\s*(SELECT|WITH|EXPLAIN|DESCRIBE|SHOW)\b/i;
const USAGE = "usage: aggregates.mjs generate|refresh [options]";
const GENERATE_REQUIRED = ["source", "time-column", "grain", "min-age", "min-window", "max-staleness"];
const GENERATE_OPTIONAL = ["group-by", "exclude", "cluster"];

/** A connection through the service's own ClickHouse driver. */
export async function connect(env) {
  const url = new URL(env.AGGREGATES_CLICKHOUSE_URL || "");
  const { default: ServerCoreModule } = await import("@cubejs-backend/server-core");
  const ServerCore = ServerCoreModule.default || ServerCoreModule;
  const driver = ServerCore.createDriver("clickhouse", {
    host: url.hostname,
    port: Number(url.port) || (url.protocol === "https:" ? 8443 : 8123),
    protocol: url.protocol,
    username: env.AGGREGATES_CLICKHOUSE_USER,
    password: env.AGGREGATES_CLICKHOUSE_PASSWORD,
    database: "default",
  });
  return {
    queryFn: async (sql) => {
      if (READS.test(sql)) return driver.query(sql);
      await driver.command(sql);
      return [];
    },
    close: () => driver.release(),
  };
}

/** @returns {Promise<number>} the exit code */
export async function main(argv, { env = process.env, connect: open = connect, out = console.log, err = console.error } = {}) {
  let connection;
  try {
    const [command, ...rest] = argv;
    if (command !== "generate" && command !== "refresh") throw new Error(USAGE);
    const { values } = parseArgs({
      args: rest,
      options:
        command === "generate"
          ? Object.fromEntries([...GENERATE_REQUIRED, ...GENERATE_OPTIONAL].map((name) => [name, { type: "string" }]))
          : {
              only: { type: "string" },
              "max-partitions": { type: "string" },
              "sleep-ms": { type: "string" },
              order: { type: "string" },
              "max-threads": { type: "string" },
              "max-insert-threads": { type: "string" },
              "max-memory-bytes": { type: "string" },
              "max-external-group-by-bytes": { type: "string" },
              "max-external-sort-bytes": { type: "string" },
              priority: { type: "string" },
              "include-completed-days": { type: "boolean" },
            },
    });
    if (command === "generate") {
      const missing = GENERATE_REQUIRED.find((name) => values[name] === undefined);
      if (missing) throw new Error(`missing option --${missing}`);
      if (values["group-by"] === undefined && values.exclude === undefined) {
        throw new Error("missing option --group-by or --exclude");
      }
      if (values["group-by"] !== undefined && values.exclude !== undefined) {
        throw new Error("use either --group-by or --exclude, not both");
      }
    }

    connection = await open(env);
    if (command === "generate") {
      const splitList = (raw) => raw.split(",").map((name) => name.trim()).filter(Boolean);
      const result = await generate(connection.queryFn, {
        source: values.source,
        timeColumn: values["time-column"],
        grain: values.grain,
        ...(values["group-by"] !== undefined ? { groupBy: splitList(values["group-by"]) } : {}),
        ...(values.exclude !== undefined ? { exclude: splitList(values.exclude) } : {}),
        minAge: values["min-age"],
        minWindow: values["min-window"],
        maxStaleness: values["max-staleness"],
        cluster: values.cluster,
      });
      if (result.declined) {
        err(`declined: ${result.declined}`);
        return 2;
      }
      out(render(result).trimEnd());
      return 0;
    }

    const settings = {};
    const optNum = (flag, key) => {
      if (values[flag] !== undefined) settings[key] = Number(values[flag]);
    };
    optNum("max-threads", "max_threads");
    optNum("max-insert-threads", "max_insert_threads");
    optNum("max-memory-bytes", "max_memory_usage");
    optNum("max-external-group-by-bytes", "max_bytes_before_external_group_by");
    optNum("max-external-sort-bytes", "max_bytes_before_external_sort");
    optNum("priority", "priority");

    const { results, rejected } = await refreshAll(connection.queryFn, {
      only: values.only,
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(values["sleep-ms"] !== undefined ? { sleepMs: Number(values["sleep-ms"]) } : {}),
      ...(values["max-partitions"] !== undefined ? { maxPartitions: Number(values["max-partitions"]) } : {}),
      ...(values.order !== undefined ? { order: values.order } : {}),
      ...(values["include-completed-days"] !== undefined ? { includeCompletedDays: values["include-completed-days"] } : {}),
    });
    for (const { table, reason } of rejected) err(`refresh  ignored=${table}  reason=${reason}`);
    for (const result of results) {
      // Names, counts and durations only: no row values.
      if (result.ok) {
        const extra = result.partial ? `  remaining=${result.remaining}  partial=true` : "";
        out(`refresh  aggregate=${result.aggregate}  checked=${result.checked}  built=${result.built.length}  dropped=${result.dropped.length}${extra}  ms=${result.durationMs}`);
      } else err(`refresh  aggregate=${result.aggregate}  failed  ms=${result.durationMs}  ${result.error}`);
    }
    return results.some((result) => !result.ok) ? 3 : 0;
  } catch (error) {
    err(`error: ${error?.message || error}`);
    return 1;
  } finally {
    try {
      await connection?.close?.();
    } catch {
      // nothing left to do with a connection that fails to close
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
