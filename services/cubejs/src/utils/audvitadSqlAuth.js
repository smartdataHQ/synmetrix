import { createHmac } from "node:crypto";
import prepareDbParams from "./prepareDbParams.js";
import { getAudvitadSchemaVersion } from "./audvitadModels.js";

const INTERNAL_SECRET_CONTEXT = "audvitad-sql-internal-v1";
const AUTH_TIMEOUT_MS = 5000;

/**
 * Recognizes an Auðvitað / QuickLookup self-service SQL login so checkSqlAuth
 * handles it fail-closed and never falls through to Hasura sql_credentials.
 *
 * Canonical usernames start with `ql_` (e.g. `ql_01j9x...`); WorkOS API keys
 * start with `sk_live_` or `sk_test_`.
 */
export function isAudvitadSqlLogin(username, password) {
  if (typeof username === "string" && /^ql_[a-zA-Z0-9_-]{3,}$/i.test(username.trim())) {
    return true;
  }
  if (typeof password === "string" && /^sk_(?:live|test)_/.test(password.trim())) {
    return true;
  }
  return false;
}

/**
 * Derives the shared HMAC key for synmetrix <-> quicklookup-web internal SQL calls.
 * Uses SQL_AUTH_SECRET when set, otherwise derives a domain-separated key from
 * TOKEN_SECRET (which is already shared between synmetrix-secrets and
 * quicklookup-web-secrets). Returns null when unconfigured (fail closed).
 */
export function deriveAudvitadSqlSecret(env = process.env) {
  if (typeof env.SQL_AUTH_SECRET === "string" && env.SQL_AUTH_SECRET.trim()) {
    return env.SQL_AUTH_SECRET.trim();
  }
  if (typeof env.TOKEN_SECRET === "string" && env.TOKEN_SECRET.trim()) {
    return createHmac("sha256", env.TOKEN_SECRET.trim())
      .update(INTERNAL_SECRET_CONTEXT)
      .digest("hex");
  }
  return null;
}

