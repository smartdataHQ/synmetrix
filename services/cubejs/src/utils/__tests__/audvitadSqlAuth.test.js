import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  authenticateAudvitadSql,
  authorizeAudvitadQuery,
  buildInternalAuthHeaders,
  clearAudvitadQueryAuthCache,
  deriveAudvitadSqlSecret,
  extractQueryCubes,
  isAudvitadSqlLogin,
  signProxyPasswordEnvelope,
  verifyProxyPasswordEnvelope,
} from "../audvitadSqlAuth.js";
import {
  AUDVITAD_CORE_CUBE_NAMES,
  AUDVITAD_PREMIUM_CUBE_NAMES,
  getAudvitadCubeDefinitions,
  getAudvitadSchemaFiles,
  getAudvitadSchemaVersion,
} from "../audvitadModels.js";

const ENV = {
  AUDVITAD_SQL_AUTH_URL: "http://quicklookup-web.test:3000",
  TOKEN_SECRET: "shared-token-secret-for-tests",
  CLICKHOUSE_QUERY_PASSWORD: "ch-query-password",
  AUDVITAD_CLICKHOUSE_HOST: "clickhouse-test.clickhouse",
  AUDVITAD_CLICKHOUSE_PORT: "8123",
  AUDVITAD_CLICKHOUSE_USER: "synmetrix_query",
  AUDVITAD_CLICKHOUSE_DATABASE: "cst",
};

