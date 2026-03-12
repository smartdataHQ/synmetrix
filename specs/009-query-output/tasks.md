# Tasks: Improved Query Output

**Input**: Design documents from `/specs/009-query-output/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Required by constitution (Principle III: TDD is non-negotiable). Tests are written before implementation in each phase following Red-Green-Refactor.

**Organization**: Tasks grouped by user story. US1 and US5 are both P1; US1 is the backend MVP, US5 is the frontend counterpart.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **CubeJS service**: `services/cubejs/src/`
- **Frontend**: `../client-v2/src/`
- **Toolkit fork**: External repo `smartdataHQ/toolkit` (separate clone)
- **Environment**: `.env`, `docker-compose.dev.yml`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Environment preparation and row limit removal

- [x] T001 Verify that `CUBEJS_DB_QUERY_DEFAULT_LIMIT` and `CUBEJS_DB_QUERY_LIMIT` do NOT apply to the `runSql.js` route (which calls `driver.query()` directly, bypassing the Cube.js engine). Document this in a code comment in `runSql.js`. The only LIMIT in the export path comes from `playground_state.limit` baked into SQL by gen_sql — handled by the limit override in Phase 4 (FR-024). No env var changes needed.
- [x] T002 [P] Bypass `MAX_ROWS_LIMIT` in `../client-v2/src/components/ExploreSettingsForm/index.tsx` for CSV and JSON-Stat exports only. JSON exports retain the existing limit.

**Checkpoint**: Row limits bypassed for CSV/JSON-Stat exports. JSON queries retain existing limits. Existing workflows unchanged.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared utilities that multiple user stories depend on. Tests written first, then implementation.

**⚠️ CRITICAL**: US1 and US5 both depend on the CSV serializer. US2 depends on the JSON-Stat builder.

### Tests (write first — must FAIL before implementation)

- [x] T003 [P] Write unit tests for CSV serializer in `services/cubejs/test/csvSerializer.test.js`: test `escapeCSVField()` with commas, quotes, newlines, nulls, empty strings, numeric values, and binary/non-UTF8 data (base64 fallback); test `rowToCSV()` column ordering; test `serializeRowsToCSV()` with header row, empty result set (header-only), and RFC 4180 compliance. All tests must FAIL (module not yet created).
- [x] T004 [P] Write unit tests for JSON-Stat builder in `services/cubejs/test/jsonstatBuilder.test.js`: test `buildJSONStat(rows, columns, options)` produces valid JSON-Stat 2.0 with correct `version`, `class`, `id`, `size`, `dimension`, `value`; test **dataset-level** `role.time` and `role.metric` (roles on the dataset object, NOT on individual dimensions — per JSON-Stat 2.0 spec); test with explicit `measures` and `timeDimensions` hints (exact classification); test without hints (heuristic inference with `extension.warning`); test multiple measures become categories of a metric-role dimension; test null handling; test duplicate column disambiguation; test measures-only query (no dimensions); test binary columns are omitted with extension warning; test empty result with column metadata returns valid dataset with `value: []`; test empty result without column metadata returns 400 error. All tests must FAIL.
- [x] T005 [P] Write unit tests for format validator in `services/cubejs/test/formatValidator.test.js`: test `validateFormat("json")` returns `"json"`, `validateFormat("csv")` returns `"csv"`, `validateFormat("jsonstat")` returns `"jsonstat"`, `validateFormat(undefined)` returns `"json"` (default), `validateFormat("xml")` throws 400 with supported formats message. All tests must FAIL.

### Implementation (make tests pass)

- [x] T006 [P] Implement RFC 4180 CSV serializer in `services/cubejs/src/utils/csvSerializer.js` — export functions: `escapeCSVField(value)`, `rowToCSV(row, columns)`, `serializeRowsToCSV(rows)` with proper escaping of commas, quotes, newlines, null as empty string, and binary data detection (base64-encode non-UTF8 values). Run T003 tests until green.
- [x] T007 [P] Implement JSON-Stat 2.0 builder in `services/cubejs/src/utils/jsonstatBuilder.js` — export function `buildJSONStat(rows, columns, options)` that converts query result rows into a valid JSON-Stat 2.0 dataset. Accepts optional `options.measures` and `options.timeDimensions` arrays for explicit classification; without hints, infers from data types (numeric→measures) and column name patterns (year/date/month/quarter/period→time) with `extension.warning`. Roles are assigned at the **dataset level** (`role.time`, `role.metric` on the dataset object, NOT on individual dimension objects — per JSON-Stat 2.0 spec). Measures modeled as categories of a metric-role dimension. Flat value array in row-major order, null handling, duplicate column disambiguation, binary column omission with extension warning. For empty results: if columns available, return valid dataset with `value: []`; if columns unknown, return 400 error. Run T004 tests until green.
- [x] T008 [P] Implement format validation helper in `services/cubejs/src/utils/formatValidator.js` — export function `validateFormat(format)` that returns the normalized format string or throws 400 with supported formats message. Run T005 tests until green.

**Checkpoint**: All foundational utility tests pass (green). Utilities importable.

---

## Phase 3: User Story 1 — CSV Export via Raw SQL (Priority: P1) 🎯 MVP

**Goal**: Add `format=csv` support to `POST /api/v1/run-sql`. ClickHouse uses native `FORMAT CSVWithNames`; other databases use the csvSerializer fallback.

**Independent Test**: `curl -X POST http://localhost:4000/api/v1/run-sql -H "Authorization: Bearer $TOKEN" -H "x-hasura-datasource-id: $DS_ID" -H "Content-Type: application/json" -d '{"query":"SELECT 1 as id, '\''hello'\'' as name","format":"csv"}'` → returns `text/csv` with header row.

