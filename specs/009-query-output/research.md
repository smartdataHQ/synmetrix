# Research: Improved Query Output

**Feature**: 009-query-output
**Date**: 2026-03-12
**Status**: Complete

## R1: ClickHouse Driver Streaming Capabilities

**Decision**: Use `@clickhouse/client` ResultSet API for native CSV streaming — no need for raw HTTP requests.

**Rationale**: The `@cubejs-backend/clickhouse-driver` (v1.6.21) wraps `@clickhouse/client` which provides:
- `resultSet.text()` — raw response as string (works for CSV formats)
- `resultSet.stream()` — Node.js Readable stream (CSV is a streamable format)
- `resultSet.response_headers` — includes `x-clickhouse-format`
- Format specified via `format: 'CSVWithNames'` in query options

**CORRECTION**: The driver's `queryResponse(query, values)` does NOT return the raw ResultSet. It hardcodes `format: 'JSON'` (line 166) and calls `resultSet.json()` (line 180), returning already-parsed JSON data. The driver's `query()` method then runs `normaliseResponse()` on top of that. Neither method supports non-JSON formats.

To get native CSV, we must access the driver's internal `this.client` property (the `@clickhouse/client` instance) and call `client.query()` directly with `format: 'CSVWithNames'`. While `this.client` is not a public API, it is accessible in JavaScript and is a stable internal (the client is created once in the constructor at line 99).

**Alternatives considered**:
- Using `queryResponse()` — **rejected**: hardcodes JSON format, cannot be overridden
- Direct HTTP requests to ClickHouse bypassing the driver entirely — unnecessary complexity, `driver.client` gives us the `@clickhouse/client` instance
- Monkey-patching `driver.queryResponse()` — fragile, accessing `driver.client` directly is simpler and more transparent

**Key implementation detail**: `runSql.js` currently calls `driver.query()` which returns parsed rows. For CSV format on ClickHouse, access `driver.client` (the internal `@clickhouse/client` instance) and call `driver.client.query({ query: sql, format: 'CSVWithNames' })`, then use `resultSet.text()` (MVP) or `resultSet.stream()` (P3/US6) for the response. NULL values come back as `\N` in ClickHouse CSV and must be normalized to empty strings for RFC 4180 compliance.

## R2: run-sql Authentication & Security Flow

**Decision**: Adding a `format` parameter to run-sql is LOW RISK — all auth gates execute before query execution.

**Rationale**: The complete auth chain is:

1. `checkAuthMiddleware` → JWT verification (WorkOS RS256 or Hasura HS256)
2. `findUser()` → validates user has datasources and team memberships (cached 30s)
3. `defineUserScope()` → validates datasource access, resolves branch/version, extracts access list
4. `buildSecurityContext()` → creates content-hashed context for cache isolation
5. `loadRules()` → if query rewrite rules exist, entire SQL API is blocked (403)
6. `driverFactory()` → creates driver with datasource-specific credentials
7. `driver.query()` → executes SQL

The format parameter is applied at step 7 (output serialization only). No auth decisions depend on output format. The existing security model is fully preserved.

**Alternatives considered**:
- Adding format-specific auth checks — unnecessary, output format doesn't expand access
- New dedicated route with separate auth — duplication, same middleware would apply

**Key security notes**:
- SQL API is fully blocked when query rewrite rules exist (prevents bypassing row-level filters)
- No query validation/audit exists for SQL API by design (caller controls SQL)
- Driver credentials are always datasource-scoped (multi-tenant isolation preserved)

## R3: ClickHouse FORMAT CSVWithNames Behavior

**Decision**: Use `FORMAT CSVWithNames` for ClickHouse native CSV output.

**Rationale**: ClickHouse FORMAT clause behavior:
- `CSVWithNames` — header row with column names + CSV data rows
- `CSVWithNamesAndTypes` — header row + types row + CSV data rows
- RFC 4180 compliant: commas, quotes, newlines properly escaped
- NULL values rendered as `\N` (ClickHouse convention) — may need post-processing for standard CSV
- Content-Type from ClickHouse: `text/csv; charset=UTF-8` (when using HTTP interface)
- Zero-copy streaming: database produces CSV bytes directly, no server-side parsing

**Alternatives considered**:
- `FORMAT CSV` (no header) — missing column names, less useful
- `FORMAT TabSeparatedWithNames` — TSV not as universally consumed as CSV
- Server-side CSV serialization for ClickHouse — unnecessary overhead when native format available

**Key implementation detail**: Append `FORMAT CSVWithNames` to the SQL query string before sending to ClickHouse. The response body IS the CSV file — stream directly to client.

## R4: jsonstat-toolkit Test Infrastructure & Build

**Decision**: Fork `smartdataHQ/toolkit` (currently identical to upstream v2.2.2), optimize in-place, maintain existing test suite.

**Rationale**: Toolkit characteristics:
- **Source**: 1,776 lines, zero dependencies
- **Build**: Rollup → 4 output formats (IIFE, CJS, ESM module.mjs, ESM import.mjs), ~18KB each
- **Tests**: Custom assert-based framework (~80 tests), no external test runner
- **Current state**: Fork is byte-identical to upstream — no modifications yet

