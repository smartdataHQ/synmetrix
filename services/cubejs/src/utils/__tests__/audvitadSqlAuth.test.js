import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  authenticateAudvitadSql,
  authorizeAudvitadQuery,
  buildInternalAuthHeaders,
  deriveAudvitadSqlSecret,
  extractQueryCubes,
  isAudvitadSqlLogin,
} from "../audvitadSqlAuth.js";
import { getAudvitadSchemaVersion } from "../audvitadModels.js";

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
  it("recognizes ql_* usernames and WorkOS API key passwords", () => {
    assert.equal(isAudvitadSqlLogin("ql_01j9x4k2", "secret"), true);
    assert.equal(isAudvitadSqlLogin("QL_KEY_1ORG1", "anything"), true);
    assert.equal(isAudvitadSqlLogin("user", "sk_live_abc123"), true);
    assert.equal(isAudvitadSqlLogin("user", "sk_test_abc123"), true);
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

  it("authenticates a Fag (pro) SQL credential and returns shared non-premium context", async () => {
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
          username: "ql_01j9x",
          tier: "pro",
          premium: false,
          partition: "snjallgogn.is",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const res = await authenticateAudvitadSql("ql_01j9x", "sk_live_secret", {
      fetchImpl,
      env: ENV,
    });

    assert.equal(seenUrl, "http://quicklookup-web.test:3000/api/internal/sql-auth");
    assert.deepEqual(seenBody, { username: "ql_01j9x", password: "sk_live_secret" });
    assert.ok(seenHeaders["x-sql-auth-signature"].startsWith("sha256="));
    assert.equal(res.skipPasswordCheck, true);
    assert.equal(res.securityContext.userId, "apikey:api_key_01j9x");
    assert.equal(res.securityContext.audvitadSql.premium, false);
    assert.equal(res.securityContext.audvitadSql.tier, "pro");
    assert.equal(res.securityContext.userScope.dataSource.dataSourceId, "audvitad-sql-pro");
    assert.equal(res.securityContext.userScope.dataSource.dataSourceVersion, "audvitad_sql_pro");
    assert.equal(
      res.securityContext.userScope.dataSource.schemaVersion,
      getAudvitadSchemaVersion({ premium: false }),
    );
    assert.equal(res.securityContext.userScope.dataSource.dbType, "clickhouse");
    assert.equal(res.securityContext.userScope.dataSource.dbParams.username, "synmetrix_query");
    assert.equal(res.securityContext.userScope.dataSource.dbParams.password, "ch-query-password");

    const dedicated = await authenticateAudvitadSql("ql_01j9x", "sk_live_secret", {
      fetchImpl,
      env: {
        ...ENV,
        AUDVITAD_CLICKHOUSE_USER: "audvitad_sql_query",
        AUDVITAD_CLICKHOUSE_PASSWORD: "dedicated-sql-password",
      },
    });
    assert.equal(dedicated.securityContext.userScope.dataSource.dbParams.username, "audvitad_sql_query");
    assert.equal(dedicated.securityContext.userScope.dataSource.dbParams.password, "dedicated-sql-password");
  });

  it("selects enterprise schema variant when premium is true", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          organizationId: "org_ent",
          keyId: "api_key_ent",
          tier: "enterprise",
          premium: true,
          partition: "custom.is",
        }),
        { status: 200 },
      );

    const res = await authenticateAudvitadSql("ql_ent", "sk_live_ent", {
      fetchImpl,
      env: ENV,
    });
    assert.equal(res.securityContext.audvitadSql.premium, true);
    assert.equal(
      res.securityContext.userScope.dataSource.dataSourceId,
      "audvitad-sql-enterprise",
    );
    assert.equal(
      res.securityContext.userScope.dataSource.schemaVersion,
      getAudvitadSchemaVersion({ premium: true }),
    );
  });

  it("fails closed when auth endpoint rejects or is unreachable", async () => {
    await assert.rejects(
      () =>
        authenticateAudvitadSql("ql_revoked", "sk_live_bad", {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ ok: false, error: "invalid_key", message: "Revoked credential" }),
              { status: 401 },
            ),
          env: ENV,
        }),
      /Revoked credential/,
    );

    await assert.rejects(
      () =>
        authenticateAudvitadSql("ql_neterr", "sk_live_bad", {
          fetchImpl: async () => {
            throw new Error("ECONNREFUSED");
          },
          env: ENV,
        }),
      /temporarily unavailable/,
    );

    await assert.rejects(
      () =>
        authenticateAudvitadSql("ql_noconf", "sk_live_bad", {
          fetchImpl: async () => new Response("{}", { status: 200 }),
          env: {},
        }),
      /not configured/,
    );
  });

  it("extracts distinct cubes from a Cube query and enforces per-query authorization", async () => {
    const cubes = extractQueryCubes({
      dimensions: ["traffic_daily.station_name", "traffic_daily.region"],
      measures: ["traffic_daily.total_vehicles"],
      timeDimensions: [{ dimension: "traffic_daily.timestamp" }],
      filters: [{ member: "holidays.country_code", operator: "equals", values: ["IS"] }],
    });
    assert.deepEqual(cubes.sort(), ["holidays", "traffic_daily"]);

    let queryBody;
    const ok = await authorizeAudvitadQuery(
      {
        audvitadSql: { organizationId: "org_123", keyId: "api_key_01j9x", premium: false },
      },
      { dimensions: ["traffic_daily.station_name"] },
      {
        env: ENV,
        fetchImpl: async (url, opts) => {
          assert.equal(url, "http://quicklookup-web.test:3000/api/internal/sql-query");
          queryBody = JSON.parse(opts.body);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    );
    assert.equal(ok.ok, true);
    assert.deepEqual(queryBody, {
      organizationId: "org_123",
      keyId: "api_key_01j9x",
      premium: false,
      cubes: ["traffic_daily"],
    });

    await assert.rejects(
      () =>
        authorizeAudvitadQuery(
          { audvitadSql: { organizationId: "org_123", keyId: "api_key_revoked", premium: false } },
          { dimensions: ["traffic_daily.station_name"] },
          {
            env: ENV,
            fetchImpl: async () =>
              new Response(
                JSON.stringify({
                  ok: false,
                  error: "revoked",
                  message: "This SQL credential has been revoked.",
                }),
                { status: 401 },
              ),
          },
        ),
      /revoked/,
    );
  });
});