export function buildInternalAuthHeaders(bodyText, env = process.env, nowMs = Date.now()) {
  const secret = deriveAudvitadSqlSecret(env);
  if (!secret) {
    throw new Error("SQL authentication is not configured");
  }
  const timestamp = String(nowMs);
  const sig = createHmac("sha256", secret)
    .update(`${timestamp}.${bodyText}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-sql-auth-timestamp": timestamp,
    "x-sql-auth-signature": `sha256=${sig}`,
  };
}

function buildAudvitadClickHouseParams(env = process.env) {
  const host = env.AUDVITAD_CLICKHOUSE_HOST || "clickhouse-fraios-clickhouse.clickhouse";
  const port = Number(env.AUDVITAD_CLICKHOUSE_PORT || 8123);
  const user = env.AUDVITAD_CLICKHOUSE_USER || "synmetrix_query";
  const password = env.CLICKHOUSE_QUERY_PASSWORD || env.AUDVITAD_CLICKHOUSE_PASSWORD;
  const database = env.AUDVITAD_CLICKHOUSE_DATABASE || "cst";
  if (!password) {
    throw new Error("SQL ClickHouse read credential is not configured");
  }
  return prepareDbParams(
    { host, port, user, password, database, ssl: false },
    "clickhouse",
  );
}

/**
 * Authenticates an Auðvitað SQL credential via quicklookup-web and builds a
 * shared, tier-scoped Cube securityContext (`audvitad_sql_pro` or
 * `audvitad_sql_enterprise`). Fail-closed on any network, config, or auth error.
 */
export async function authenticateAudvitadSql(
  username,
  password,
  { fetchImpl = fetch, env = process.env } = {},
) {
  const baseUrl = (env.AUDVITAD_SQL_AUTH_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("SQL authentication endpoint is not configured");
  }
  if (!username || typeof username !== "string" || !password || typeof password !== "string") {
    throw new Error("Invalid SQL username or password");
  }

  const bodyText = JSON.stringify({
    username: username.trim(),
    password: password.trim(),
  });
  const headers = buildInternalAuthHeaders(bodyText, env);

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/internal/sql-auth`, {
      method: "POST",
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch {
    throw new Error("SQL authentication service is temporarily unavailable. Try again shortly.");
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) {
    const err = new Error(payload?.message || "Invalid SQL username or password");
    err.status = res.status || 401;
    throw err;
  }

  const premium = Boolean(payload.premium);
  const variant = premium ? "enterprise" : "pro";
  const dbParams = buildAudvitadClickHouseParams(env);
  const partition = payload.partition || "snjallgogn.is";

  const securityContext = {
    userId: `apikey:${payload.keyId}`,
    audvitadSql: {
      organizationId: payload.organizationId,
      keyId: payload.keyId,
      tier: payload.tier,
      premium,
      partition,
      username: payload.username || username.trim().toLowerCase(),
    },
    userScope: {
      role: "member",
      hasAccessList: false,
      dataSourceAccessList: null,
      teamProperties: { partition },
      memberProperties: {},
      dataSource: {
        dataSourceId: `audvitad-sql-${variant}`,
        dataSourceVersion: `audvitad_sql_${variant}`,
        schemaVersion: getAudvitadSchemaVersion({ premium }),
        preAggregationSchema: `audvitad_sql_${variant}`,
        schemaRevisionComplete: true,
        dbType: "clickhouse",
        dbParams,
        files: [],
        fileChecksums: {},
        partition,
        internalTables: [],
      },
    },
    tokenPayload: {
      accountId: payload.accountId || null,
      partition,
      tokenType: "audvitad-sql",
    },
  };

  return {
    skipPasswordCheck: true,
    securityContext,
  };
}

/** Extract the distinct cube names referenced by a normalized Cube query. */
export function extractQueryCubes(query) {
  const cubes = new Set();
  const addMember = (member) => {
    if (typeof member !== "string") return;
    const dot = member.indexOf(".");
    if (dot > 0) cubes.add(member.slice(0, dot));
  };
  for (const m of query?.dimensions || []) addMember(m);
  for (const m of query?.measures || []) addMember(m);
  for (const m of query?.segments || []) addMember(m);
  for (const td of query?.timeDimensions || []) addMember(td?.dimension);
  const walkFilters = (filters) => {
    for (const f of filters || []) {
      addMember(f?.member);
      addMember(f?.dimension);
      if (Array.isArray(f?.and)) walkFilters(f.and);
      if (Array.isArray(f?.or)) walkFilters(f.or);
    }
  };
  walkFilters(query?.filters);
  return [...cubes];
}

/**
 * Enforces live revocation, current plan tier, rate limits and monthly quota on
 * EVERY SQL query executed over an existing Auðvitað PostgreSQL session.
 * Fail-closed so a revoked key or downgraded plan stops immediately without
 * waiting for the TCP connection to close.
 */
export async function authorizeAudvitadQuery(
  securityContext,
  query,
  { fetchImpl = fetch, env = process.env } = {},
) {
  const ctx = securityContext?.audvitadSql;
  if (!ctx?.organizationId || !ctx?.keyId) {
    throw new Error("Invalid SQL session context");
  }
  const baseUrl = (env.AUDVITAD_SQL_AUTH_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("SQL authorization endpoint is not configured");
  }

  const bodyText = JSON.stringify({
    organizationId: ctx.organizationId,
    keyId: ctx.keyId,
    premium: Boolean(ctx.premium),
    cubes: extractQueryCubes(query),
  });
  const headers = buildInternalAuthHeaders(bodyText, env);

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/internal/sql-query`, {
      method: "POST",
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch {
    throw new Error("SQL authorization service is temporarily unavailable. Try again shortly.");
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) {
    const err = new Error(payload?.message || "SQL query not authorized");
    err.status = res.status || 403;
    throw err;
  }

  return payload;
}