describe("audvitadSqlAuth", () => {
  it("recognizes ql_* usernames, WorkOS API keys, and proxy-signed envelopes", () => {
    assert.equal(isAudvitadSqlLogin("ql_01j9x4k2", "secret"), true);
    assert.equal(isAudvitadSqlLogin("QL_KEY_1ORG1", "anything"), true);
    assert.equal(isAudvitadSqlLogin("user", "sk_live_abc123"), true);
    assert.equal(isAudvitadSqlLogin("user", "sk_test_abc123"), true);
    assert.equal(isAudvitadSqlLogin("user", "qlip|v1|1.2.3.4|audvitad|1|a|pw"), true);
    assert.equal(
      isAudvitadSqlLogin("11111111-2222-3333-4444-555555555555", "eyJ.abc.def"),
      false,
    );
    assert.equal(isAudvitadSqlLogin("legacy_user", "plain-pass"), false);
  });

  it("prefers SQL_AUTH_SECRET over TOKEN_SECRET derivation and signs bodies", () => {
    const derived = deriveAudvitadSqlSecret({ TOKEN_SECRET: "tok" });
    const expectedDerived = createHmac("sha256", "tok")
      .update("audvitad-sql-internal-v1")
      .digest("hex");
    assert.equal(derived, expectedDerived);
    assert.equal(
      deriveAudvitadSqlSecret({ SQL_AUTH_SECRET: "explicit", TOKEN_SECRET: "tok" }),
      "explicit",
    );
    assert.equal(deriveAudvitadSqlSecret({}), null);

    const headers = buildInternalAuthHeaders('{"a":1}', { SQL_AUTH_SECRET: "explicit" }, 1700000000000);
    assert.equal(headers["x-sql-auth-timestamp"], "1700000000000");
    assert.equal(
      headers["x-sql-auth-signature"],
      `sha256=${createHmac("sha256", "explicit").update('1700000000000.{"a":1}').digest("hex")}`,
    );
  });

  it("verifies proxy IP envelopes and rejects tampered, stale, MySQL, or direct bypass logins", async () => {
    const secret = deriveAudvitadSqlSecret(ENV);
    const nowSec = 1_750_000_000;
    const signed = signProxyPasswordEnvelope(
      {
        username: "ql_01j9x",
        clientIp: "203.0.113.42",
        database: "audvitad",
        rawPassword: "sk_live_secret",
      },
      secret,
      nowSec,
    );
    const ok = verifyProxyPasswordEnvelope("ql_01j9x", signed, secret, nowSec + 5);
    assert.equal(ok.valid, true);
    assert.equal(ok.clientIp, "203.0.113.42");
    assert.equal(ok.database, "audvitad");
    assert.equal(ok.password, "sk_live_secret");

    // Tampered IP, wrong user, or stale timestamp rejected
    assert.equal(
      verifyProxyPasswordEnvelope("ql_01j9x", signed.replace("203.0.113.42", "203.0.113.99"), secret, nowSec + 5).valid,
      false,
    );
    assert.equal(verifyProxyPasswordEnvelope("ql_other", signed, secret, nowSec + 5).valid, false);
    assert.equal(verifyProxyPasswordEnvelope("ql_01j9x", signed, secret, nowSec + 120).valid, false);

    // Rejects direct unsigned login when AUDVITAD_SQL_REQUIRE_PROXY_IP=true
    await assert.rejects(
      () =>
        authenticateAudvitadSql("ql_01j9x", "sk_live_secret", {
          env: { ...ENV, AUDVITAD_SQL_REQUIRE_PROXY_IP: "true" },
          fetchImpl: async () => new Response("{}", { status: 200 }),
        }),
      /TLS on port 5432/,
    );

    // Rejects MySQL protocol for ql_* credentials
    await assert.rejects(
      () =>
        authenticateAudvitadSql("ql_01j9x", "sk_live_secret", {
          env: ENV,
          protocol: "mysql",
          fetchImpl: async () => new Response("{}", { status: 200 }),
        }),
      /PostgreSQL over TLS/,
    );
  });

  it("authenticates a proxy-signed Fag (pro) SQL credential and preserves clientIp, database, keyName", async () => {
    const secret = deriveAudvitadSqlSecret(ENV);
    const signed = signProxyPasswordEnvelope(
      {
        username: "ql_01j9x",
        clientIp: "203.0.113.42",
        database: "quicklookup",
        rawPassword: "sk_live_secret",
      },
      secret,
    );
    let seenUrl;
    let seenHeaders;
    let seenBody;
    const fetchImpl = async (url, opts) => {
      seenUrl = url;
      seenHeaders = opts.headers;
      seenBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          ok: true,
          organizationId: "org_123",
          accountId: "acc_123",
          keyId: "api_key_01j9x",
          keyName: "Power BI",
          username: "ql_01j9x",
          tier: "pro",
          premium: false,
          partition: "snjallgogn.is",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const res = await authenticateAudvitadSql("ql_01j9x", signed, {
      fetchImpl,
      env: { ...ENV, AUDVITAD_SQL_REQUIRE_PROXY_IP: "true" },
    });

    assert.equal(seenUrl, "http://quicklookup-web.test:3000/api/internal/sql-auth");
    assert.deepEqual(seenBody, {
      username: "ql_01j9x",
      password: "sk_live_secret",
      clientIp: "203.0.113.42",
      database: "quicklookup",
    });
    assert.ok(seenHeaders["x-sql-auth-signature"].startsWith("sha256="));
    assert.equal(res.skipPasswordCheck, true);
    assert.equal(res.securityContext.userId, "apikey:api_key_01j9x");
    assert.equal(res.securityContext.audvitadSql.clientIp, "203.0.113.42");
    assert.equal(res.securityContext.audvitadSql.database, "quicklookup");
    assert.equal(res.securityContext.audvitadSql.keyName, "Power BI");
    assert.equal(
      res.securityContext.userScope.dataSource.schemaVersion,
      getAudvitadSchemaVersion({ premium: false }),
    );
  });

  it("extracts cubes from member expressions and joinHints, and deduplicates billing per requestId", async () => {
    clearAudvitadQueryAuthCache();
    const cubes = extractQueryCubes({
      dimensions: [
        "traffic_daily.station_name",
        { cubeName: "day_archetypes", expressionName: "day_archetypes.day_name" },
      ],
      measures: [{ cubeName: "traffic_daily", expression: [] }],
      timeDimensions: [{ dimension: "traffic_daily.timestamp" }],
      filters: [{ member: "holidays.country_code", operator: "equals", values: ["ISL"] }],
      joinHints: [["traffic_daily", "traffic_stations"]],
    });
    assert.deepEqual(cubes.sort(), ["day_archetypes", "holidays", "traffic_daily", "traffic_stations"]);

    let calls = 0;
    let lastBody;
    const fetchImpl = async (_url, opts) => {
      calls++;
      lastBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ ok: true, used: calls }), { status: 200 });
    };
    const ctx = {
      audvitadSql: {
        organizationId: "org_123",
        keyId: "api_key_01j9x",
        keyName: "Power BI",
        premium: false,
        clientIp: "203.0.113.42",
        database: "audvitad",
      },
    };

    // Planning (gateway.sql) + execution (gateway.sqlApiLoad) share the same base requestId -> 1 HTTP call!
    await authorizeAudvitadQuery(ctx, { dimensions: ["traffic_daily.station_name"] }, {
      env: ENV,
      fetchImpl,
      requestId: "req-abc-123-span-1",
    });
    await authorizeAudvitadQuery(ctx, { dimensions: ["traffic_daily.station_name"] }, {
      env: ENV,
      fetchImpl,
      requestId: "req-abc-123-span-2",
    });
    assert.equal(calls, 1);
    assert.deepEqual(lastBody, {
      organizationId: "org_123",
      keyId: "api_key_01j9x",
      keyName: "Power BI",
      premium: false,
      cubes: ["traffic_daily"],
      clientIp: "203.0.113.42",
      database: "audvitad",
    });

    // Next user query has a new requestId -> bills again
    await authorizeAudvitadQuery(ctx, { dimensions: ["traffic_daily.station_name"] }, {
      env: ENV,
      fetchImpl,
      requestId: "req-def-456",
    });
    assert.equal(calls, 2);
  });

  it("publishes 27 Pro and 31 Enterprise documented, NULL-safe, joined cubes", () => {
    assert.equal(AUDVITAD_CORE_CUBE_NAMES.length, 27);
    assert.equal(AUDVITAD_PREMIUM_CUBE_NAMES.length, 4);
    const all = getAudvitadCubeDefinitions({ premium: true });
    assert.equal(all.length, 31);
    assert.equal(getAudvitadSchemaFiles({ premium: false }).length, 27);
    assert.equal(getAudvitadSchemaFiles({ premium: true }).length, 31);

    for (const cube of all) {
      assert.ok(cube.description, `${cube.name} missing cube description`);
      assert.ok(cube.refresh_key?.every, `${cube.name} missing refresh_key`);
      for (const d of cube.dimensions) {
        assert.ok(d.description, `${cube.name}.${d.name} missing dimension description`);
      }
      for (const m of cube.measures) {
        assert.ok(m.description, `${cube.name}.${m.name} missing measure description`);
      }
    }

    const dayArch = all.find((c) => c.name === "day_archetypes");
    assert.ok(dayArch.sql.includes("toBool(lower(dimensions['is_workday'])"));
    assert.ok(dayArch.dimensions.some((d) => d.name === "country_code_alpha3"));

    const fuel = all.find((c) => c.name === "fuel_prices");
    assert.ok(fuel.sql.includes("mapContains(metrics, 'discount_price')"));

    const holidays = all.find((c) => c.name === "holidays");
    assert.ok(holidays.sql.includes("toBool(is_cancelled != 0) AS is_cancelled"));
    assert.ok(holidays.sql.includes("toBool(all_day) AS all_day"));
    const eventId = holidays.dimensions.find((d) => d.name === "event_id");
    assert.equal(eventId?.public, true);

    const market = all.find((c) => c.name === "market_prices");
    assert.ok(market.dimensions.some((d) => d.name === "asset_class"));
  });
});