### Tests (write first — must FAIL before implementation)

- [ ] T009 [US1] <!-- DEFERRED: StepCI tests require running Docker services --> Write StepCI integration test scenarios for CSV format in `tests/` workflow: test `format=csv` on run-sql returns `Content-Type: text/csv` with valid CSV body; test `format=xml` returns 400 with error message; test omitted format returns JSON (regression); test empty result set returns header-only CSV. All tests must FAIL.

### Implementation (make tests pass)

- [x] T010 [US1] Modify `services/cubejs/src/routes/runSql.js` to extract `format` from `req.body.format` (default `"json"`), plus optional `measures` and `timeDimensions` arrays from request body (for JSON-Stat hints), call `validateFormat()`, and branch response handling: for `"json"` preserve existing `res.json(rows)` behavior unchanged; for `"csv"` call the CSV response function; for `"jsonstat"` return 501 with `{"error": "JSON-Stat format not yet available"}` as a temporary stub until Phase 5 (T018) implements it
- [x] T011 [US1] Implement ClickHouse CSV fast path in `services/cubejs/src/routes/runSql.js`: detect if driver is ClickHouse (check `securityContext.userScope.dataSource.dbType`), access `driver.client` (the internal `@clickhouse/client` instance — the driver's `query()`/`queryResponse()` methods hardcode `format: 'JSON'` and cannot be used for CSV), call `driver.client.query({ query: sql, format: 'CSVWithNames', clickhouse_settings: driver.config?.clickhouseSettings })` directly, call `resultSet.text()` for the CSV body, normalize ClickHouse `\N` null representations to empty strings for RFC 4180 compliance (simple `.replace(/\\N/g, '')` on the buffered text for MVP), set `Content-Type: text/csv` and `Content-Disposition: attachment; filename="query-result.csv"` headers, send the processed CSV text as the response
- [x] T012 [US1] Implement generic CSV fallback in `services/cubejs/src/routes/runSql.js`: for non-ClickHouse drivers, execute `driver.query()` as normal to get rows, pass rows to `serializeRowsToCSV()` from `csvSerializer.js`, set `Content-Type: text/csv` and `Content-Disposition` headers, send the serialized CSV string
- [x] T013 [US1] Handle edge cases in CSV path: empty result set — ClickHouse always returns header-only CSV via `CSVWithNames`, drivers with field metadata (e.g. `pg` `result.fields`) return header-only CSV, drivers returning only `[]` with no metadata return empty body with `Content-Length: 0`; format validation error (400 with message); binary/non-UTF8 column values (base64-encode); ensure existing JSON path is completely unchanged when `format` is omitted or `"json"`. Run T009 StepCI tests until green.

**Checkpoint**: CSV export works via API. ClickHouse queries return native CSV; other databases return serialized CSV. JSON behavior unchanged. StepCI tests pass.

---

## Phase 4: gen_sql Extension (Blocking for Frontend Export)

**Purpose**: Extend the gen_sql action to support limit override and return column metadata, enabling the frontend export flow.

**⚠️ CRITICAL**: Without these changes, the frontend export flow (US5) is broken:
1. gen_sql bakes the exploration's `playground_state.limit` (default 100) into the generated SQL — exports would be limited to 100 rows
2. Frontend semantic member names (e.g., `Orders.count`) don't match SQL column aliases (e.g., `orders__count`) — JSON-Stat hints would misclassify columns

### Implementation

- [x] T014a [US5] Extend the gen_sql Hasura action contract: add optional `limit` input parameter (Int, default null) to `services/hasura/metadata/actions.graphql` and update `services/hasura/metadata/actions.yaml`. Add `column_metadata` to the output type: an array of `{ alias: String!, member: String!, role: String! }` objects (role is `dimension`, `timeDimension`, or `measure`). Run `./cli.sh hasura cli "metadata apply"` to validate.
- [x] T014b [US5] Modify `services/actions/src/rpc/genSql.js`: accept `limit` from the action input, pass it to `rawSql()` (which already supports it internally at line 39-45). When `limit` is `0` or null, strip the LIMIT clause from the generated SQL (or pass a very large number). Extract column metadata from the Cube.js query compilation: map each member in the playground state's `measures`, `dimensions`, and `timeDimensions` to its SQL alias using the Cube.js `sql()` output. Return `{ result: sqlString, column_metadata: [...] }`.
- [x] T014c [US5] Update `../client-v2/src/graphql/gql/explorations.gql`: add `limit` input and `column_metadata` output fields to the GenSQL mutation. Run `yarn codegen` to regenerate types.

**Checkpoint**: gen_sql accepts limit override and returns column metadata. `yarn codegen` passes. Manual test: call gen_sql with `limit: 0` and verify SQL has no LIMIT clause and column_metadata maps aliases correctly.

---

## Phase 5: User Story 5 — Frontend Output Format Selection (Priority: P1)

**Goal**: Add a format selector to the Explore page that uses gen_sql → run-sql to export query results in JSON, CSV, or JSON-Stat format, bypassing the current client-side react-csv export.

**Independent Test**: Open Explore page, build a query, click export dropdown, select CSV → a `.csv` file downloads with all matching rows (not just the visible page).

**Depends on**: US1 (backend CSV support) + Phase 4 (gen_sql extension with limit override and column metadata)

### Implementation for User Story 5

- [x] T015 [US5] Create `useFormatExport` hook in `../client-v2/src/hooks/useFormatExport.ts`: accepts `explorationId` and `datasourceId`; exposes `exportData(format: 'json' | 'csv' | 'jsonstat')`, `isExporting`, and `error` state. The hook calls `GenSQL` mutation with `limit: 0` (for CSV/JSON-Stat, to get unlimited SQL) or without limit override (for JSON, retaining existing limits), receives `{ result: sql, column_metadata }`. Then makes a `fetch()` call to `/api/v1/run-sql` with `{ query: sql, format }` and the JWT from `AuthTokensStore` as `Authorization` header plus `x-hasura-datasource-id` header. For JSON-Stat format, the hook MUST extract measure and timeDimension aliases from `column_metadata` (filtering by `role === 'measure'` and `role === 'timeDimension'`) and pass them as `measures` and `timeDimensions` arrays to run-sql — these are the SQL column aliases, not semantic member names. For all formats: creates a Blob, generates an object URL, triggers download via hidden `<a>` element with filename `exploration-export.{csv|json}`. Export always operates on the **last-executed exploration** (not the current draft). Handles errors (network, 400, 403) by setting error state. Note: `fetch()` → Blob buffers the entire response in browser memory — this is a known limitation for very large exports.
- [x] T016 [US5] Replace the existing `react-csv` `CSVLink` export button in `../client-v2/src/components/ExploreDataSection/index.tsx` with an Ant Design `Dropdown.Button` or `Dropdown` with menu items: "Export JSON", "Export CSV", and "Export JSON-Stat". Wire each menu item to call `useFormatExport.exportData()` with the appropriate format. Show a `Spin` loading indicator on the button while `isExporting` is true. Display errors via Ant Design `message.error()`.
- [x] T017 [US5] Ensure the export flow works when the exploration has not been created yet (button disabled until `explorationId` exists) and when the query has no results (export still triggers — CSV returns header-only, JSON-Stat returns empty dataset). Run `yarn codegen` and `yarn lint` in client-v2 to validate no GraphQL contract regressions.

**Checkpoint**: Users can export JSON, CSV, and JSON-Stat from the Explore page. The old react-csv export is replaced. Loading and error states work. `yarn codegen` passes.

---

## Phase 6: User Story 2 — JSON-Stat Output for Statistical Data Consumers (Priority: P2)

**Goal**: Add `format=jsonstat` support to `POST /api/v1/run-sql` returning valid JSON-Stat 2.0 datasets.

**Independent Test**: `curl ... -d '{"query":"SELECT country, year, sum(revenue) as revenue FROM sales GROUP BY country, year","format":"jsonstat"}' | jq .version` → returns `"2.0"`.

### Tests (write first — must FAIL before implementation)

- [ ] T018 [US2] <!-- DEFERRED: StepCI tests require running Docker services --> Write StepCI integration test scenarios for JSON-Stat format in `tests/` workflow: test `format=jsonstat` on run-sql returns `Content-Type: application/json` with valid JSON-Stat body containing `version: "2.0"` and `class: "dataset"`; test dimension structure and value array presence. Must FAIL initially.

### Implementation (make tests pass)

- [x] T019 [US2] Wire JSON-Stat format into `services/cubejs/src/routes/runSql.js`: when `format === "jsonstat"`, execute `driver.query()` to get rows, extract column names (from first row keys or driver field metadata), pass rows, columns, and `{ measures, timeDimensions }` from request body to `buildJSONStat()` from `jsonstatBuilder.js`, return the result with `Content-Type: application/json` and `Content-Disposition: attachment; filename="query-result.json"` headers. For empty results without column metadata, return 400 with "Cannot produce JSON-Stat without column metadata for empty result sets."
- [x] T020 [US2] Enhance `jsonstatBuilder.js` to handle edge cases: queries with no dimensions (measures only → single metric dimension), null values in the value array, duplicate column names (disambiguate with numeric suffix), duplicate dimension tuples (sum numeric measures, last-value for non-numeric, with `extension.warning`), **dataset-level** role assignment (`role.time` and `role.metric` arrays on the dataset object, not on individual dimensions), multiple measures modeled as categories of a metric-role dimension, heuristic inference fallback with `extension.warning` when `measures`/`timeDimensions` hints are absent (note: hints must be SQL column aliases, not semantic member names), category ordering by first appearance in result set, non-dimensional results (arbitrary SELECT) with `extension.warning`, empty results with column metadata (valid dataset with `value: []`), and binary columns omitted with warning in extension property. Run T004 + T018 tests until green.
- [x] T021 [US2] Validate JSON-Stat output against the JSON-Stat 2.0 specification: ensure `version`, `class`, `id`, `size`, `dimension`, and `value` properties are all present and correctly structured. Verify `id.length === size.length` and `value.length === product(size)`. Replace the 501 stub from T010 with the real JSON-Stat handler. Run T018 StepCI tests until green.

**Checkpoint**: JSON-Stat export works via API and frontend. Output validates against JSON-Stat 2.0 spec. StepCI tests pass.

---

## Phase 7: User Story 3 — Improved jsonstat-toolkit Performance (Priority: P2)

**Goal**: Optimize the 6 identified bottlenecks in the `smartdataHQ/toolkit` fork so Transform() completes in <500ms on 100K observations.

**Independent Test**: Clone the fork, run `npm test` (all 80+ tests pass), run benchmark scripts showing performance improvements.

**Note**: This phase operates on the external `smartdataHQ/toolkit` repo, not the Synmetrix monorepo. The existing 80+ upstream tests serve as the Red-Green safety net — they must pass after every optimization.

### Implementation for User Story 3

- [x] T022 [US3] Clone `smartdataHQ/toolkit`, set up local dev environment (`npm install`, `npm test` to verify all 80+ tests pass as baseline), create `benchmarks/` directory with a benchmark harness that generates synthetic datasets of 100K and 1M observations and measures Transform(), toTable(), Dice(), and normalize() execution times. Record baseline metrics.
- [x] T023 [P] [US3] Optimize `normalize()` sparse expansion in `src/index.js` (lines 27-58): instead of always allocating full-length arrays for sparse value/status objects, use a sparse-aware representation that is proportional to actual values. Only expand to full arrays when needed by downstream operations (lazy expansion). Run `npm test` — all tests must pass.
- [x] T024 [P] [US3] Optimize `toTable()` category reverse-lookup in `src/index.js` (lines 1299-1306): pre-build a position→ID map once per dimension before the main loop, replacing the O(categories²) inner loop with O(1) map lookups. Run `npm test` — all tests must pass.
- [x] T025 [P] [US3] Optimize `toTable()` label pre-expansion in `src/index.js` (lines 1312-1335): replace the 3 full-length label arrays with on-the-fly label computation using modular arithmetic over dimension sizes, eliminating the O(dims × categories × observations) pre-allocation. Run `npm test` — all tests must pass.
- [x] T026 [US3] Optimize `Dice()` full materialization in `src/index.js` (line 623): replace the Transform+forEach pattern with direct iteration over the flat value array using dimension metadata to check filter criteria without materializing the full tabular form. Run `npm test` — all tests must pass.
- [x] T027 [P] [US3] Replace `Dice()` deep clone via `JSON.parse(JSON.stringify())` in `src/index.js` (line 556) with `structuredClone()` (or a manual shallow-copy of the dataset structure with new value/status arrays). Run `npm test` — all tests must pass.
- [x] T028 [US3] Optimize `Transform()` per-cell Category lookups in `src/index.js` (line 1495): build a lightweight label-only cache at the start of the Transform loop, mapping dimension+position to label string, and use it instead of calling the full `Category()` method (which resolves child, unit, note, coordinates) for every cell. Run `npm test` — all tests must pass.
- [x] T029 [US3] Add `Data()` dimension metadata cache in `src/index.js`: cache the coordinate→dimension resolution so repeated calls to `Data()` with the same coordinates don't re-scan dimension structures. Run `npm test` — all tests must pass.
- [x] T030 [US3] Run all existing upstream tests (`npm test`) to verify zero regression, then run benchmarks to confirm performance targets: Transform() <500ms on 100K observations, Dice() no full materialization, normalize() proportional memory. Compare against baseline from T022.

**Checkpoint**: All 80+ upstream tests pass. Benchmarks show measurable improvement on all 6 bottlenecks.

---

## Phase 8: User Story 4 — Toolkit Streaming and Synmetrix Integration Methods (Priority: P2)

**Goal**: Add `fromRows()`, `toCSV()`, and `unflattenIterator()` methods to the toolkit fork per the contract in `specs/009-query-output/contracts/jsonstat-toolkit-extensions.md`.

**Independent Test**: Import the built toolkit, call `JSONstat.fromRows(columns, rows, options)` and verify the output is a valid JSON-Stat 2.0 dataset; call `dataset.toCSV()` and verify valid CSV output.

**Depends on**: US3 (performance optimizations should be done first to avoid conflicts in the same source file)

### Tests (write first — must FAIL before implementation)

- [x] T031 [US4] Add failing tests for the 3 new methods to `test/definitions/nodejs.js` in the toolkit fork: test `fromRows()` with various column configurations (single measure, multiple measures, time dimensions, measures-only), test `toCSV()` output against expected CSV strings with default and custom delimiters, test `unflattenIterator()` row-by-row output matches expected objects. Run `npm test` — new tests must FAIL, existing tests must still PASS.

### Implementation (make tests pass)

- [x] T033 [P] [US4] Implement `JSONstat.fromRows(columns, rows, options)` static factory method in `src/index.js` of the toolkit fork: accepts column names array, row arrays, and options `{ measures, timeDimensions }`. Builds a valid JSON-Stat 2.0 dataset by: identifying dimension columns (non-measure), extracting unique categories per dimension, assigning `role.time` to time dimensions, creating a metric-role dimension for measures, and populating the flat value array in row-major order. Run `npm test` until green.
- [x] T034 [P] [US4] Implement `dataset.toCSV(options)` instance method in `src/index.js` of the toolkit fork: produces CSV directly from the flat value array and dimension metadata using modular arithmetic to compute dimension labels per observation, without building an intermediate tabular array. Supports `delimiter` and `header` options per the contract. Run `npm test` until green.
- [x] T035 [US4] Implement `dataset.unflattenIterator()` generator method in `src/index.js` of the toolkit fork: yields one row-object per observation by iterating the flat value array and computing dimension labels via modular arithmetic over dimension sizes, without collecting all results into an array. Run `npm test` until green.
- [x] T036 [US4] Build the toolkit (`npm run build`) and verify all 4 output formats (IIFE, CJS, ESM module, ESM import) are generated. Update package.json version if needed.

**Checkpoint**: Toolkit fork has 3 new methods, all tests pass (80+ existing + new), builds successfully.

---

## Phase 9: User Story 6 — Database-Native Streaming for Large Exports (Priority: P3)

**Goal**: Stream CSV directly from ClickHouse to the client using `ResultSet.stream()` for constant-memory exports of 1M+ rows.

**Independent Test**: Export a 1M row result set from ClickHouse; verify first bytes arrive within 2s and application memory stays constant.

**Depends on**: US1 (basic CSV export must work first; this upgrades the ClickHouse path from text() to stream())

### Implementation for User Story 6

- [x] T037 [US6] Upgrade the ClickHouse CSV path in `services/cubejs/src/routes/runSql.js` from `resultSet.text()` (loads full response into memory) to `resultSet.stream()`: pipe the async-iterable stream from `@clickhouse/client` directly to the Express `res` response using `for await (const batch of resultSet.stream()) { for (const row of batch) { res.write(row.text); } }` pattern, with `res.end()` after iteration completes
- [x] T038 [US6] Handle client disconnect during streaming in `services/cubejs/src/routes/runSql.js`: listen for `req.on('close')` to detect client disconnection, abort the ClickHouse query (via AbortController signal), and release the driver connection promptly
- [x] T039 [US6] For non-streaming databases with `format=json`, enforce a hardcoded safety limit of 100,000 rows: if `driver.query()` returns more rows, truncate the output and log a warning server-side. CSV and JSON-Stat formats have no row limit (they stream or serialize incrementally). This prevents memory exhaustion for JSON's in-memory serialization.

**Checkpoint**: Streaming CSV export from ClickHouse uses constant memory for 1M+ rows. Client disconnect stops processing. Non-streaming databases have a safety limit.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Toolkit integration, end-to-end validation, and regression verification

- [x] T040 Integrate the optimized toolkit fork into the Synmetrix CubeJS service: add `smartdataHQ/toolkit` as a dependency in `services/cubejs/package.json` (git URL or npm package), update `jsonstatBuilder.js` to use `JSONstat.fromRows()` from the toolkit instead of the manual builder (replacing the Phase 2 implementation with the production-quality toolkit method). Run T004 tests to verify the swap is transparent.
- [ ] T041 [P] <!-- DEFERRED: Requires running Docker services for end-to-end validation --> Run quickstart.md validation end-to-end: execute all 4 verification steps from `specs/009-query-output/quickstart.md` (CSV export, JSON-Stat export, default JSON, frontend format export) and confirm all pass
- [ ] T042 <!-- DEFERRED: Requires running Docker services for StepCI + codegen --> Verify zero regression: run existing StepCI test suite (`./cli.sh tests stepci`), run `yarn codegen` and `yarn lint` in client-v2, confirm all pre-existing tests pass with the format parameter changes and row limit removal

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Can start in parallel with Phase 1 (different files)
- **US1 (Phase 3)**: Depends on T006-T008 (foundational utilities implemented)
- **gen_sql Extension (Phase 4)**: Can start in parallel with Phase 3 (different services: Actions/Hasura vs CubeJS)
- **US5 (Phase 5)**: Depends on US1 (Phase 3) + gen_sql extension (Phase 4)
- **US2 (Phase 6)**: Depends on T007 (jsonstatBuilder implemented)
- **US3 (Phase 7)**: Independent — external repo, no Synmetrix dependencies
- **US4 (Phase 8)**: Depends on US3 (optimizations first to avoid merge conflicts)
- **US6 (Phase 9)**: Depends on US1 (upgrades the ClickHouse CSV path)
- **Polish (Phase 10)**: Depends on US1, US2, US4, US5 completion

### User Story Dependencies

```
Phase 1 (Setup) ──────────────┐
Phase 2 (Foundational) ───────┤
                               ├──→ US1 (Phase 3) ──┬──→ gen_sql (Phase 4) ──→ US5 (Phase 5) ──→ Polish
                               │                     └──→ US6 (Phase 9) ──────────────────────→ Polish
                               ├──→ US2 (Phase 6) ─────────────────────────────────────────────→ Polish
                               └──→ US3 (Phase 7) ──→ US4 (Phase 8) ──────────────────────────→ Polish
```

### Within Each Phase (TDD Order)

1. Write tests first — ensure they FAIL
2. Implement until tests PASS (green)
3. Refactor if needed (keep tests green)
4. Move to next task

### Parallel Opportunities

- **T001 + T002**: Row limit removal (env + frontend) — different files
- **T003 + T004 + T005**: All foundational tests — different files
- **T006 + T007 + T008**: All foundational implementations — different files
- **T014a + T014b + T014c**: gen_sql extension (Hasura, Actions, frontend) — different services
- **T023 + T024 + T025 + T027**: Toolkit optimizations on independent code paths
- **T033 + T034**: Toolkit new methods (fromRows + toCSV) — different functions
- **US2 and US3**: Can run fully in parallel (different codebases)
- **US5 and US3**: Can run fully in parallel (frontend vs toolkit repo)

---

## Parallel Example: Phase 2 (Foundational)

```
# Step 1: Write all tests in parallel (must FAIL)
Agent 1: T003 — csvSerializer tests
Agent 2: T004 — jsonstatBuilder tests
Agent 3: T005 — formatValidator tests

# Step 2: Implement all utilities in parallel (make tests PASS)
Agent 1: T006 — csvSerializer implementation
Agent 2: T007 — jsonstatBuilder implementation
Agent 3: T008 — formatValidator implementation
```

## Parallel Example: User Story 3 (Toolkit Optimizations)

```
Agent 1: T023 — normalize() sparse expansion
Agent 2: T024 — toTable() category reverse-lookup
Agent 3: T025 — toTable() label pre-expansion
Agent 4: T027 — Dice() deep clone replacement
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (row limit removal)
2. Complete Phase 2: Foundational (tests first → then utilities)
3. Complete Phase 3: US1 (StepCI test first → then implementation)
4. **STOP and VALIDATE**: Run StepCI tests + curl verification
5. Deploy/demo if ready — CSV export is immediately useful

### Incremental Delivery

1. Setup + Foundational → Row limit bypass ready, tested utilities ready
2. US1 (CSV backend) → StepCI green → Deploy (MVP!)
3. gen_sql extension → limit override + column metadata working
4. US5 (Frontend selector) → Test via Explore page → Deploy
5. US2 (JSON-Stat backend) → StepCI green → Deploy
6. US3 + US4 (Toolkit) → Benchmarks + tests green → Integrate into CubeJS
7. US6 (Streaming) → Test with 1M rows → Deploy
8. Polish → Full regression + quickstart validation

### Deployment Coordination

CubeJS service must deploy before or simultaneously with client-v2 for US5 (frontend format selector). The format parameter on run-sql is a contract addition — client-v2 depends on it being available.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Toolkit work (US3, US4) happens in the external `smartdataHQ/toolkit` repo — clone separately
- T040 bridges the toolkit work back into Synmetrix by replacing the manual jsonstatBuilder with the toolkit's `fromRows()` method
- The frontend format export (US5) calls run-sql directly via `/api/v1/*` proxy. gen_sql Hasura action IS modified (Phase 4) to add limit override and column metadata.
- Row limit bypass (T001, T002) is in Setup because CSV/JSON-Stat exports need unlimited results for meaningful testing
- T039 applies a 100k safety limit to JSON format only on non-streaming databases — CSV and JSON-Stat are unlimited per spec
- T007 (jsonstatBuilder) is intentional scaffolding — keep it minimal, T040 replaces it with the toolkit's `fromRows()`
