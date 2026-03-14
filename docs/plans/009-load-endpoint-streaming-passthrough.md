# Load Endpoint Streaming Passthrough for CSV/Arrow

**Date:** 2026-03-14
**Status:** Implementation ready
**Related:** 009-query-output, OOMKill incident on cubejs pod

## Problem

The `/api/v1/load` endpoint buffers all query result rows in memory when serving CSV and Arrow formats. The Cube.js engine internally calls `driver.query()`, collects all rows into a JavaScript array, then calls `res.json(fullResult)`. Our format middleware intercepts `res.json()` and re-serializes to CSV/Arrow, but by that point the full result set is already in memory.

This caused a production OOMKill (exit code 137) when a 50k-row query across many dimensions exceeded the container memory limit. V8 never triggered GC pressure because `--max-old-space-size` exceeded the container limit — the kernel killed the process directly.

The `/api/v1/run-sql` endpoint already has constant-memory streaming for ClickHouse (Arrow via `driver.client.exec()` with `FORMAT ArrowStream`, CSV via `driver.client.query()` with `FORMAT CSVWithNames`). The `/load` endpoint cannot use these paths because the Cube.js engine controls query execution internally.

## Solution: Compile-Then-Redirect

For `format=csv|arrow` on the `/load` endpoint, **compile** the Cube.js query to raw SQL, then **redirect** to the existing `runSql` handler. This reuses all streaming code (ClickHouse Arrow/CSV fast paths, backpressure, abort handling, safety limits) with zero duplication.

### Flow

```
Browser POST /api/v1/load { query: { measures, dimensions, ... }, format: "csv" }
  │
  ▼
Format middleware (routes/index.js)
  - Validates format
  - format === "json" → next() (unchanged, Cube.js handles it)
  - format === "jsonstat" → next() (intercept approach, needs annotation metadata)
  - format === "csv" or "arrow" → SHORT-CIRCUIT:
    │
    ▼
  1. checkAuthMiddleware already ran → req.securityContext populated
    │
    ▼
  2. Compile Cube.js query to SQL via cubejs.apiGateway().sql()
     → Returns { sql: { sql: [sqlString, paramsArray], ... }, dataSource }
    │
    ▼
  3. Substitute params → executable SQL string
    │
    ▼
  4. HMAC-sign the SQL (so runSql's access-control check passes)
    │
    ▼
  5. Rewrite req.body and call runSql(req, res, cubejs)
     → runSql handles streaming, abort, safety limits — all existing code
```

**Memory:** O(chunk_size) for ClickHouse (~128KB). O(rows × columns) for non-ClickHouse (driver limitation, unchanged from today).

### Why This Works

**"Loses Cube.js query metadata"** — not an issue. Annotation and pre-aggregation hints are only needed for JSON-Stat (which keeps the intercept approach). CSV and Arrow just need rows/bytes.

**"Bypasses access control signing"** — not an issue. HMAC signing prevents external clients from injecting arbitrary SQL through the public `run-sql` endpoint. Here the SQL is compiled internally by the Cube.js compiler (which applies `queryRewrite` access control rules during compilation) and never leaves the server. We sign it internally with `JWT_KEY` (already available in scope) so `runSql`'s `isSignedSql` check passes transparently — no flags, no special cases.

**"assertApiScope('sql') might block"** — not an issue. Default API scopes include `['graphql', 'meta', 'data', 'sql']` and we don't override `contextToApiScopesFn`. The `sql` scope is always permitted.

### JSON-Stat: Unchanged

JSON-Stat keeps the existing intercept approach. It requires annotation metadata (measure names, time dimension names) from the Cube.js compilation to correctly assign dataset-level roles. JSON-Stat results are also typically smaller (aggregated data), so buffering is acceptable.

## Implementation

### Changes to `routes/index.js`

The format middleware currently handles all non-JSON formats via the intercept approach (override `res.json`/`res.send`, call `next()`, transform the buffered response). For CSV and Arrow, we replace this with a direct redirect to `runSql`.

```javascript
import crypto from "crypto";
import runSql from "./runSql.js";

// Parameter substitution (inlined — trivial function)
function replaceQueryParams(sql, params) {
  let index = -1;
  return sql.replace(/(\$\d+)|\(\?[\w\d ]*\)|\?/g, (match) => {
    index += 1;
    return match.replace(/\?|\$\d+/, `'${params[index]}'`);
  });
}

// Compile a Cube.js query object to executable SQL
async function compileCubeQuery(cubejs, query, securityContext) {
  const gateway = cubejs.apiGateway();
  let sqlResult;

  await gateway.sql({
    query,
    context: {
      securityContext,
      requestId: crypto.randomUUID(),
    },
    res: (result) => { sqlResult = result; },
  });

  // result shape: { sql: { sql: [sqlString, paramsArray], ... }, dataSource }
  const { sql: sqlQuery } = sqlResult;
  const [sqlString, params] = sqlQuery.sql;
  return replaceQueryParams(sqlString, params);
}

// HMAC-sign SQL so runSql's isSignedSql check passes
function signSql(sql) {
  return crypto.createHmac("sha256", process.env.JWT_KEY).update(sql).digest("hex");
}
```

