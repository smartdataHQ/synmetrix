# 009: Export Formats — Efficient Output for Query Results

## Goal

Add less-verbose output formats (CSV, JSON-Stat) to the CubeJS service routes, reducing payload size and enabling bulk/streaming export. When the underlying database natively supports a format (e.g. ClickHouse CSV), stream it directly to the client without intermediate serialization.

## Current State

### How query results flow today

| Path | Entry Point | Data Source | Limit Enforcement | Output |
|------|-------------|-------------|-------------------|--------|
| **Cube.js `/load` API** | `@cubejs-backend/api-gateway` | Cube.js query engine | `CUBEJS_DB_QUERY_DEFAULT_LIMIT` (10,000), `CUBEJS_DB_QUERY_LIMIT` (50,000 hard max) | JSON only (`default` or `compact` responseFormat) |
| **`fetch_dataset` action** | `services/actions/src/rpc/fetchDataset.js` | Cube.js client (`@cubejs-client/core`) → `/load` | Same as above (passes through) | JSON (wraps Cube.js response) |
| **`run_query` action** | `services/actions/src/rpc/runQuery.js` → `cubejsApi.runSQL()` | `POST /api/v1/run-sql` → raw driver | Caller-provided SQL `LIMIT` clause only | JSON (`res.json(rows)`) |
| **`/api/v1/run-sql` route** | `services/cubejs/src/routes/runSql.js` | Raw database driver (`driver.query()`) | None (raw SQL) | JSON (`res.json(rows)`) |

### Cube.js built-in formats

The API gateway supports two `responseFormat` values (neither is CSV):
- **`default`** — `{ data: [{key: value}, ...], annotation: {...} }` (verbose, repeated keys per row)
- **`compact`** — `{ members: [...], dataset: [[...], ...] }` (columnar, smaller payload)

### Frontend limits

- `ExploreSettingsForm` caps UI input at `MAX_ROWS_LIMIT = 10000` (`client-v2/src/components/ExploreSettingsForm/index.tsx:13`)
- Default limit in UI: 100 rows
- SQL Runner default: 1,000 rows

## Semantic Query → Raw SQL → Raw Results (existing pieces)

The building blocks to go from a Cube.js semantic query to raw database output already exist — they're just not chained:

1. **`gen_sql` action** (`services/actions/src/rpc/genSql.js`) — takes an exploration (semantic query), compiles it to raw SQL via `cubejsApi.query(state, "sql")`, substitutes params via `replaceQueryParams()`, returns the final SQL string. This uses the Cube.js schema compiler, not the query engine.

2. **`/api/v1/run-sql` route** (`services/cubejs/src/routes/runSql.js`) — takes a raw SQL string, gets a driver instance via `cubejs.options.driverFactory({ securityContext })`, calls `driver.query(sql)`, returns raw rows as JSON.

3. **`run_query` action** (`services/actions/src/rpc/runQuery.js`) — chains these: wraps caller SQL in `SELECT * FROM (...) LIMIT n`, sends to `run-sql`, returns result.

**Today this requires two round trips** (gen_sql → run_query) or the client must know the raw SQL. A single endpoint that compiles + executes + formats would eliminate this.

**Key insight**: The `run-sql` path bypasses the Cube.js API gateway entirely — no 10k/50k limit enforcement. The only limit is what's in the SQL itself. This makes it the ideal path for bulk export.

## The Problem

1. **JSON is verbose** — repeated key names per row, quoting overhead. For large result sets this is significant.
2. **No CSV export** — common need for data pipelines, spreadsheets, downstream tools.
3. **No schema description** — consumers can't programmatically discover the shape of results.
4. **10k default limit** — `CUBEJS_DB_QUERY_DEFAULT_LIMIT` silently caps results even via API.
5. **No streaming** — even when the database supports native format output (e.g. ClickHouse `FORMAT CSV`), we deserialize to JS objects and re-serialize to JSON. Wasteful for large exports.

## Candidate Implementation Paths

