# Feature Specification: Improved Query Output

**Feature Branch**: `009-query-output`
**Created**: 2026-03-12
**Status**: Draft
**Input**: User description: "Improved Query Output"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - CSV Export via Raw SQL (Priority: P1)

A data analyst runs a SQL query through the Synmetrix API and needs the results as a CSV file for import into a spreadsheet, data pipeline, or BI tool. They request CSV format and receive a streamable CSV response directly — without the overhead of JSON serialization and client-side conversion.

For databases that natively produce CSV (like ClickHouse with its `FORMAT CSVWithNames` clause), the system appends the format directive to the SQL and returns the raw database CSV output directly — zero parsing, zero object allocation. True streaming (constant-memory for million-row exports) is a separate enhancement in User Story 6. For other databases, the system fetches rows via the driver and serializes to CSV.

**Why this priority**: CSV is the most universally consumed data interchange format. This unblocks bulk export, pipeline integrations, and eliminates the need for clients to parse verbose JSON and re-serialize. The ClickHouse fast path enables zero-overhead streaming of arbitrarily large result sets with constant memory.

**Independent Test**: Can be tested by sending a raw SQL query to the API with a format parameter set to CSV and verifying the response is valid RFC 4180 CSV with correct headers.

**Acceptance Scenarios**:

1. **Given** a user with a valid datasource connection, **When** they submit a SQL query requesting CSV format, **Then** the response is a valid CSV file with a header row and correct `Content-Type: text/csv` header.
2. **Given** a ClickHouse datasource, **When** a user requests CSV output, **Then** the system appends a native CSV format directive to the SQL and returns the database CSV response directly with no intermediate row-by-row processing.
3. **Given** a non-ClickHouse datasource (e.g. PostgreSQL), **When** a user requests CSV output, **Then** the system fetches rows from the driver and serializes them to CSV before streaming the response.
4. **Given** a query that returns no rows, **When** CSV format is requested, **Then** for ClickHouse the response contains only the header row (native behavior); for other databases where column metadata is unavailable, the response is an empty body.
5. **Given** a query with values containing commas, quotes, or newlines, **When** CSV format is requested, **Then** values are properly escaped per RFC 4180.

---

### User Story 2 - JSON-Stat Output for Statistical Data Consumers (Priority: P2)

A data consumer (external system, dashboard, or API client) needs query results in JSON-Stat 2.0 format — a compact, metadata-rich standard for statistical data exchange. Instead of receiving verbose JSON with repeated key names per row, they receive a single flat value array with dimension metadata, dramatically reducing payload size for multi-dimensional query results.

**Why this priority**: JSON-Stat is significantly more compact than row-per-object JSON for dimensional data (which is exactly what Cube.js produces). It carries dimension semantics (time, geo, metric roles) that enable consuming tools to automatically interpret the data. This is a differentiator for Synmetrix as a semantic layer platform.

**Independent Test**: Can be tested by submitting a query with multiple dimensions and measures, requesting JSON-Stat format, and validating the response against the JSON-Stat 2.0 schema — verifying dimensions map correctly, values are in row-major order, and roles are assigned.

**Acceptance Scenarios**:

1. **Given** a query with dimensions and measures, **When** JSON-Stat format is requested, **Then** the response is a valid JSON-Stat 2.0 dataset with `version`, `class`, `id`, `size`, `dimension`, and `value` properties.
2. **Given** a query with a time dimension, **When** JSON-Stat format is requested, **Then** the time dimension's ID appears in the dataset-level `role.time` array.
3. **Given** a query with multiple measures, **When** JSON-Stat format is requested, **Then** measures are represented as a metric-role dimension with each measure as a category.
4. **Given** a query returning 10,000 rows with 5 columns, **When** JSON-Stat format is requested, **Then** the payload is at least 50% smaller than the equivalent default JSON response.
5. **Given** null values in query results, **When** JSON-Stat format is requested, **Then** nulls are correctly represented in the value array (as `null` in dense arrays or omitted in sparse objects).

---

### User Story 3 - Improved jsonstat-toolkit Performance (Priority: P2)

