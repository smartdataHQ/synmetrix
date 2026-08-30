import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { after, before, describe, it } from "node:test";

import Redis from "ioredis";
import pg from "pg";

import {
  BILLING_ATTEMPTS_HASH,
  BILLING_DLQ_STREAM,
  BILLING_GROUP,
  BILLING_STREAM,
  enqueueBillingEvent,
  loadAndReplayBillingDlqEntry,
} from "../billingOutbox.js";
import {
  BillingOutboxWorker,
  processBillingEntry,
} from "../billingOutboxWorker.js";

/*
 * Opt-in real-service gate. The request manifest contains only query shapes,
 * expected items, surfaces, and frozen public prices; credentials remain in
 * environment variables. The Redis lane refuses a non-empty keyspace and
 * removes only the exact keys it creates.
 */

const SERVICE_ENABLED = process.env.SPEC102_LIVE_BILLING_SERVICE === "1";
const REDIS_ENABLED = process.env.SPEC102_LIVE_BILLING_REDIS === "1";
const REQUIRED_HTTP_SURFACES = new Set(["rest", "run-sql", "export"]);
const REQUIRED_CASES = new Set([
  "day",
  "weather",
  "both_items",
  "cache_hit",
  "zero_rows",
  "stable_retry",
  "disconnect",
  "non_entitled",
  "engine_failure",
  "system_query",
  "pre_aggregation",
]);
const EXACT_CASE_ITEMS = new Map([
  ["day", ["ctx:day-archetype"]],
  ["weather", ["ctx:weather-archetype"]],
  ["both_items", ["ctx:day-archetype", "ctx:weather-archetype"]],
]);
const REQUIRED_BILLABLE_CASES = new Set([
  "cache_hit",
  "zero_rows",
  "stable_retry",
  "disconnect",
]);
const REQUIRED_UNBILLED_CASES = new Set([
  "non_entitled",
  "engine_failure",
  "system_query",
  "pre_aggregation",
]);
const BILLING_KEYS = [
  BILLING_STREAM,
  BILLING_DLQ_STREAM,
  BILLING_ATTEMPTS_HASH,
];

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required for the live billing gate`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readManifest() {
  const path = requiredEnv("SPEC102_LIVE_BILLING_MANIFEST");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  assert.equal(manifest.schema_version, 1);
  assert.ok(Array.isArray(manifest.requests));
  assert.ok(manifest.requests.length > 0);

  const cases = new Set(
    manifest.requests.flatMap((request) => request.cases || []),
  );
  const surfaces = new Set(manifest.requests.map((request) => request.surface));
  for (const name of REQUIRED_CASES) {
    assert.ok(cases.has(name), `live manifest is missing case ${name}`);
  }
  for (const surface of REQUIRED_HTTP_SURFACES) {
    assert.ok(
      surfaces.has(surface),
      `live manifest is missing surface ${surface}`,
    );
  }
  assert.ok(manifest.sql_api?.sql, "live manifest is missing SQL API coverage");
  assert.ok(Array.isArray(manifest.sql_api.expected_items));
  assert.ok(manifest.sql_api.expected_items.length > 0);

  for (const request of manifest.requests) {
    assert.ok(request.name);
    assert.ok(request.path?.startsWith("/"));
    assert.ok(["GET", "POST"].includes(request.method || "POST"));
    assert.ok(Array.isArray(request.expected_items));
    assert.equal(
      new Set(request.expected_items).size,
      request.expected_items.length,
      `${request.name} contains duplicate expected items`,
    );
    if (request.cases?.includes("non_entitled")) {
      assert.equal(request.auth, "non_entitled");
    }
    for (const [name, items] of EXACT_CASE_ITEMS) {
      if (request.cases?.includes(name)) {
        assert.deepEqual(
          [...request.expected_items].sort(),
          [...items].sort(),
          `${request.name} does not exercise the exact ${name} item set`,
        );
      }
    }
    for (const name of REQUIRED_BILLABLE_CASES) {
      if (request.cases?.includes(name)) {
        assert.ok(
          request.expected_items.length > 0,
          `${request.name} cannot prove billable case ${name} without an item`,
        );
      }
    }
    for (const name of REQUIRED_UNBILLED_CASES) {
      if (request.cases?.includes(name)) {
        assert.deepEqual(
          request.expected_items,
          [],
          `${request.name} must not bill case ${name}`,
        );
      }
    }
  }
  for (const item of ["ctx:day-archetype", "ctx:weather-archetype"]) {
    const price = manifest.expected_pricing?.[item];
    assert.equal(price?.source, "legacy_runtime_rate");
    assert.ok(String(price?.code_version || "").trim());
    assert.ok(/^\d+(?:\.\d+)?$/.test(String(price?.unit_amount || "")));
    assert.ok(/^[A-Z]{3}$/.test(String(price?.currency || "")));
  }
  return manifest;
}

function requestHeaders(token, logicalExecutionId, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-idempotency-key": logicalExecutionId,
    "x-request-id": logicalExecutionId,
    ...extra,
  };
}

async function ordinaryRequest(baseUrl, token, scenario, logicalExecutionId) {
  const response = await fetch(new URL(scenario.path, baseUrl), {
    method: scenario.method || "POST",
    headers: requestHeaders(token, logicalExecutionId, scenario.headers),
    body:
      (scenario.method || "POST") === "GET"
        ? undefined
        : JSON.stringify(scenario.body || {}),
  });
  assert.equal(response.status, scenario.expected_status ?? 200, scenario.name);
  await response.arrayBuffer();
}

async function disconnectRequest(baseUrl, token, scenario, logicalExecutionId) {
  const url = new URL(scenario.path, baseUrl);
  const transport = url.protocol === "https:" ? https : http;
  const body = JSON.stringify(scenario.body || {});
  await new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: scenario.method || "POST",
        headers: {
          ...requestHeaders(token, logicalExecutionId, scenario.headers),
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.once("end", resolve);
      },
    );
    request.once("error", (error) => {
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
    request.end(body);
    setTimeout(
      () => {
        request.destroy();
        resolve();
      },
      Number(scenario.disconnect_after_ms || 25),
    );
  });
}

async function queryLedger({
  fromUtc,
  accountGid,
  logicalPrefix = "",
  surface = "",
}) {
  const endpoint = new URL(requiredEnv("SPEC102_CLICKHOUSE_HTTP_URL"));
  endpoint.searchParams.set("param_from_utc", fromUtc);
  endpoint.searchParams.set("param_account_gid", accountGid);
  endpoint.searchParams.set(
    "param_logical_prefix",
    logicalPrefix ? `${logicalPrefix}%` : "",
  );
  endpoint.searchParams.set("param_surface", surface);
  const auth = Buffer.from(
    `${requiredEnv("SPEC102_CLICKHOUSE_USER")}:${requiredEnv("SPEC102_CLICKHOUSE_PASSWORD")}`,
  ).toString("base64");
  const sql = `
    SELECT
      JSONExtractString(toString(properties), 'logical_execution_id') AS logical_execution_id,
      dimensions['item'] AS item,
      dimensions['surface'] AS surface,
      count() AS ledger_rows,
      uniqExact(message_id) AS distinct_messages,
      any(JSONExtractString(toString(properties), 'pricing_source')) AS pricing_source,
      any(JSONExtractString(toString(properties), 'pricing_code_version')) AS pricing_code_version,
      any(JSONExtractString(toString(properties), 'unit_amount')) AS unit_amount,
      any(analysis.currency[1]) AS currency
    FROM cst.semantic_events
    WHERE event = 'Connection Called'
      AND dimensions['provider'] = 'ctx'
      AND dimensions['accounting_scope'] = 'customer_usage'
      AND timestamp >= parseDateTimeBestEffort({from_utc:String})
      AND toString(entity_gid) = {account_gid:String}
      AND ({logical_prefix:String} = '' OR logical_execution_id LIKE {logical_prefix:String})
      AND ({surface:String} = '' OR dimensions['surface'] = {surface:String})
    GROUP BY logical_execution_id, item, surface
    ORDER BY logical_execution_id, item
    FORMAT JSON
  `;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Basic ${auth}` },
    body: sql,
  });
  assert.equal(response.status, 200, "event-store reconciliation query failed");
  const result = await response.json();
  return result.data || [];
}

