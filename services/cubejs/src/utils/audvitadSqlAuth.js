import { createHmac, timingSafeEqual } from "node:crypto";
import prepareDbParams from "./prepareDbParams.js";
import { getAudvitadSchemaVersion } from "./audvitadModels.js";

const INTERNAL_SECRET_CONTEXT = "audvitad-sql-internal-v1";
const PROXY_IP_CONTEXT = "sql-ip-v1";
const PROXY_ENVELOPE_PREFIX = "qlip|v1|";
const PROXY_TS_SKEW_SECONDS = 60;
const AUTH_TIMEOUT_MS = 5000;
const REQUEST_DEDUP_TTL_MS = 30_000;

/**
 * Recognizes an Auðvitað / QuickLookup self-service SQL login so checkSqlAuth
 * handles it fail-closed and never falls through to Hasura sql_credentials.
 *
 * Canonical usernames start with `ql_` (e.g. `ql_01j9x...`); WorkOS API keys
 * start with `sk_live_` or `sk_test_`; proxy-wrapped passwords start with `qlip|v1|`.
 */
export function isAudvitadSqlLogin(username, password) {
  if (typeof username === "string" && /^ql_[a-zA-Z0-9_-]{3,}$/i.test(username.trim())) {
    return true;
  }
  if (
    typeof password === "string" &&
    (/^(?:sk_(?:live|test)_|qlip\|v1\|)/.test(password.trim()))
  ) {
    return true;
  }
  return false;
}

/**
 * Derives the shared HMAC key for synmetrix <-> quicklookup-web internal SQL calls
 * and sql-ip-gate <-> synmetrix-cubejs proxy IP envelopes.
 * Uses SQL_AUTH_SECRET when set, otherwise derives a domain-separated key from
 * TOKEN_SECRET. Returns null when unconfigured (fail closed).
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

/**
 * Signs a client source IP + database into the PostgreSQL password field between
 * sql-ip-gate and synmetrix-cubejs so Cube's checkSqlAuth receives a tamper-proof
 * client IP without mutating the PostgreSQL username (`current_user`).
 */
export function signProxyPasswordEnvelope(
  { username, clientIp, database = "", rawPassword },
  secret,
  nowSec = Math.floor(Date.now() / 1000),
) {
  const normUser = String(username || "").trim().toLowerCase();
  const normIp = String(clientIp || "").trim();
  const normDb = String(database || "").trim().toLowerCase().replace(/\|/g, "");
  const ts = String(nowSec);
  const sig = createHmac("sha256", secret)
    .update(`${PROXY_IP_CONTEXT}\n${normUser}\n${normIp}\n${normDb}\n${ts}`)
    .digest("hex");
  return `${PROXY_ENVELOPE_PREFIX}${normIp}|${normDb}|${ts}|${sig}|${rawPassword}`;
}

/**
 * Verifies and unwraps a `qlip|v1|...` password envelope produced by sql-ip-gate.
 * Returns `{ signed: false, password }` for unwrapped logins, or
 * `{ signed: true, valid, clientIp, database, password }` for wrapped logins.
 */
export function verifyProxyPasswordEnvelope(
  username,
  password,
  secret,
  nowSec = Math.floor(Date.now() / 1000),
) {
  if (typeof password !== "string" || !password.startsWith(PROXY_ENVELOPE_PREFIX)) {
    return { signed: false, valid: false, clientIp: "", database: "", password };
  }
  if (!secret) {
    return { signed: true, valid: false, clientIp: "", database: "", password: "" };
  }
  const parts = password.split("|");
  // Format: qlip | v1 | clientIp | database | ts | sig | rawPassword...
  if (parts.length < 7) {
    return { signed: true, valid: false, clientIp: "", database: "", password: "" };
  }
  const clientIp = parts[2].trim();
  const database = parts[3].trim().toLowerCase();
  const tsStr = parts[4].trim();
  const sigHex = parts[5].trim();
  const rawPassword = parts.slice(6).join("|");

  const ts = Number(tsStr);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > PROXY_TS_SKEW_SECONDS) {
    return { signed: true, valid: false, clientIp: "", database: "", password: "" };
  }
  const normUser = String(username || "").trim().toLowerCase();
  const expected = createHmac("sha256", secret)
    .update(`${PROXY_IP_CONTEXT}\n${normUser}\n${clientIp}\n${database}\n${tsStr}`)
    .digest("hex");
  const a = Buffer.from(sigHex, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { signed: true, valid: false, clientIp: "", database: "", password: "" };
  }
  return { signed: true, valid: true, clientIp, database, password: rawPassword };
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
  const password = env.AUDVITAD_CLICKHOUSE_PASSWORD || env.CLICKHOUSE_QUERY_PASSWORD;
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
 * `audvitad_sql_enterprise`). Fail-closed on any network, config, proxy-IP, or auth error.
 */