A developer using the jsonstat-toolkit library to process or transform JSON-Stat datasets experiences slow performance on large datasets (100K+ observations). After performance improvements to the forked library, operations like tabular conversion, filtering (Dice), and cell iteration complete significantly faster with lower memory usage.

Six specific bottlenecks have been identified in the current library:
1. **Sparse value expansion** — on parse, normalize() expands sparse value/status objects into full-length arrays via a push loop. For a sparse dataset with 1M positions but 10K values, this unnecessarily allocates a 1M-element array.
2. **Quadratic category lookup** — toTable() reverse-looks-up category IDs by iterating all categories for each position, making it O(categories²) per dimension.
3. **Full label pre-expansion** — toTable() pre-expands all dimension labels into full-length arrays (3 dims × 100 categories = 3 arrays of 1M elements each) instead of computing labels on-the-fly via modular arithmetic.
4. **Dice full materialization** — Dice() converts the entire dataset to tabular form just to filter it, even when selecting a tiny subset.
5. **Deep clone via JSON round-trip** — Dice() clones datasets using JSON.parse(JSON.stringify()), which is extremely slow for large datasets.
6. **Expensive per-cell Category lookups** — Transform() calls the full Category() method (resolving child, unit, note, coordinates) for every single cell when only the label is needed.

**Why this priority**: The jsonstat-toolkit is the reference implementation for working with JSON-Stat data. If Synmetrix produces JSON-Stat output, consumers will use this library. These bottlenecks make it impractical for the dataset sizes Synmetrix handles.

**Independent Test**: Can be tested by running the toolkit's existing test suite plus benchmark tests on datasets of 100K and 1M observations, comparing execution time and memory usage before and after optimizations.

**Acceptance Scenarios**:

1. **Given** a dataset with 100K observations, **When** converting to tabular format using Transform(), **Then** the operation completes in under 500ms (vs. current multi-second times).
2. **Given** a dataset with 1M observations, **When** filtering with Dice() to select 1% of rows, **Then** the operation does not allocate memory for all 1M rows.
3. **Given** the optimized toolkit, **When** running the existing upstream test suite, **Then** all tests pass without regression.
4. **Given** a dataset with 50+ categories per dimension, **When** converting to tabular format using toTable(), **Then** the category reverse-lookup does not exhibit quadratic scaling.
5. **Given** a sparse dataset with 1M positions and 10K values, **When** parsed by the toolkit, **Then** memory usage is proportional to the number of actual values, not the total positions.
6. **Given** a Dice() clone operation on a 100K-observation dataset, **When** executed, **Then** cloning does not use JSON serialization round-trip.

---

### User Story 4 - Toolkit Streaming and Synmetrix Integration Methods (Priority: P2)

The jsonstat-toolkit fork needs structural additions to support Synmetrix's data pipeline: a factory method to build JSON-Stat directly from database result sets (rows + column metadata), a method to stream CSV output directly from the flat value array without intermediate tabular conversion, and iterator/streaming support for the core Unflatten loop so that large datasets can be processed without collecting all rows into memory.

**Why this priority**: Without these, Synmetrix would need to convert database rows → JSON → JSON-Stat (wasteful) and JSON-Stat → tabular → CSV (wasteful). Direct conversion paths eliminate intermediate allocations and enable end-to-end streaming.

**Independent Test**: Can be tested by passing raw database query results (column names + row arrays) to the factory method and verifying the output is a valid JSON-Stat dataset; and by calling the CSV method on a dataset and verifying valid CSV output without intermediate array allocation.

**Acceptance Scenarios**:

1. **Given** a set of column names and row arrays from a database query, **When** passed to a factory method, **Then** a valid JSON-Stat 2.0 dataset is produced with correct dimensions, categories, and values.
2. **Given** a JSON-Stat dataset, **When** CSV output is requested, **Then** the CSV is produced directly from the flat value array and dimension metadata without building an intermediate tabular array.
3. **Given** a large dataset, **When** iterating with a streaming/iterator API, **Then** rows are yielded one at a time without collecting all results into an array first.

---

### User Story 5 - Frontend Output Format Selection (Priority: P1)

A data analyst using the Synmetrix Explore page wants to export query results in CSV or JSON-Stat format directly from the UI. Instead of being limited to the current client-side CSV export (which only exports visible rows up to the current limit), they select their desired output format from a dropdown and receive a full server-side export — including rows beyond the current page limit.