async function waitForLedger(expectedCount, query) {
  const timeoutMs = Number(
    process.env.SPEC102_LIVE_BILLING_TIMEOUT_MS || 300_000,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await query();
    if (rows.length >= expectedCount) {
      await sleep(2_000);
      return query();
    }
    await sleep(2_000);
  }
  throw new Error(
    "billing ledger did not reconcile within the configured timeout",
  );
}

describe(
  "Spec 102 real-service billing matrix",
  { skip: !SERVICE_ENABLED },
  () => {
    let manifest;
    let runPrefix;
    let startedAt;
    let token;
    let baseUrl;
    let accountGid;
    let sqlAccountGid;

    before(async () => {
      manifest = await readManifest();
      runPrefix = `spec102-${randomUUID()}`;
      startedAt = new Date(Date.now() - 1_000).toISOString();
      token = requiredEnv("SPEC102_LIVE_BILLING_TOKEN");
      baseUrl = requiredEnv("SPEC102_LIVE_BILLING_BASE_URL");
      accountGid = requiredEnv("SPEC102_LIVE_ACCOUNT_GID");
      sqlAccountGid = requiredEnv("SPEC102_LIVE_SQL_ACCOUNT_GID");
      assert.notEqual(
        sqlAccountGid,
        accountGid,
        "SQL API coverage requires a separate isolated test Account",
      );
    });

    it("drives every tenant HTTP surface and reconciles exact historic prices", async () => {
      const expected = new Map();
      for (const scenario of manifest.requests) {
        const logicalExecutionId = `${runPrefix}:${scenario.name}`;
        const attempts = scenario.cases?.includes("stable_retry") ? 2 : 1;
        const scenarioToken =
          scenario.auth === "non_entitled"
            ? requiredEnv("SPEC102_LIVE_NON_ENTITLED_TOKEN")
            : token;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (scenario.cases?.includes("disconnect")) {
            await disconnectRequest(
              baseUrl,
              scenarioToken,
              scenario,
              logicalExecutionId,
            );
          } else {
            await ordinaryRequest(
              baseUrl,
              scenarioToken,
              scenario,
              logicalExecutionId,
            );
          }
        }
        for (const item of scenario.expected_items) {
          expected.set(`${logicalExecutionId}\u0000${item}`, scenario.surface);
        }
      }

      const sqlClient = new pg.Client({
        host: requiredEnv("SPEC102_SQL_API_HOST"),
        port: Number(process.env.SPEC102_SQL_API_PORT || 15432),
        user: requiredEnv("SPEC102_SQL_API_USER"),
        password: requiredEnv("SPEC102_SQL_API_PASSWORD"),
        database: requiredEnv("SPEC102_SQL_API_DATABASE"),
        ssl:
          process.env.SPEC102_SQL_API_TLS === "0"
            ? false
            : { rejectUnauthorized: true },
      });
      await sqlClient.connect();
      try {
        await sqlClient.query(manifest.sql_api.sql);
      } finally {
        await sqlClient.end();
      }

      const rows = await waitForLedger(expected.size, () =>
        queryLedger({
          fromUtc: startedAt,
          accountGid,
          logicalPrefix: runPrefix,
        }),
      );
      assert.equal(
        rows.length,
        expected.size,
        "missing or unexpected billing rows",
      );
      for (const row of rows) {
        const key = `${row.logical_execution_id}\u0000${row.item}`;
        assert.ok(expected.has(key), `unexpected logical charge ${key}`);
        assert.equal(Number(row.ledger_rows), 1, key);
        assert.equal(Number(row.distinct_messages), 1, key);
        assert.equal(row.surface, expected.get(key));
        const price = manifest.expected_pricing[row.item];
        assert.equal(row.pricing_source, price.source);
        assert.equal(row.pricing_code_version, price.code_version);
        assert.equal(row.unit_amount, price.unit_amount);
        assert.equal(row.currency, price.currency);
      }

      const sqlRows = await waitForLedger(
        manifest.sql_api.expected_items.length,
        () =>
          queryLedger({
            fromUtc: startedAt,
            accountGid: sqlAccountGid,
            surface: "sql-api",
          }),
      );
      assert.equal(sqlRows.length, manifest.sql_api.expected_items.length);
      assert.deepEqual(
        sqlRows.map((row) => row.item).sort(),
        [...manifest.sql_api.expected_items].sort(),
      );
      for (const row of sqlRows) {
        assert.equal(Number(row.ledger_rows), 1);
        assert.equal(Number(row.distinct_messages), 1);
        const price = manifest.expected_pricing[row.item];
        assert.equal(row.pricing_source, price.source);
        assert.equal(row.pricing_code_version, price.code_version);
        assert.equal(row.unit_amount, price.unit_amount);
        assert.equal(row.currency, price.currency);
      }
    });
  },
);