### Path A: Format param on `/api/v1/run-sql` (lowest effort)

The `run-sql` route already has raw rows from the driver. Add a `format` body param:

```
POST /api/v1/run-sql
{ "query": "SELECT ...", "format": "csv" }
```

- **Pros**: Simplest change (one route, ~20 lines). No Cube.js engine limits apply. Raw driver rows are easy to serialize.
- **Cons**: Only works for raw SQL path. Bypasses Cube.js security context, access controls, and query rewrite rules (already blocked for teams with rewrite rules). Not usable for Cube.js semantic queries.

### Path B: New `/api/v1/export` route

A dedicated export endpoint that accepts either a Cube.js query or raw SQL, runs it, and returns the result in the requested format:

```
POST /api/v1/export
{ "query": {...}, "format": "csv", "limit": 50000 }
```

- **Pros**: Clean separation. Can support both Cube.js queries and raw SQL. Can set proper `Content-Type` and `Content-Disposition` headers for download.
- **Cons**: More plumbing. Needs to duplicate some of the Cube.js client flow for semantic queries.

### Path C: Transform layer in Actions service

Add format conversion in `cubejsApi.js` query method before returning to Hasura:

- **Pros**: Works for all existing GraphQL actions without new routes.
- **Cons**: Hasura actions return typed GraphQL — can't return raw CSV through `FetchDatasetOutput`. Would need a new action or workaround. Adds complexity to the wrong layer.

### Path D: Format param on existing routes (pragmatic middle ground)

Add `format` support to both `/api/v1/run-sql` and a thin wrapper around the Cube.js `/load` call:

- `/api/v1/run-sql` — direct driver, format param
- `/api/v1/query` (new) — wraps Cube.js load, converts result to requested format

- **Pros**: Covers both raw SQL and semantic query paths. Keeps logic in CubeJS service.
- **Cons**: Moderate effort. The semantic query path still goes through Cube.js limits.

## Recommendation

**Path A first** (run-sql with format param), then extend to semantic queries.

`/api/v1/run-sql` is the fastest path — the raw rows are already there, no Cube.js engine limits apply, and it's a single-file change. For databases that support native format output (ClickHouse), we can stream the response directly without intermediate deserialization.

### Streaming strategy

For **ClickHouse** (and any driver that supports it): append `FORMAT CSV` (or `FORMAT CSVWithNames`) to the SQL and stream the HTTP response body directly to the client. No row-by-row parsing, no JS object allocation — the database does the serialization.

For **other databases**: fetch rows via the driver as today, serialize to CSV in a streaming fashion (row-by-row write to response).

This two-tier approach means ClickHouse exports can handle arbitrarily large result sets with constant memory, while other databases still get CSV support with reasonable overhead.

## Format Details

### CSV
- `Content-Type: text/csv`
- `Content-Disposition: attachment; filename="export.csv"`
- Header row from column names
- Standard RFC 4180 quoting
- **ClickHouse fast path**: Use `FORMAT CSVWithNames` in the SQL query itself; stream the raw HTTP response body from ClickHouse directly to the client. Zero intermediate parsing.
- **Generic path**: `driver.query()` → iterate rows → write CSV lines to response stream.

### JSON-Stat
- A compact, metadata-rich format designed for statistical data exchange
- Research needed — see next section

## JSON-Stat Research

### JSON-Stat 2.0 Format Summary

JSON-Stat is a compact, metadata-rich format for statistical data exchange. A dataset is a single JSON object:

```json
{
  "version": "2.0",
  "class": "dataset",
  "label": "Population by country and year",
  "id": ["country", "year"],
  "size": [3, 2],
  "dimension": {
    "country": {
      "label": "Country",
      "category": {
        "index": {"US": 0, "DE": 1, "FR": 2},
        "label": {"US": "United States", "DE": "Germany", "FR": "France"}
      }
    },
    "year": {
      "label": "Year",
      "category": {
        "index": {"2023": 0, "2024": 1},
        "label": {"2023": "2023", "2024": "2024"}
      }
    }
  },
  "value": [331, 333, 83, 84, 67, 68]
}
```