The middleware itself:

```javascript
router.use(`${basePath}/v1/load`, checkAuthMiddleware, (req, res, next) => {
  if (req.method !== "POST" && req.method !== "GET") return next();

  const rawFormat = req.method === "POST" ? req.body?.format : req.query?.format;
  let format;
  try {
    format = validateFormat(rawFormat);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // JSON: pass through to Cube.js engine (unchanged)
  if (format === "json") return next();

  // CSV / Arrow: compile query to SQL, then redirect to runSql for streaming
  if (format === "csv" || format === "arrow") {
    const cubeQuery = req.method === "POST" ? req.body?.query : JSON.parse(req.query?.query);

    compileCubeQuery(cubejs, cubeQuery, req.securityContext)
      .then((executableSql) => {
        // Rewrite request body for runSql
        req.body = {
          query: executableSql,
          format,
          sql_signature: signSql(executableSql),
        };
        return runSql(req, res, cubejs);
      })
      .catch((err) => {
        console.error("Load streaming passthrough failed, falling back to Cube.js engine:", err.message);
        // On compilation failure, fall back to the buffered intercept approach
        setupInterceptTransform(req, res, format);
        next();
      });
    return;
  }

  // JSON-Stat: use the intercept approach (needs annotation metadata)
  setupInterceptTransform(req, res, format);
  next();
});
```

The existing intercept logic (limit override, `res.json`/`res.send` override, transform function) gets extracted into a `setupInterceptTransform(req, res, format)` helper so JSON-Stat can still use it, and it serves as the fallback if compilation fails.

### Changes to `routes/runSql.js`

None. The `runSql` handler already handles everything: format validation, HMAC signature check, driver factory, ClickHouse streaming fast paths, generic fallback, abort handling, safety limits. The internal redirect just needs to provide a properly shaped `req.body`.

### `req.body` contract for internal redirect

```javascript
req.body = {
  query: "SELECT ... FROM ...",        // executable SQL (params substituted)
  format: "csv" | "arrow",            // output format
  sql_signature: "a1b2c3...",          // HMAC-SHA256 of query with JWT_KEY
  // No measures/timeDimensions needed — those are for JSON-Stat only
};
```

### Auth Flow

`checkAuthMiddleware` is added to the middleware chain for `/v1/load`. This means:
- For JSON (passes through to Cube.js): auth runs twice — once in our middleware, once in Cube.js's own middleware. This is harmless (idempotent, cached).
- For CSV/Arrow (short-circuits): auth runs once in our middleware, which is sufficient.
- For JSON-Stat (intercept approach): auth runs twice, same as JSON. Harmless.

### Fallback Strategy

If `compileCubeQuery` fails (e.g., invalid query, compiler error), the middleware falls back to the existing buffered intercept approach by calling `setupInterceptTransform()` and `next()`. This means CSV/Arrow exports still work for edge cases where compilation fails — they just use more memory.

### Files to Modify

1. `services/cubejs/src/routes/index.js` — restructure format middleware: extract intercept logic into helper, add streaming passthrough for csv/arrow
2. No other files changed — `runSql.js` is reused as-is

### Estimated Impact

| Scenario | Current Memory | After Passthrough |
|----------|---------------|-------------------|
| 50k rows × 20 cols, ClickHouse Arrow | ~500MB (4x amplification) | ~128KB (chunk buffer) |
| 50k rows × 20 cols, ClickHouse CSV | ~200MB | ~128KB (chunk buffer) |
| 50k rows × 20 cols, PostgreSQL | ~200MB (unchanged) | ~200MB (driver limitation) |
| 1M rows × 10 cols, ClickHouse Arrow | OOM | ~128KB |

### References

- `services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js:980` — `sql()` method
- `services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js:59` — default API scopes include `'sql'`
- `services/cubejs/node_modules/@cubejs-backend/server-core/dist/src/core/server.js:323` — `apiGateway()` accessor
- `services/cubejs/index.js:93` — ServerCore instantiation, `cubejs` object passed to routes
- `services/cubejs/src/routes/runSql.js` — target handler (streaming, abort, safety limits)
- `services/cubejs/src/utils/checkAuth.js` — auth middleware (already imported in routes/index.js)
- `services/actions/src/utils/playgroundState.js:3` — `replaceQueryParams()` original (inlined in our implementation)