Today the Explore page has a "CSV" download button powered by `react-csv` that exports only the rows currently loaded in memory (subject to `MAX_ROWS_LIMIT` of 10,000 and the user's limit/offset settings). The new format selector replaces this with a server-side export flow: the frontend calls `gen_sql` to compile the current semantic query to raw SQL, then hits the run-sql endpoint with the chosen format parameter, triggering a file download.

**Why this priority**: The Explore page is where most users interact with query results. Without a UI for format selection, only API-savvy users can access CSV and JSON-Stat exports. This makes the backend format support accessible to all users.

**Independent Test**: Can be tested by building an exploration query in the Explore page, selecting "CSV" from the format dropdown, and verifying that a CSV file downloads with all matching rows (not just the visible page).

**Acceptance Scenarios**:

1. **Given** a user viewing query results in the Explore page, **When** they click the export dropdown, **Then** they see options for "Export JSON", "Export CSV", and "Export JSON-Stat".
2. **Given** a user selects CSV export, **When** the export executes, **Then** the system calls gen_sql to compile the **last-executed** exploration's semantic query to SQL, passes it to run-sql with `format=csv`, and triggers a browser file download. If the user has edited the query but not re-run it, the export uses the previous run's query (matching the visible results).
3. **Given** a user selects JSON-Stat export, **When** the export executes, **Then** the system follows the same gen_sql → run-sql flow with `format=jsonstat` and triggers a download.
4. **Given** a query with results exceeding the current page limit, **When** CSV or JSON-Stat export is selected, **Then** the downloaded file contains all matching rows (not limited to the visible page). JSON export respects existing row limits.
5. **Given** an export is in progress, **When** the user sees the export button, **Then** a loading state is shown until the download completes or an error is displayed.

---

### User Story 6 - Database-Native Streaming for Large Exports (Priority: P3)

A data engineer needs to export a full table or large query result (millions of rows) without the application server running out of memory or timing out. For supported databases, the system streams the result directly from the database to the client, using constant memory regardless of result size.

**Why this priority**: Without streaming, the application must buffer the entire result set in memory before sending it. This limits practical export size and creates a scaling bottleneck. Streaming is essential for production data pipeline use cases.

**Independent Test**: Can be tested by exporting a 1M+ row result set from ClickHouse and verifying that application memory usage remains constant (does not grow proportionally to result size).

**Acceptance Scenarios**:

1. **Given** a ClickHouse query returning 1M rows, **When** CSV streaming export is requested, **Then** the first bytes of the response arrive within 2 seconds (not after full materialization).
2. **Given** a streaming export in progress, **When** the client disconnects, **Then** the server stops processing and releases resources promptly.
3. **Given** a database that does not support native streaming, **When** a large export is requested, **Then** the system falls back to row-by-row serialization with a configurable row limit to prevent memory exhaustion.

---

### Edge Cases

- What happens when the requested format is not recognized? The system returns a clear error indicating supported formats.
- What happens when the datasource connection fails mid-stream during a CSV export? The response stream is terminated; clients detect the error from an incomplete response.
- What happens when a query returns columns with conflicting names in JSON-Stat mapping? Column names are used as-is for category IDs; duplicates are disambiguated by appending a numeric suffix.
- What happens when a query has no dimensions (measures only)? JSON-Stat output contains a single metric dimension with one observation per measure.
- What happens when the query contains binary or non-UTF8 data? Binary columns are base64-encoded in CSV; JSON-Stat omits them with a warning in the extension property.
- What happens when a semantic query needs CSV output? The frontend uses the gen_sql action to compile the semantic query to SQL, then passes that SQL to the run-sql endpoint with the format parameter. This two-step flow is transparent to the user — the format selector in the Explore page handles it automatically.
- What happens when raw SQL requests JSON-Stat without dimension/measure hints? The system infers from data types and column names, but may misclassify (e.g., numeric ZIP codes as measures, year integers as measures). A warning is included in the `extension` property. Callers that need exact classification should pass `measures` and `timeDimensions` in the request body (using SQL column aliases, not semantic member names). The frontend always passes these from gen_sql's column metadata.
- What happens when a governed team (with query rewrite rules) tries to export? The run-sql endpoint returns 403 (`sql_api_blocked`) for any team with active query rewrite rules. This is an existing architectural constraint — the export feature is unavailable to governed teams. A future enhancement could add format support to the `fetch_dataset` action path, which respects rewrite rules.
- What happens when the SQL result has duplicate dimension tuples (e.g., two rows with the same country+year)? JSON-Stat requires unique dimension coordinates. The builder sums duplicate values for numeric measures and takes the last value for non-numeric measures, with a warning in the `extension` property.
- What happens with JSON-Stat category ordering? Categories are ordered by first appearance in the result set. The value array follows row-major order matching the `id` array sequence.
- What happens when the result is not truly dimensional (e.g., arbitrary SELECT with no GROUP BY)? Each column becomes a dimension with one category per unique value. This produces a valid but potentially large JSON-Stat dataset. A warning in `extension` notes that the data may not be suitable for dimensional analysis.
- What happens when a large CSV export is triggered from the Explore page? The frontend uses `fetch()` → Blob → object URL for download, which buffers the entire response in browser memory. For very large exports (100MB+), this may cause browser memory pressure. This is a known limitation; future enhancement could use `ReadableStream` piping to avoid buffering.

## Current State & Context

### How query results flow today

There are four paths through which query results are returned, all producing JSON:

1. **Cube.js `/load` API** — the semantic query engine with a default limit of 10,000 rows (`CUBEJS_DB_QUERY_DEFAULT_LIMIT`) and a hard max of 50,000 (`CUBEJS_DB_QUERY_LIMIT`). Supports two JSON response formats: `default` (verbose row-per-object) and `compact` (columnar — already reduces payload, but still JSON).
2. **`fetch_dataset` action** — wraps the Cube.js `/load` API via the client library; same limits apply.
3. **`run_query` action** — wraps raw SQL execution; the caller provides the LIMIT clause in SQL.
4. **Raw SQL route** — executes SQL directly against the database driver; no engine-level limits.

### The gen_sql → run-sql chain

The building blocks to go from a semantic query to raw database output already exist but require two round trips:

1. **gen_sql** compiles a Cube.js semantic query (exploration) to raw SQL with parameters substituted. Currently accepts only `exploration_id` — the generated SQL includes the LIMIT from the exploration's stored `playground_state` (default 100). No way to override the limit or get column metadata through the GraphQL mutation.
2. **run-sql** executes that raw SQL against the database driver and returns rows.

Today a client must call gen_sql first, then pass the SQL to run_query (which wraps it in `SELECT * FROM (...) LIMIT n` and hits run-sql). The gen_sql handler internally supports `limit` and `offset` args via `rawSql()`, but these are not exposed through the Hasura action. For export to work correctly, gen_sql must be extended to accept a limit override and return column metadata (alias → member mapping).

### Decision: Implementation approach

Four candidate approaches were evaluated (detailed in `docs/plans/009-export-formats.md`):
- **Path A**: Format param on the existing raw SQL route (lowest effort, raw SQL only)
- **Path B**: New dedicated `/export` route (clean, but more plumbing)
- **Path C**: Transform layer in Actions service (wrong layer — Hasura actions can't return raw CSV)
- **Path D**: Format param on both raw SQL and a new semantic query wrapper

**Decision**: Start with Path A (format param on raw SQL route), then extend to semantic queries if needed. The raw SQL route is the fastest path — rows are already in hand, no engine limits apply, and for ClickHouse the database can produce CSV natively.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support a `format` parameter on query endpoints accepting values `json` (default), `csv`, and `jsonstat`. When `format` is `json` or omitted, the **existing code path is unchanged** — same `driver.query()` call, same `res.json()` response, same row limits, same behavior. New format handling is additive only; it branches after the existing auth/scope resolution and never modifies the legacy JSON path.
- **FR-002**: System MUST return CSV responses with `Content-Type: text/csv` and RFC 4180-compliant formatting including proper escaping of commas, quotes, and newlines. Binary or non-UTF8 column values MUST be base64-encoded.
- **FR-003**: System MUST return JSON-Stat responses conforming to the JSON-Stat 2.0 specification with correct `version`, `class`, `id`, `size`, `dimension`, and `value` properties. Binary or non-UTF8 columns MUST be omitted with a warning in the `extension` property.
- **FR-004**: System MUST assign roles at the dataset level per JSON-Stat 2.0: time dimensions listed in `role.time`, measures modeled as a metric-role dimension listed in `role.metric`. Roles MUST NOT appear on individual dimension objects.
- **FR-005a**: System MUST use the database's native CSV format directive (e.g., ClickHouse `FORMAT CSVWithNames`) when available, loading the full response into memory for the MVP. This avoids row-by-row serialization but does not yet provide constant-memory streaming.
- **FR-005b** *(P3/US6)*: System MUST stream CSV responses directly from the database to the client with constant memory, using the driver's streaming API (e.g., `resultSet.stream()`), without buffering the full result.
- **FR-006**: System MUST fall back to row-by-row CSV serialization for databases that do not support native CSV output.
- **FR-007**: System MUST return an appropriate error when an unsupported format is requested.
- **FR-007a**: When `format=jsonstat`, the request body MAY include `measures` (array of SQL column aliases) and `timeDimensions` (array of SQL column aliases) to provide explicit dimension/measure classification. When provided, these hints MUST be used instead of heuristic inference. Note: these MUST be the actual SQL column aliases (e.g., `orders__count`), not semantic member names (e.g., `Orders.count`).
- **FR-007b**: When `format=jsonstat` and no explicit hints are provided, the system MUST infer dimensions vs measures from column data types and column name patterns, and MUST include a warning in the JSON-Stat `extension` property indicating that classification was heuristic.
- **FR-008**: The jsonstat-toolkit fork MUST eliminate the O(n²) category reverse-lookup in toTable() by pre-building a position-to-ID map.
- **FR-009**: The jsonstat-toolkit fork MUST optimize Dice() to avoid full-dataset materialization when filtering, using direct iteration instead of converting the entire dataset to tabular form first.
- **FR-010**: The jsonstat-toolkit fork MUST replace full Category() lookups in Transform() with a lightweight label-only cache that avoids resolving child, unit, note, and coordinates for every cell.
- **FR-011**: The jsonstat-toolkit fork MUST replace the JSON.parse(JSON.stringify()) deep clone in Dice() with a structured clone that avoids full serialization.
- **FR-012**: The jsonstat-toolkit fork MUST optimize normalize() to avoid allocating full-length arrays for sparse datasets where the number of actual values is much smaller than the total positions.
- **FR-013**: The jsonstat-toolkit fork MUST add a Data() dimension metadata cache so that repeated lookups by coordinate do not re-scan dimension structures.
- **FR-014**: The jsonstat-toolkit fork MUST add streaming/iterator support to Unflatten() so rows can be yielded one at a time without collecting all results into an array.
- **FR-015**: The jsonstat-toolkit fork MUST add a factory method to build JSON-Stat datasets directly from database result sets (column names + row arrays) without intermediate JSON conversion.
- **FR-016**: The jsonstat-toolkit fork MUST add a toCSV() method that produces CSV directly from the flat value array and dimension metadata without intermediate tabular conversion.
- **FR-017**: The jsonstat-toolkit fork MUST pass all existing upstream tests after all optimizations and additions.
- **FR-018**: System MUST include a `Content-Disposition` header with a filename for downloads: `query-result.csv` for API-direct CSV calls, `query-result.json` for API-direct JSON-Stat calls. The frontend MAY use a different filename convention (e.g., `exploration-export.csv`) for user-initiated exports.
- **FR-019**: The Explore page MUST provide a format selector (dropdown or similar) offering JSON, CSV, and JSON-Stat export options.
- **FR-020**: When an export format is selected in the Explore page, the frontend MUST compile the last-executed semantic query to SQL via gen_sql, then request the result from run-sql with the chosen format parameter. For JSON-Stat exports, the frontend MUST pass `measures` and `timeDimensions` using the SQL column aliases returned by gen_sql (not the semantic member names from playground state).
- **FR-024**: The `gen_sql` action MUST accept an optional `limit` parameter. When omitted or set to `0`, the generated SQL MUST NOT include a LIMIT clause, enabling full-result exports. When provided, it overrides the exploration's stored `playground_state.limit`.
- **FR-025**: The `gen_sql` action MUST return column metadata alongside the SQL string: an array of `{ alias, member, type }` objects mapping each SQL column alias to its semantic member name and role (`dimension`, `timeDimension`, or `measure`). This enables the frontend to pass correct SQL-alias-based hints to run-sql for JSON-Stat classification.
- **FR-026**: For ClickHouse native CSV output, NULL values (rendered as `\N` by ClickHouse) MUST be normalized to empty strings to maintain RFC 4180 compliance. This post-processing is acceptable in the MVP (buffered) path; the streaming path (FR-005b) MUST handle per-row normalization.
- **FR-021**: The frontend export MUST bypass the current page limit for CSV and JSON-Stat formats — the downloaded file contains all rows matching the query, not just the visible page. JSON exports continue to respect existing row limits.
- **FR-022**: The frontend MUST replace or augment the existing client-side `react-csv` export with the new server-side format export flow.
- **FR-023**: The frontend MUST show a loading/progress indicator during export and handle errors gracefully (network failures, timeouts, unsupported format).

### Key Entities

- **Query Result**: The raw rows and column metadata returned by a database driver in response to a SQL query.
- **Output Format**: The serialization format applied to query results before returning to the client (JSON, CSV, JSON-Stat).
- **JSON-Stat Dataset**: A JSON-Stat 2.0 dataset object containing dimension metadata and a flat value array representing multi-dimensional observations.
- **Dimension**: A categorical axis of a dataset (e.g. country, time period) with an ordered set of categories.
- **Measure**: A numeric observation value; in JSON-Stat, multiple measures are modeled as categories of a metric-role dimension.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: First bytes of a 10,000-row CSV export response arrive within 1 second for ClickHouse datasources.
- **SC-002**: JSON-Stat output is at least 50% smaller than equivalent default JSON output for queries with 3+ dimensions and 1,000+ rows.
- **SC-003**: The jsonstat-toolkit Transform() operation on a 100K-observation dataset completes in under 500ms.
- **SC-004** *(P3/US6)*: Streaming CSV export of 1M rows from ClickHouse uses constant application memory (no proportional growth with result size).
- **SC-005**: All existing query workflows (JSON format) continue to work identically — the legacy `format=json` path (and omitted format) uses the exact same code path as before, including existing row limits, driver calls, and response serialization. Zero regression.
- **SC-006**: External consumers can validate JSON-Stat responses against the official JSON-Stat 2.0 schema without errors.
- **SC-007**: Users can export query results in CSV or JSON-Stat format from the Explore page with a single click, including rows beyond the current page limit.

## Assumptions

- ClickHouse is the primary database where native CSV streaming will be implemented first; other databases use the generic row-by-row path.
- The raw SQL execution endpoint is the backend target for format support. The frontend Explore page uses the gen_sql → run-sql chain to compile semantic queries to SQL and then request formatted output, making this transparent to users.
- The jsonstat-toolkit fork (`smartdataHQ/toolkit`, currently identical to upstream v2.2.2) will be published as an npm package or used as a direct dependency by Synmetrix.
- JSON-Stat output is primarily targeted at API consumers and data pipelines, not the interactive frontend UI (which will continue to use JSON).
- Hard-coded row limits are removed for CSV and JSON-Stat export paths only: `CUBEJS_DB_QUERY_DEFAULT_LIMIT` (10k), `CUBEJS_DB_QUERY_LIMIT` (50k), and the frontend `MAX_ROWS_LIMIT` (10k) no longer apply when the requested format is `csv` or `jsonstat`. For JSON format, existing limits remain in effect. Non-streaming databases have a safety limit (100k rows) for JSON exports to prevent memory exhaustion. Callers control result size via SQL LIMIT clauses.
- The Cube.js `compact` responseFormat already provides a less-verbose JSON option for semantic queries and can serve as an intermediate improvement while CSV/JSON-Stat support is built out.
- Detailed technical research and implementation path analysis is documented in `docs/plans/009-export-formats.md` and should be referenced during planning.