**Key properties:**
- **`id`** + **`size`**: dimension ordering and cardinality (determines value array layout)
- **`value`**: flat array in row-major order (rightmost dimension iterates fastest). Can be sparse object for nulls.
- **`status`**: per-observation metadata (array, string, or sparse object)
- **`role`**: semantic roles — `time`, `geo`, `metric`, `classification`
- **`dimension.*.category.unit`**: measurement units with `decimals`, `symbol`, `position`, `label`
- **`note`**: annotations at dataset, dimension, or category level
- **`link`**: related resources by IANA relation type
- **`extension`**: provider-specific metadata (open structure)

**Why it's compact:** Values are a flat array — no repeated key names. Dimension metadata is stored once, not per-row. For a 3×2 dataset, JSON-Stat stores 6 values + 2 dimension definitions vs. JSON's 6 objects × 3 keys each.

### Cube.js → JSON-Stat Mapping

| Cube.js Concept | JSON-Stat Equivalent |
|---|---|
| Dimensions | `dimension` objects with `category.index` + `category.label` |
| Measures | Values in `value` array; measure names become a metric-role dimension |
| Time dimensions | Dimension with `role.time` |
| Filters | Reduce category set in affected dimensions |
| `limit` / `offset` | Not native to JSON-Stat (applied before encoding) |
| Query results (rows × columns) | Flattened to `value[]` in row-major order |

**Multiple measures**: JSON-Stat handles this by creating a "metric" dimension. If a Cube.js query has measures `[count, revenue]` and dimension `[country]`, the JSON-Stat encoding uses `id: ["metric", "country"]` with `size: [2, N]` where the metric dimension has categories `{count: 0, revenue: 1}`.

### jsonstat-toolkit Library (Fork: `smartdataHQ/toolkit`)

**Fork status**: Identical to upstream `jsonstat/toolkit` v2.2.2. No modifications yet. Default branch: `master`.

**What it does**: Parses JSON-Stat responses into a traversable object model with methods for dimension/category navigation and tabular conversion.

**API surface** (1,776 lines, zero dependencies):

| Method | Purpose |
|---|---|
| `JSONstat(input)` | Entry point — parses JSON-Stat object or fetches URL |
| `.Dataset(n\|id)` | Select dataset from bundle/collection |
| `.Dimension(n\|id)` | Navigate to dimension |
| `.Category(n\|id)` | Navigate to category within dimension |
| `.Data(pos\|coords)` | Access individual cell values |
| `.Dice(filters, opts)` | Subset dataset by category filters |
| `.Unflatten(callback)` | Iterate all cells with coordinates (efficient core loop) |
| `.Transform(opts)` | Convert to tabular format (replacement for toTable) |
| `.toTable(opts)` | Legacy tabular conversion (deprecated, planned removal in 3.0) |

**Build**: Rollup → 4 outputs: IIFE, CJS, ESM (module.mjs), ESM (import.mjs). ~18KB each.

### Performance Bottlenecks in the Toolkit

Key areas where the library is slow for large datasets:

1. **`normalize()` (line 27-58)** — On parse, expands sparse value/status objects into full arrays. For a sparse dataset with 1M positions but 10K values, this allocates a 1M-element array with a push loop. Could use `TypedArray` + index map instead.

2. **`toTable()` (line 904-1355)** — The legacy method is O(n × d) with heavy inner loops:
   - Lines 1299-1306: **Reverse-lookup of category index** — iterates all categories to find which one has `index===j`. This is O(categories²) per dimension. The index is already an object mapping id→position; it should be inverted once to position→id.
   - Lines 1312-1335: Pre-expands all dimension labels into full-length arrays (`dimexp`), each of size `total`. For 3 dimensions of size 100, this creates 3 arrays of 1M elements each. Memory-intensive and unnecessary — labels can be computed on-the-fly from position using modular arithmetic.
   - Lines 1102-1109: Inner loop builds row objects with `j--` reverse iteration. Creates a new object per row.