describe(
  "Spec 102 real Redis outage, restart, DLQ, and replay",
  { skip: !REDIS_ENABLED },
  () => {
    let redis;
    let dedupeKeys = [];

    before(async () => {
      redis = new Redis(requiredEnv("SPEC102_LIVE_BILLING_REDIS_URL"), {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      await redis.connect();
      const occupied = await redis.exists(...BILLING_KEYS);
      assert.equal(
        occupied,
        0,
        "live billing Redis gate requires a dedicated empty keyspace",
      );
    });

    after(async () => {
      if (!redis) return;
      await redis.del(...BILLING_KEYS, ...dedupeKeys);
      await redis.quit();
    });

    it("survives outage and restart, then replays an exact DLQ entry", async () => {
      const firstId = `spec102-redis-${randomUUID()}`;
      const firstEnvelope = {
        event: "Connection Called",
        message_id: firstId,
        involves: [],
      };
      dedupeKeys.push(`synmetrix-billing-dedupe:${firstId}`);
      await enqueueBillingEvent(redis, firstEnvelope, { synthetic: true });

      const failedWorker = new BillingOutboxWorker(redis, {
        consumer: "spec102-failed-worker",
        reclaimIdleMs: 0,
        send: async () => ({ ok: false }),
      });
      await failedWorker.ensureGroup();
      const claimed = await redis.xreadgroup(
        "GROUP",
        BILLING_GROUP,
        failedWorker.consumer,
        "COUNT",
        1,
        "STREAMS",
        BILLING_STREAM,
        ">",
      );
      await failedWorker.process(claimed?.[0]?.[1] || []);
      assert.equal(
        Number((await redis.xpending(BILLING_STREAM, BILLING_GROUP))[0]),
        1,
      );

      const replacement = new BillingOutboxWorker(redis, {
        consumer: "spec102-replacement-worker",
        reclaimIdleMs: 0,
        send: async () => ({ ok: true }),
      });
      await replacement.reclaim();
      assert.equal(
        Number((await redis.xpending(BILLING_STREAM, BILLING_GROUP))[0]),
        0,
      );

      const poisonId = `spec102-poison-${randomUUID()}`;
      const poisonEnvelope = {
        event: "Connection Called",
        message_id: poisonId,
        involves: [],
      };
      dedupeKeys.push(`synmetrix-billing-dedupe:${poisonId}`);
      await enqueueBillingEvent(redis, poisonEnvelope, { synthetic: true });
      const poisonRows = await redis.xreadgroup(
        "GROUP",
        BILLING_GROUP,
        "spec102-poison-worker",
        "COUNT",
        1,
        "STREAMS",
        BILLING_STREAM,
        ">",
      );
      const poisonEntry = poisonRows?.[0]?.[1]?.[0];
      assert.ok(poisonEntry);
      assert.equal(
        await processBillingEntry(redis, poisonEntry, {
          send: async () => ({ ok: false }),
          maxAttempts: 1,
        }),
        "dead_lettered",
      );
      assert.equal(await redis.xlen(BILLING_DLQ_STREAM), 1);

      const [[dlqId]] = await redis.xrange(
        BILLING_DLQ_STREAM,
        "-",
        "+",
        "COUNT",
        1,
      );
      dedupeKeys.push(`synmetrix-billing-dedupe:${poisonId}:replay:${dlqId}`);
      const replay = await loadAndReplayBillingDlqEntry(redis, dlqId);
      assert.equal(replay.enqueued, true);
      assert.equal(await redis.xlen(BILLING_DLQ_STREAM), 0);

      const replayRows = await redis.xreadgroup(
        "GROUP",
        BILLING_GROUP,
        "spec102-replay-worker",
        "COUNT",
        1,
        "STREAMS",
        BILLING_STREAM,
        ">",
      );
      await processBillingEntry(redis, replayRows?.[0]?.[1]?.[0], {
        send: async () => ({ ok: true }),
      });
      assert.equal(
        Number((await redis.xpending(BILLING_STREAM, BILLING_GROUP))[0]),
        0,
      );
    });
  },
);
