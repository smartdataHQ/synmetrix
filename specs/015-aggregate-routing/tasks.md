---
description: "Task list for 015-aggregate-routing"
---

# Tasks: Aggregate-Aware Query Routing

**Input**: Design documents from `/specs/015-aggregate-routing/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: required. The constitution (III) makes test-first non-negotiable, so every implementation task is preceded by a failing test.

**Organization**: tasks are grouped by user story. Each task names the requirement it serves; nothing here implements an item listed under Out of Scope in the spec.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 to US5 from spec.md
- **(cross-repo)**: the file is in the separate `../fraios` repository

## Path Conventions

- Service code: `services/cubejs/src/utils/aggregates/`
- Unit tests: `services/cubejs/src/utils/aggregates/__tests__/` (run by `yarn test`)
- Engine tests: `services/cubejs/test/aggregates/` (run by `yarn test:aggregates`, need the disposable ClickHouse). `equivalence.test.js` there is the equivalence suite of SC-001.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: directories, the disposable database for engine tests, the off-by-default switch.

- [X] T001 Create `services/cubejs/src/utils/aggregates/__tests__/fixtures/` and `services/cubejs/test/aggregates/fixtures/` (empty `.gitkeep` files) per the structure in plan.md
- [X] T002 [P] Add `services/cubejs/test/aggregates/docker-compose.clickhouse.yml` (single-node ClickHouse 26.8, HTTP port bound to localhost only, no persistent volume) and a `test:aggregates` script in `services/cubejs/package.json` running `node --experimental-test-module-mocks --test 'test/aggregates/*.test.js'`
- [X] T003 [P] Add `AGGREGATE_ROUTING_ENABLED=false` with a one-line comment to `.env.example` (tracked) and the local, untracked `.env` (FR-027)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the column contract, expression classification, the catalog, and the engine test harness. Every user story uses all four.

**⚠️ CRITICAL**: no user story work starts before this phase is complete.

- [X] T004 [P] Write failing tests in `services/cubejs/src/utils/aggregates/__tests__/contract.test.js`: binding accepts exactly `aggregate_of`, `time_column`, `grain`, `min_age`, `min_window`, `max_staleness` and rejects anything else; the four intervals parse as `"<n> <unit>"` with units second/minute/hour/day; grain must divide 86,400 s; `min_age` may be zero and `max_staleness` may not; role table from data-model.md (time bucket, grouping column, sum, `__count`, `__min`, `__max`, `_rows`, per-key sum map with `String` key and non-nullable value, unusable); a plain column outside the sorting key, a suffixed column without its sum column, and a non-sum, non-grouping column under a bare source name are each unusable and do not reject the aggregate; the fill `SELECT` qualifies every source column with `src.`, buckets the time column with the grain, takes a partition id, contains no `FINAL`, and lists output columns in a stable order for inserting by name (FR-002, FR-003, FR-004, FR-020)
- [X] T005 Implement `services/cubejs/src/utils/aggregates/contract.js`: `parseBinding`, `parseInterval`, `classifyColumns`, `structureFingerprint`, suffix constants, and `fillSelect(structure, partitionId)` (the one fill builder, used by refresh, generation and the test harness); make T004 pass
- [X] T006 [P] Capture `EXPLAIN AST` output from the disposable ClickHouse for the expression cases in plan.md §3 (plain column, product of summed and grouping columns, division, casts, `if`/`multiIf`, `ifNull`, `transform`, map element, two summed columns multiplied, comparison on a summed column) into `services/cubejs/src/utils/aggregates/__tests__/fixtures/ast/*.txt`; also run one `EXPLAIN AST` through the read-only tenant account on dev and note the result in `specs/015-aggregate-routing/research.md` under "To verify during implementation" item 2. If it is refused, stop and revisit decision D5
- [X] T007 Write failing tests in `services/cubejs/src/utils/aggregates/__tests__/expressions.test.js` using the T006 fixtures: tree parsing; classes K, S, X for every rule in plan.md §3, including `arrayElement(summed map, K)` → S and any read of the time column → X; cube member SQL resolution (`{CUBE}.col`, references to other dimensions resolved recursively, `FILTER_PARAMS`/`SECURITY_CONTEXT`/other-cube references → X); one batched statement per cube (FR-008, FR-009, FR-012)
- [X] T008 Implement `services/cubejs/src/utils/aggregates/expressions.js`: `parseAst`, `classify`, `memberExpression`, `classifyBatch(queryFn, expressions, columnClasses)`; make T007 pass
- [X] T009 [P] Write failing tests in `services/cubejs/src/utils/aggregates/__tests__/catalog.test.js` with an injected query function: an aggregate is rejected with the reasons of data-model.md (`invalid_binding`, `source_missing`, `time_column_missing`, `partition_key_mismatch`) and for nothing else; the verified time and coverage boundary are read from `<db>.aggregate_state`, and age is computed from the server's `now()` plus elapsed process time; a missing state table or record → the aggregate is accepted and unverified; 60 s lifetime with stale-while-revalidate (a lookup never awaits a probe; an unloaded catalog returns nothing); at most four probe statements per refresh; cleared comment → aggregate gone after one lifetime; changed columns → new structure fingerprint; non-ClickHouse data source → empty; probe error → empty catalog, no throw; identifiers validated before use in statements (FR-001, FR-005, FR-023, FR-027, FR-029)
- [X] T010 Implement `services/cubejs/src/utils/aggregates/catalog.js`: `createCatalog({ driverFor, ttlMs, now })` with `lookup(securityContext)`; make T009 pass
- [X] T011 Add the engine test harness `services/cubejs/test/aggregates/harness.js` (connect to the disposable ClickHouse; create a source and aggregates from fixture SQL; build one partition with `contract.fillSelect` into a staging table, swap it in and record its fingerprint; write an aggregate-level refresh record; generate SQL through Cube for a canonical cube and a derived cube; run both; compare with NULL = NULL, not-a-number = not-a-number, relative tolerance 1e-9) and the fixture `services/cubejs/test/aggregates/fixtures/sales_like.sql` (a replacing source shaped like the first candidate with several monthly partitions, the newest holding unmerged duplicates; a one-day aggregate that follows contracts/aggregate-contract.md; `aggregate_state`)

**Checkpoint**: contract, classification and catalog are unit-tested; the harness can run a statement on both tables and compare.

---

## Phase 3: User Story 1 - A dashboard query is answered from an aggregate, silently and exactly (Priority: P1) 🎯 MVP

**Goal**: a suitable query over periods the aggregate holds reads the aggregate and returns the same rows, member names and output columns; metadata is unchanged.

**Independent Test**: with one verified aggregate that holds the queried periods, the reference query set returns identical rows and columns on both paths, and the model list is unchanged.

### Tests for User Story 1 (write first, must fail)

- [X] T012 [P] [US1] Write failing tests in `services/cubejs/src/utils/aggregates/__tests__/derive.test.js`: an eligible YAML cube (`SELECT *` with `REPLACE`, `WHERE`, `SETTINGS`; and `sql_table`) yields a derived cube with the same cube and member names and the source table replaced by the aggregate table only; its `WHERE` predicate and `SETTINGS` are kept verbatim (FR-017); a `REPLACE` item whose target the aggregate lacks is removed; items of class K or S are kept; measure table from plan.md §4 (`sum` unchanged, `count` → `sum(_rows)` or `sumIf(_rows, filters)`, `avg` → sum over count, map-key `avg` → sum over `_rows`, `min`/`max` from stored fields, `count_distinct` over grouping columns unchanged, `number` over derived measures); titles, formats and meta copied; joins dropped; variant key is stable and changes with schema version, aggregate, or structure fingerprint (FR-007 to FR-010, FR-015 to FR-017, FR-021)
- [X] T013 [P] [US1] Write failing tests in `services/cubejs/src/utils/aggregates/__tests__/suitability.test.js` for qualifying requests: every member available; UTC; granularity a whole multiple of the grain (day, week, month, quarter, year on a one-day grain); whole-day range; a relative range already resolved; an `inDateRange` filter on the time dimension; the window rule of FR-021 (a window that ends before the coverage boundary; a window that reaches past it and is at least `min_window` long; a query with no time range at all); several queries in one request that all qualify for the same aggregate; verified within `max_staleness` → chosen (FR-007, FR-011, FR-014, FR-021, FR-023)
- [X] T014 [P] [US1] Write failing tests in `services/cubejs/src/utils/aggregates/__tests__/routing.test.js` with a fake gateway: the wrapper returns the gateway's result unchanged; a suitable request replaces `context.securityContext` with a copy carrying `userScope.dataSource.aggregateVariant` and leaves the original object untouched; `aggregateAppIdSuffix(context)` returns `_AGG_<key>` for a marked context and an empty string otherwise; the variant-file map holds at most 200 variants and evicts the least recently used; the decision log line carries request id, cube and aggregate, and no query values; the installed Cube gateway exposes `getNormalizedQueries` (guard for upgrades) (FR-006, FR-015, FR-028)
- [X] T015 [P] [US1] Write failing tests in `services/cubejs/src/utils/__tests__/repositoryFactoryAggregates.test.js`: a context carrying a known variant key gets the derived files; an unknown key gets the canonical files; an unmarked context is unchanged (FR-016, FR-029)
- [X] T016 [US1] Write failing engine tests in `services/cubejs/test/aggregates/equivalence.test.js` on the `sales_like` fixture, over windows the aggregate holds: month by sum over whole days; day by dimension by sum with a filter; totals; a dimension value list with a date range inside the held partitions; average, minimum, maximum and count of a stored metric; a filtered count that matches nothing returns 0; a product of one summed column and a grouping column; every case returns identical rows and identical output column names and order (US1 scenarios 1 to 4 and 6, SC-001, SC-003)
- [X] T017 [US1] Write failing engine tests in `services/cubejs/test/aggregates/gateway.test.js` with a real Cube gateway, the real wrapper and `repositoryFactory`, and a stubbed schema loader: `sql` for a suitable query reads the aggregate table and no other, and a `dryRun` (which returns no statement text) succeeds on the variant; so does the statement from `getNormalizedQueries` followed by `getSqlQueriesInternal`, the path that `load`, streaming and the export route use; a compare-date-range request whose two ranges qualify for one aggregate routes both; `meta` lists exactly the canonical cubes and members before and after a routed query (US1 scenario 5, FR-016, FR-018, FR-021)

### Implementation for User Story 1

- [X] T018 [US1] Implement `services/cubejs/src/utils/aggregates/derive.js`: `deriveCube(cubeYaml, structure, classifyBatch, schemaVersion)` returning `DerivedCube` (data-model.md); make T012 pass
- [X] T019 [US1] Implement `services/cubejs/src/utils/aggregates/suitability.js`: `decide(queries, derivedByAggregate, catalogEntry, clock)` covering member availability, the time checks of FR-011, the window rule of FR-021 and the refresh-record check of FR-023; choose the first aggregate that qualifies for every query of the request (ordering comes in US3); make T013 pass
- [X] T020 [US1] Implement `services/cubejs/src/utils/aggregates/routing.js`: `installAggregateRouting(cubejs, deps)` wrapping `apiGateway.getNormalizedQueries`; load the cube's YAML from the tenant's schema files with `findDataSchemasByIds` (ids and checksums from the security context), parsed once per schema version; the bounded variant-file map; `aggregateAppIdSuffix`; `derivedFilesFor(context)`; the decision log; make T014 pass
- [X] T021 [US1] Serve derived files in `services/cubejs/src/utils/repositoryFactory.js` for a marked context, falling back to the canonical files; make T015 pass
- [X] T022 [US1] Wire `services/cubejs/index.js`: append `aggregateAppIdSuffix(context)` in `contextToAppId` only (not in `contextToOrchestratorId`), and call `installAggregateRouting(cubejs)` after `cubejs.initApp(app)` when `AGGREGATE_ROUTING_ENABLED` is `true`; make T016 and T017 pass

**Checkpoint**: a suitable query over held periods is answered from the aggregate with identical output; metadata is unchanged.

---

## Phase 4: User Story 2 - Anything the aggregate cannot answer stays on the source (Priority: P1)

**Goal**: every query that is not provably exact, or that is a short window reaching the present, runs on the source exactly as today, with a recorded reason. Ship together with US1.

**Independent Test**: the unsuitable-query corpus produces the same statements as with the feature off, each with a specific reason code.

### Tests for User Story 2 (write first, must fail)

- [X] T023 [P] [US2] Extend `services/cubejs/src/utils/aggregates/__tests__/derive.test.js` with ineligible cubes and unsafe members, asserting `cube_not_eligible` and `member_unavailable` with the detail codes of data-model.md: JavaScript model → `not_yaml`; `extends`; declared `pre_aggregations`; `FINAL`, join, union, nested read, grouping in cube SQL, explicit column list → `not_plain_read`; a `WHERE` that reads a non-grouping column → `predicate_not_grouping`; a missing column → `column_not_in_aggregate`; a dimension or measure filter on a summed column → `not_grouping_column`; product of two summed columns → `not_exact_when_summed`; average, minimum or maximum without its stored field → `no_stored_field`; time column inside a measure → `reads_time_column`; rolling-window, multi-stage and sub-query members → `unsupported_member`; a calculation over an unavailable measure → `depends_on_unavailable_member` (FR-009, FR-010, FR-012)
- [X] T024 [P] [US2] Extend `services/cubejs/src/utils/aggregates/__tests__/suitability.test.js` with the reason-code table from data-model.md: catalog not loaded → `no_catalog`; no accepted aggregate for the cube's source → `no_aggregate`; hourly bucket on a one-day grain → `granularity`; custom granularity → `granularity`; range starting mid-bucket → `range_not_aligned`; time zone other than UTC → `timezone`; a date operator other than a range on the time dimension → `time_filter`; a window that reaches past the coverage boundary and is one bucket shorter than `min_window` → `window_too_short`, while one exactly `min_window` long qualifies; no refresh record → `not_verified`; last pass older than `max_staleness` → `stale`; a query reading two cubes → `multi_cube`; member expression, ungrouped, sub-query join → `unsupported_query`; missing member → `member_unavailable` with the member and its detail code; a request whose queries do not all qualify for one aggregate (one unsuitable, or different cubes) → `request_mixed` for the request (FR-011, FR-013, FR-014, FR-021, FR-023, FR-028)
- [X] T025 [P] [US2] Extend `services/cubejs/src/utils/aggregates/__tests__/routing.test.js`: an exception thrown by the catalog, derivation or decision returns the gateway's original result with no marker and logs reason `error`; a second call on the same context object recomputes and removes a marker left by an earlier call; a request with nothing routed still logs one decision line with its reason (FR-028, FR-029)
- [X] T026 [US2] Extend `services/cubejs/test/aggregates/gateway.test.js`: for each unsuitable case the generated statement is byte-identical to the one generated with the wrapper not installed; a multi-query request with one unsuitable query routes none; a query whose rewritten form carries a row-rule filter on the tenant column is routed and its statement contains that filter, and a query whose rule filter reads a column the aggregate lacks stays on the source; with `AGGREGATE_ROUTING_ENABLED` unset no probe statement is issued (US2 scenarios 1 to 10, FR-006, FR-017, FR-027, SC-004, SC-008)
- [X] T027 [P] [US2] Add the StepCI workflow `tests/workflows/aggregate-routing/off-by-default.yml`: with the switch off, `/api/v1/meta` lists the same cubes as before, `/api/v1/sql` for a reference query names the source table, and `/api/v1/load` responses carry no `x-synmetrix-aggregate-covered-until` header (FR-027, FR-030, SC-004)

### Implementation for User Story 2

- [X] T028 [US2] Complete eligibility and left-out detail codes in `services/cubejs/src/utils/aggregates/derive.js`; make T023 pass
- [X] T029 [US2] Complete the rejection rules, reason codes and the one-aggregate-per-request rule in `services/cubejs/src/utils/aggregates/suitability.js`; make T024 pass
- [X] T030 [US2] Complete the fail-safe path and decision logging in `services/cubejs/src/utils/aggregates/routing.js`; make T025 and T026 pass

**Checkpoint**: US1 and US2 together are the shippable minimum: exact over held periods, unchanged otherwise.

---

## Phase 5: User Story 3 - The best available aggregate is used (Priority: P2)

**Goal**: with several aggregates of one source, the coarsest qualifying one answers.

**Independent Test**: with 30-minute and one-day aggregates, hour, day, week, month, minute and off-boundary queries read the expected table and equal the source.

### Tests for User Story 3 (write first, must fail)

- [X] T031 [P] [US3] Add a 30-minute aggregate of the same source as its own fixture, `services/cubejs/test/aggregates/fixtures/sales_like_30minute.sql`, so that tests with one grain are unaffected
- [X] T032 [P] [US3] Extend `services/cubejs/src/utils/aggregates/__tests__/suitability.test.js`: among aggregates that qualify for every query of the request the coarsest grain wins; equal grains → fewest rows; an hourly bucket qualifies on a 30-minute grain and not on a 45-minute grain; a range starting at 10:30 qualifies on 30 minutes and not on one day; a range starting at 10:15 qualifies on neither; a two-range request where one range needs the 30-minute grain uses the 30-minute aggregate for both (FR-011, FR-014, FR-019)
- [X] T033 [US3] Extend `services/cubejs/test/aggregates/equivalence.test.js`: hour over whole days → 30-minute table; day, week, month → one-day table; range 10:30 to 10:30 → 30-minute table; minute bucket and a 10:15 start → source; every routed case equals the source (US3 scenarios 1 to 4)

### Implementation for User Story 3

- [X] T034 [US3] Order the aggregates that qualify for every query by grain, then row count, in `services/cubejs/src/utils/aggregates/suitability.js`; make T032 and T033 pass

**Checkpoint**: several grains can coexist; each request uses the smallest table that is exact.

---

## Phase 6: User Story 4 - Long windows use the aggregate; history is exact, the newest data may be behind (Priority: P2)

**Goal**: a refresh pass builds and rebuilds aggregate partitions from plain reads and records what the aggregate holds; a long window that reaches the present is answered from the aggregate alone; without a recent pass, routing stops by itself. (The window rule and the checks that read the refresh record were built in US1 and US2; this story adds the process that writes the record and proves long and short windows end to end.)

**Independent Test**: build an aggregate for the old partitions of a source. A window within them equals the source. A long window reaching now equals the source for every bucket the aggregate holds. A short window reaching now reads the source. After rows are loaded into an old partition and the refresh runs, it again equals the source. A routed answer carries the coverage time in a response header; an unrouted one does not.

### Tests for User Story 4 (write first, must fail)

- [X] T035 [P] [US4] Write failing tests in `services/cubejs/src/utils/aggregates/__tests__/refresh.test.js` with an injected query function: fingerprints from active part names; a source partition belongs in the aggregate only when its newest time-column value is older than the pass start minus `min_age`, and with `min_age` zero every partition belongs; a belonging partition is built when the aggregate lacks it or its recorded fingerprint differs, whatever its number of parts; the staging fill uses `contract.fillSelect` over a plain read of that partition, with no `FINAL`, and inserts by column name; each built partition is swapped with one `REPLACE PARTITION` statement (the one-step replacement of US4 scenario 5); the fingerprint recorded is the one read before the build; an aggregate partition whose source partition is gone or no longer belongs is dropped and recorded with fingerprint 0; after a pass with no failure the aggregate-level record holds the pass start as verified time and the coverage boundary (the oldest time-column value among source partitions not held, or the pass start when all are held); a failed step records neither; the staging table is dropped after success and after failure; one aggregate's failure does not stop the others (FR-020, FR-022, FR-023)
- [X] T036 [P] [US4] Write failing tests in `services/cubejs/src/utils/aggregates/__tests__/aggregatesCli.test.js` for the `refresh` command: `--only` limits the pass; exit code 0 when all aggregates were verified, 3 when any failed, 1 on a connection error; one log line per aggregate without row values (contracts/aggregates-cli.md)
- [X] T037 [US4] Write failing engine tests in `services/cubejs/test/aggregates/refresh.test.js` on the `sales_like` fixture with `min_age` set so that the newest partition does not belong: a first pass builds every old partition, whatever its number of parts, and records the verified time and coverage boundary; a window inside the held partitions equals the source; a long window reaching now is answered from the aggregate table alone and equals the source for every bucket before the coverage boundary; a short window reaching now reads the source; after duplicate rows are loaded into an old partition and merged away by the database, the next pass rebuilds only that partition (the others keep their parts) and it equals the source again; with the aggregate-level record removed the decision is `not_verified`, and with it older than `max_staleness` it is `stale` (US4 scenarios 1 to 6, SC-006)
- [X] T038 [P] [US4] Extend `services/cubejs/src/utils/aggregates/__tests__/routing.test.js` for the answer mark: a routed request sets `context.aggregateRouting` to the chosen aggregate and its coverage boundary; an unrouted request, a failed decision, and a second call that no longer qualifies leave it unset (FR-030)
- [X] T039 [US4] Extend `services/cubejs/test/aggregates/gateway.test.js` with an HTTP check on the real `/api/v1/load` route and the export route: a routed 2xx response carries `x-synmetrix-aggregate-covered-until` with the aggregate's coverage boundary in ISO-8601 UTC and its body equals the body without the header hook; an unrouted response, an error response, and any response with the switch off carry no such header (US4 scenario 7, FR-030, SC-009)

### Implementation for User Story 4

- [X] T040 [US4] Implement `services/cubejs/src/utils/aggregates/refresh.js`: `refreshAggregate(queryFn, structure)` and `refreshAll(queryFn, { only })`; make T035 pass
- [X] T041 [US4] Implement the `refresh` command in `services/cubejs/scripts/aggregates.mjs` (connection from `AGGREGATES_CLICKHOUSE_URL`, `AGGREGATES_CLICKHOUSE_USER`, `AGGREGATES_CLICKHOUSE_PASSWORD` through the existing ClickHouse driver); make T036 and T037 pass
- [X] T042 [US4] Add the answer mark: set `context.aggregateRouting` in `services/cubejs/src/utils/aggregates/routing.js`, add `x-synmetrix-aggregate-covered-until` in the existing response-header hook of `services/cubejs/src/routes/index.js` when `req.context.aggregateRouting` is set, and document the header in `services/cubejs/src/swagger.yaml`; make T038 and T039 pass
- [X] T043 [P] [US4] (cross-repo) Add `../fraios/shared/schemas/clickhouse/aggregate_state.sql`: the refresh-record table from data-model.md for the `cst` database, replicated, `ON CLUSTER fraios` — written, uncommitted in `../fraios`
- [X] T044 [P] [US4] (cross-repo) Define the refresh account in `../fraios/infra/k8s/data/clickhouse/base/` following the existing user and secret manifests there: an account that may read sources and system tables, create and drop the staging table, alter aggregate partitions and insert into `aggregate_state` in `cst`, and nothing else; its password in a dedicated secret — written as `aggregate-refresh-user.yaml` (same pattern as `sandbox-user.yaml`), uncommitted in `../fraios`
- [X] T045 [US4] (cross-repo) Add `../fraios/infra/k8s/data/clickhouse/base/aggregate-refresh-cronjob.yaml` and list it in that directory's `kustomization.yaml`: runs `node scripts/aggregates.mjs refresh` from the cubejs image with the T044 secret, concurrent runs forbidden, schedule shorter than the smallest `max_staleness` in use — written, uncommitted in `../fraios`; listed in `kustomization.yaml` as a commented entry, to be enabled by the owner once the tables exist and the image carries the script
- [X] T046 [US4] (cross-repo) Make old partitions of the first candidate consolidate by themselves: `min_age_to_force_merge_seconds = 604800` and `min_age_to_force_merge_on_partition_only = 1` on `cst.sales_lines`. Applied on the dev cluster on 2026-11-20 at the owner's request and written into `../fraios/shared/schemas/clickhouse/sales_lines.sql` (that file change is not yet committed)

**Checkpoint**: aggregates follow their source; history is exact, long windows are fast, short current windows stay live, and a stopped job cannot keep an old aggregate in use.

---

## Phase 7: User Story 5 - An operator generates an aggregate for any time-series table (Priority: P2)

**Goal**: one command turns a source table, a grain, a grouping set and the three time settings into a contract-conformant definition, as text.

**Independent Test**: aggregates generated for three structurally different tables, applied and filled in the disposable ClickHouse, match the source on every stored metric, also after merging parts.

### Tests for User Story 5 (write first, must fail)

- [X] T047 [P] [US5] Add `services/cubejs/test/aggregates/fixtures/generator_sources.sql`: three synthetic source tables whose column types, keys and partitioning follow three real tables of different shape (a wide sales table, a narrow series table built on maps, a very wide event table built on arrays), as plain `MergeTree` without row expiry so the test source cannot change under the test. The real definitions are not stored here: this repository is public
- [X] T048 [P] [US5] Write failing tests in `services/cubejs/src/utils/aggregates/__tests__/generator.test.js` with ClickHouse's recorded answers for the T047 tables: column assignment table from contracts/aggregates-cli.md; every left-out column has a reason; the definition has the six-field binding comment, every grouping column in the sorting key, exactly the source's partition expression, `allow_nullable_key` when a grouping column is nullable, `ON CLUSTER` when requested; types are taken from `DESCRIBE` of `contract.fillSelect`; the forced-merge statement is printed when the source engine is not plain `MergeTree` and the setting is off, and not otherwise; declines with a reason for a missing table or column, a non-date-time time column, a partition expression that does not involve the time column, a grain that does not divide a day or does not nest in the partition expression, and a grouping column of map, array, nested or JSON type (FR-024, FR-025, FR-026)
- [X] T049 [P] [US5] Extend `services/cubejs/src/utils/aggregates/__tests__/aggregatesCli.test.js` for the `generate` command: required options including `--min-age`, `--min-window` and `--max-staleness`; output order (definition, left-out list, forced-merge statement when applicable); exit code 0, 2 when declined with the reason on standard error, 1 on a connection error; no statement that changes data is issued (FR-024)
- [X] T050 [US5] Write failing engine tests in `services/cubejs/test/aggregates/generator.test.js`: for each T047 schema, create the source, insert synthetic rows, generate, apply, fill with the harness in two inserts, then compare sum, average, minimum, maximum and count of every stored metric and per-key sums of every stored map at a coarser grouping, before and after merging parts; the generated table is accepted by the catalog rules and `contract.classifyColumns` reports no unusable column (US5 scenarios 1 to 5, SC-007)

### Implementation for User Story 5

- [X] T051 [US5] Implement `services/cubejs/src/utils/aggregates/generator.js`: `generate(queryFn, { source, timeColumn, grain, groupBy, minAge, minWindow, maxStaleness, cluster })` returning the definition, the left-out list and the forced-merge statement when applicable, or a decline reason; make T048 pass
- [X] T052 [US5] Implement the `generate` command in `services/cubejs/scripts/aggregates.mjs`; make T049 and T050 pass
- [X] T053 [US5] (cross-repo) Generate the first candidate with the options in quickstart.md and add it as `../fraios/shared/schemas/clickhouse/sales_lines__agg_1day.sql` — generated from the live table on dev (read-only) on 2026-11-20; uncommitted in `../fraios`

**Checkpoint**: an aggregate for a new table is produced by one command and passes the equivalence check.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T054 [P] Add a timing test to `services/cubejs/src/utils/aggregates/__tests__/suitability.test.js`: 1,000 decisions against a warm catalog with the first candidate's member count finish with a 95th percentile under 5 ms (SC-005)
- [X] T055 [P] Document the feature in `CLAUDE.md`: the `services/cubejs/src/utils/aggregates/` modules and `scripts/aggregates.mjs` under Key File Locations, and `AGGREGATE_ROUTING_ENABLED` under Environment Configuration
- [ ] T056 Run `yarn test` and `yarn test:aggregates` in `services/cubejs` on the pinned Cube version and `./cli.sh tests stepci`; all green — partly done on 2026-11-20: the aggregate unit tests (158) and the engine suite (53) are green on Cube 1.7.30 (installed locally) and on 1.8.16 (the pinned version, through a resolver shim); the service's full unit suite shows only failures that exist without this feature (drivers and dependency checks that need the 1.8.16 install); StepCI has not been run, because the local stack is off
- [ ] T057 Follow `specs/015-aggregate-routing/quickstart.md` on dev and record in `specs/015-aggregate-routing/research.md` ("To verify during implementation"): the wrapper on Cube 1.8.16 at runtime, the answer mark on a routed and an unrouted `/api/v1/load` response, the replicated definition and `REPLACE PARTITION` on three replicas, and the two SC-002 measurements (time for revenue by month over one year; rows read for the store-name list) routed and unrouted

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: needs Setup. Blocks every story.
- **US1 (Phase 3)**: needs Foundational.
- **US2 (Phase 4)**: needs US1 (same modules; completes their rejection paths). US1 must not be released without US2.
- **US3 (Phase 5)**: needs US1 and US2.
- **US4 (Phase 6)**: needs Foundational; T037, T038, T039 and T042 also need the decision code of US1 and US2. T045 needs T041 and T044. T046 is done.
- **US5 (Phase 7)**: needs Foundational only (contract and harness). T053 needs T052.
- **Polish (Phase 8)**: T054 needs US3; T056 needs every story in the release; T057 needs T043, T045, T053 and a deployment.

### Within Each User Story

- Tests are written first and fail before the implementation task that names them.
- `derive.js` before `suitability.js` before `routing.js` before `index.js` wiring.
- Engine tests pass last, once the modules they exercise exist.

### Parallel Opportunities

- Setup: T002, T003.
- Foundational: T004, T006, T009 (different files); T005, T008, T010 follow their tests.
- US1 tests: T012, T013, T014, T015 in parallel; T016 and T017 after T011.
- US2 tests: T023, T024, T025, T027 in parallel.
- US4 and US5 can proceed in parallel with US3 once Foundational is done (different modules: `refresh.js`, `generator.js`). `scripts/aggregates.mjs` and `aggregatesCli.test.js` are shared by US4 and US5, so T036 before T049 and T041 before T052.

---

## Parallel Example: User Story 1

```text
# After Phase 2, write the four unit-test files together:
T012 derive.test.js
T013 suitability.test.js
T014 routing.test.js
T015 repositoryFactoryAggregates.test.js

# Then implement in order: T018 -> T019 -> T020 -> T021 -> T022
```

---

## Implementation Strategy

### Minimum shippable (US1 + US2)

1. Phase 1 and Phase 2.
2. Phase 3 (US1) and Phase 4 (US2).
3. Stop and validate: equivalence suite green, off-by-default workflow green, statements for unsuitable queries byte-identical.
4. Deploy with the switch off. Nothing changes until an aggregate exists, has a refresh record, and the switch is on.

### Incremental delivery

1. US4 next: without a refresh pass no aggregate is ever filled or verified, so routing stays inert in practice.
2. US5: generate the first candidate's definition (T053), apply it, run a pass, switch routing on in dev (T057).
3. US3: add a second grain where dashboards need finer buckets.

### Notes

- Cross-repo tasks: T043, T044, T045, T046, T053: all written or applied, none committed in `../fraios`.
- Each task cites the requirement it serves; a task that needs something not in spec.md is a signal to stop and revisit the spec, not to widen the task.