export async function authenticateAudvitadSql(
  username,
  password,
  { fetchImpl = fetch, env = process.env, protocol = "postgres" } = {},
) {
  if (protocol && protocol !== "postgres") {
    throw new Error("SQL credentials require PostgreSQL over TLS on port 5432.");
  }
  const baseUrl = (env.AUDVITAD_SQL_AUTH_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("SQL authentication endpoint is not configured");
  }
  if (!username || typeof username !== "string" || !password || typeof password !== "string") {
    throw new Error("Invalid SQL username or password");
  }

  const secret = deriveAudvitadSqlSecret(env);
  const unwrapped = verifyProxyPasswordEnvelope(username, password, secret);
  if (unwrapped.signed && !unwrapped.valid) {
    throw new Error("Invalid SQL proxy authentication envelope.");
  }
  const requireProxyIp = env.AUDVITAD_SQL_REQUIRE_PROXY_IP === "true";
  if (requireProxyIp && (!unwrapped.signed || !unwrapped.clientIp)) {
    throw new Error("SQL connections must connect over TLS on port 5432.");
  }

  const realPassword = unwrapped.signed ? unwrapped.password : password;
  const clientIp = unwrapped.signed ? unwrapped.clientIp : "";
  const database = unwrapped.signed ? unwrapped.database : "";

  const bodyText = JSON.stringify({
    username: username.trim(),
    password: realPassword.trim(),
    ...(clientIp ? { clientIp } : {}),
    ...(database ? { database } : {}),
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
      keyName: payload.keyName || "SQL key",
      tier: payload.tier,
      premium,
      partition,
      username: payload.username || username.trim().toLowerCase(),
      clientIp,
      database,
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

/**
 * Extract the distinct cube names referenced by a normalized Cube query,
 * including Cube SQL member-expression objects (`{ cubeName, expression }`)
 * and `joinHints` so aggregate/join queries retain accurate cube telemetry.
 */
export function extractQueryCubes(query) {
  const cubes = new Set();
  const addMember = (member) => {
    if (typeof member === "string") {
      const dot = member.indexOf(".");
      if (dot > 0) cubes.add(member.slice(0, dot));
      return;
    }
    if (member && typeof member === "object") {
      if (typeof member.cubeName === "string" && member.cubeName) {
        cubes.add(member.cubeName);
      }
      if (typeof member.expressionName === "string") {
        const dot = member.expressionName.indexOf(".");
        if (dot > 0) cubes.add(member.expressionName.slice(0, dot));
      }
    }
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
  for (const hint of query?.joinHints || []) {
    if (Array.isArray(hint)) {
      for (const cube of hint) {
        if (typeof cube === "string" && cube) cubes.add(cube);
      }
    } else if (typeof hint === "string" && hint) {
      cubes.add(hint);
    }
  }
  return [...cubes];
}

// Per-requestId authorization deduplication cache.
// With Cube SQL pushdown enabled, a single PostgreSQL query invokes `queryRewrite`
// during `gateway.sql()` (planning) AND again milliseconds later during
// `gateway.sqlApiLoad()` (execution) with the same base `requestId`. Deduplicating
// by base `requestId` prevents 2x quota billing and saves an internal HTTP round-trip
// while still enforcing live revocation, IP allowlisting, tier, and rate limits.
const recentRequestAuth = new Map();

function baseRequestId(requestId) {
  if (typeof requestId !== "string" || !requestId.trim()) return null;
  return requestId.trim().replace(/-span-\d+$/, "");
}

function pruneRecentRequestAuth(nowMs) {
  if (recentRequestAuth.size < 256) return;
  for (const [k, entry] of recentRequestAuth) {
    if (entry.expiresAt <= nowMs) recentRequestAuth.delete(k);
  }
}

export function clearAudvitadQueryAuthCache() {
  recentRequestAuth.clear();
}

/**
 * Enforces live revocation, mandatory IP allowlist, current plan tier, rate limits
 * and monthly quota on EVERY SQL query executed over an existing Auðvitað PostgreSQL
 * session. Fail-closed so a revoked key, removed IP, or downgraded plan stops
 * immediately without waiting for the TCP connection to close.
 */
export async function authorizeAudvitadQuery(
  securityContext,
  query,
  { fetchImpl = fetch, env = process.env, requestId = null, nowMs = Date.now() } = {},
) {
  const ctx = securityContext?.audvitadSql;
  if (!ctx?.organizationId || !ctx?.keyId) {
    throw new Error("Invalid SQL session context");
  }
  const baseUrl = (env.AUDVITAD_SQL_AUTH_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("SQL authorization endpoint is not configured");
  }

  const baseId = baseRequestId(requestId);
  const dedupKey = baseId ? `${ctx.keyId}:${baseId}` : null;
  if (dedupKey) {
    const cached = recentRequestAuth.get(dedupKey);
    if (cached && cached.expiresAt > nowMs) {
      return cached.promise;
    }
  }

  const execute = async () => {
    const bodyText = JSON.stringify({
      organizationId: ctx.organizationId,
      keyId: ctx.keyId,
      keyName: ctx.keyName || "SQL key",
      premium: Boolean(ctx.premium),
      cubes: extractQueryCubes(query),
      ...(ctx.clientIp ? { clientIp: ctx.clientIp } : {}),
      ...(ctx.database ? { database: ctx.database } : {}),
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
  };

  if (!dedupKey) {
    return execute();
  }

  pruneRecentRequestAuth(nowMs);
  const promise = execute().catch((err) => {
    // Do not cache transient 5xx/unavailable errors.
    if (!err?.status || err.status >= 500) {
      recentRequestAuth.delete(dedupKey);
    }
    throw err;
  });
  recentRequestAuth.set(dedupKey, {
    promise,
    expiresAt: nowMs + REQUEST_DEDUP_TTL_MS,
  });
  return promise;
}