**Benchmark infrastructure needed**:
- Create benchmark scripts for 100K and 1M observation datasets
- Measure: Transform() time, Dice() memory, toTable() iteration count, normalize() allocation
- Before/after comparison for each of the 6 identified bottlenecks

**Alternatives considered**:
- Using toolkit as-is without optimization — impractical for 100K+ datasets (multi-second Transform times)
- Rewriting from scratch — unnecessary, targeted optimizations to 6 specific bottlenecks suffice
- Publishing optimized fork to npm — possible future step, start with direct dependency

## R5: Row Limit Removal Strategy

**Decision**: Remove all query row limits across the entire stack. There should be no query limits — the output is the output.

**Rationale**: Three limit enforcement points exist and all must be removed:
1. **`CUBEJS_DB_QUERY_DEFAULT_LIMIT`** (10k) — applied when no limit specified in semantic queries → remove or set to 0 (unlimited)
2. **`CUBEJS_DB_QUERY_LIMIT`** (50k) — hard cap that throws error if exceeded → remove or set to 0 (unlimited)
3. **`MAX_ROWS_LIMIT = 10000`** — frontend hard cap on the limit input in ExploreSettingsForm → remove entirely

These limits are counterproductive for all use cases, not just exports. If the caller specifies a SQL LIMIT clause, that's their responsibility. The platform should not impose artificial caps.

**Implementation approach**:
- Set `CUBEJS_DB_QUERY_DEFAULT_LIMIT` and `CUBEJS_DB_QUERY_LIMIT` to `0` (unlimited) in `.env` and `docker-compose.dev.yml`
- Remove the `MAX_ROWS_LIMIT` constant and its validation from the frontend `ExploreSettingsForm`
- No replacement limits — the database query itself is the source of truth for row counts

**Alternatives considered**:
- Separate interactive vs export limits — rejected; user explicitly wants no limits anywhere
- Making limits configurable per-request — over-engineering, not needed when the answer is "no limits"

## R6: Non-ClickHouse CSV Fallback

**Decision**: Row-by-row CSV serialization using a lightweight streaming approach for non-ClickHouse databases.

**Rationale**: Most database drivers return rows as JavaScript objects. For these:
- Iterate rows from `driver.query()` result
- Write CSV header from first row's keys
- Stream each row as a CSV line with RFC 4180 escaping
- Use Node.js Transform stream to pipe to response

**Key considerations**:
- PostgreSQL, MySQL, BigQuery drivers all return full result sets (no native CSV)
- Memory usage: `driver.query()` still loads all rows into memory for these drivers
- Future: could investigate cursor-based streaming for PG (`DECLARE CURSOR ... FETCH`)

**Alternatives considered**:
- Using a CSV library (csv-stringify, fast-csv) — adds dependency, simple escaping is trivial
- Requiring all databases to support native CSV — not feasible, only ClickHouse does this well

## R7: Frontend Export Flow (Explore Page)

**Decision**: Replace the existing client-side `react-csv` export with a server-side format export using the gen_sql → run-sql chain.

**Rationale**: The current Explore page export:
- Uses `react-csv`'s `CSVLink` component in `ExploreDataSection/index.tsx`
- Only exports rows already loaded in memory (subject to `MAX_ROWS_LIMIT` of 10,000)
- No format selection — CSV only, client-side serialization
- Filename: `exploration-{random}.csv`

The existing infrastructure supports the new flow:
- `GenSQL` mutation already exists in `explorations.gql` — compiles semantic query to raw SQL
- `run-sql` endpoint (`/api/v1/run-sql`) is directly accessible from the frontend via the `/api/v1/*` proxy path
- CubeJS JWT token is available in the frontend auth store for direct API calls

**Implementation approach**:
1. Add a format selector dropdown (Ant Design `Select` or `Dropdown`) in `ExploreDataSection` near the existing export button
2. Create a `useFormatExport` hook that:
   - Calls `GenSQL` mutation to get raw SQL from the current exploration
   - Makes a `fetch()` call to `/api/v1/run-sql` with `{ query: sql, format: selectedFormat }`
   - Handles the response as a blob download (CSV) or JSON display (JSON-Stat)
   - Manages loading/error states
3. Replace the `react-csv` `CSVLink` with the new format-aware export button
4. For CSV: trigger browser download via `URL.createObjectURL(blob)` + hidden `<a>` element
5. For JSON-Stat: trigger download as `.json` file

**Key frontend components**:
- `ExploreDataSection/index.tsx` — where the export button lives (lines 373-381)
- `ExploreSettingsForm/index.tsx` — where `MAX_ROWS_LIMIT` is defined (line 13)
- `explorations.gql` — `GenSQL` mutation already defined
- Auth: JWT token from `AuthTokensStore` for the `Authorization` header on direct run-sql calls

**Alternatives considered**:
- Keep client-side CSV and add server-side as separate button — confusing UX, two export mechanisms
- Route through Hasura action instead of direct run-sql call — Hasura actions can't return raw CSV (response must be JSON)
- Add format to the `fetch_dataset` Hasura action — would require Hasura action schema changes, and still can't return non-JSON