3. **`Dice()` (line 510-716)** — Filtering calls `Transform({type: "arrobj"})` first (line 623), converting the entire dataset to tabular form just to filter it. The TODO on line 624 acknowledges this: "Remove this extra loop: use Unflatten instead of Transform+forEach". For a 1M-row dataset where you want 1K rows, this materializes all 1M rows as objects first.

4. **`Transform()` (line 1432-1774)** — The newer replacement for toTable. Uses `Unflatten()` internally (good), but:
   - `content === "label"` path calls `d.Category(coordinates[dimId]).label` per cell (line 1495), which does a full Category lookup including child/unit/note/coordinates resolution for every single cell. Only the label is needed.
   - The `"arrobj"` + `by` pivot path (line 1660+) uses `Object.values(ret).join('|')` as a Map key (line 1705) — string concatenation per row for deduplication.

5. **`Data()` with object/array coordinates (line 740-897)** — Each call to `Data({country: "US", year: "2023"})` does a linear scan through dimensions and category index lookups. No caching of dimension metadata between calls.

6. **`JSON.parse(JSON.stringify(this))` in `Dice()` clone (line 556)** — Full deep clone via JSON round-trip. For large datasets this is extremely slow.

### Performance Improvement Strategy

**Priority 1 — Hot path optimizations (no API changes):**
- Fix the O(categories²) reverse-index lookup in `toTable()` — pre-build position→id map once
- Replace `dimexp` full-expansion with on-the-fly label computation via modular arithmetic
- In `Transform()`, create a fast label-only lookup cache instead of full `Category()` calls
- Fix `Dice()` to use `Unflatten()` directly instead of materializing all rows first

**Priority 2 — Structural improvements:**
- Add streaming/iterator support: `Unflatten()` could yield rows instead of collecting into array
- Support `TypedArray` throughout (partially started in v1.4.0) — avoid boxing numbers into objects
- Add a "direct write" path: instead of building JS objects and then serializing, write CSV/JSON lines directly to a stream from the flat value array + dimension metadata

**Priority 3 — Synmetrix-specific additions:**
- Add a `fromRows(columns, rows)` factory that builds JSON-Stat directly from database result sets without intermediate JSON
- Add a `toCSV()` method that streams CSV from the flat value array + dimensions (no intermediate tabular conversion)
- Add a `toCubeResponse()` method that converts JSON-Stat back to Cube.js response format

## Key Files

- `services/cubejs/src/routes/runSql.js` — raw SQL route (primary target)
- `services/cubejs/src/routes/index.js` — route registration
- `services/cubejs/index.js` — CubeJS server config + env vars
- `services/actions/src/utils/cubejsApi.js` — Actions service Cube.js client wrapper
- `services/actions/src/rpc/runQuery.js` — run_query RPC handler
- `services/actions/src/rpc/fetchDataset.js` — fetch_dataset RPC handler
- `@cubejs-backend/shared/dist/src/env.js` — `CUBEJS_DB_QUERY_DEFAULT_LIMIT` (10k), `CUBEJS_DB_QUERY_LIMIT` (50k)
- `client-v2/src/components/ExploreSettingsForm/index.tsx` — frontend `MAX_ROWS_LIMIT` (10k)
- `services/actions/src/rpc/genSql.js` — semantic query → raw SQL compilation (existing)
- `services/actions/src/utils/playgroundState.js` — `replaceQueryParams()` for SQL param substitution
- `services/cubejs/src/utils/driverFactory.js` — driver creation (25+ databases, ClickHouse via `@cubejs-backend/clickhouse-driver`)
- `smartdataHQ/toolkit` (GitHub) — forked jsonstat-toolkit v2.2.2, currently identical to upstream
- `smartdataHQ/toolkit/src/jsonstat.js` — 1,776 lines, core library with performance bottlenecks identified above
