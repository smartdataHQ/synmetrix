# Implementation Plan: Aggregate-Aware Query Routing

**Branch**: `015-aggregate-routing` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/015-aggregate-routing/spec.md`

## Summary

Answer a semantic-layer query from a self-describing ClickHouse aggregate table when every member of the query is exactly reproducible from it and the query's time window either lies within what the aggregate holds or is long; otherwise run the query on the source as today. A routed query reads the aggregate alone. Consumers see the same member names and output columns, and no new model; a routed answer carries one extra response header that says through what time the aggregate holds data. Historical periods are exact; in a long window that reaches the present the newest periods may be missing or behind, which the owner accepts.

Technical approach (each part proven in a throwaway prototype, see [research.md](./research.md)):

1. **Catalog**: read-only queries per data source find aggregates by a binding comment, read their columns, and read their refresh record. Results live in a timed in-memory cache, refreshed in the background.
2. **Derivation**: for an eligible cube and one aggregate, build an in-memory variant of that cube: same cube name and member names, source table swapped inside the cube's own SQL, measures rewritten by column role. Expressions are parsed by ClickHouse (`EXPLAIN AST`) and classified as grouping-only, exact-when-summed, or unsafe. Members that are not provably exact are left out.
3. **Decision**: once per request, right after Cube finishes query rewriting, check every query against the derived member sets, the time-grain rules, the window rule and the refresh record, and pick the coarsest suitable aggregate. One aggregate must fit every query of the request.
4. **Switch**: the decision marks a copy of the request's security context; `contextToAppId` keys a per-request model variant and `repositoryFactory` serves the derived cube for it. Cube re-requests the compiler after rewriting, so SQL and annotations come from the variant while `/meta` and every other path stay canonical.
5. **Generate and refresh**: one command-line script, built on the same column-contract module, generates an aggregate definition (text only) and, run on a schedule with its own credentials, builds and rebuilds aggregate partitions from plain reads of the source and records what the aggregate holds.

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 22.x (CubeJS service)
**Primary Dependencies**: Cube.js 1.8.16, pinned exactly (`@cubejs-backend/server-core`, `api-gateway`, `schema-compiler`, `clickhouse-driver`), `yaml` ^2.3.4. All existing. **No new npm dependencies.**
**Storage**: No PostgreSQL/Hasura changes. ClickHouse 26.8: aggregate tables and one small `aggregate_state` table per database, both defined in the schema repository (`../fraios/shared/schemas/clickhouse/`). In-memory caches in the cubejs process.
**Testing**: `node:test` unit tests beside the code (`src/utils/aggregates/__tests__/`), engine tests against a disposable ClickHouse 26.8 container (`services/cubejs/test/aggregates/`, run by `yarn test:aggregates`), one StepCI workflow for off-by-default behaviour.
**Target Platform**: Linux containers (Kubernetes): query pods, plus one scheduled job for refresh.
**Project Type**: Backend service extension (single service, `services/cubejs`).
**Performance Goals**: routing decision ≤ 5 ms p95 with a warm catalog (SC-005); first derivation of a cube in one batched `EXPLAIN AST` round trip; at most 4 probe queries per data source per cache lifetime.
**Constraints**: read-only database account for Synmetrix; no duplicate-removing read (`FINAL`) in any statement; the Tesseract (Rust) planner generates SQL, so no hook may depend on JS query-class overrides; canonical compile, `/meta`, validation and the pre-aggregation refresh worker must be untouched; fail safe to the source on any error (FR-029).
**Scale/Scope**: tens of aggregates per data source; a derived variant holds one cube; first candidate 1.14 billion rows, 1 shard, 3 replicas.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Service Isolation | PASS | All platform code is in `services/cubejs`. No Hasura action, JWT claim, or client-v2 contract changes, and no new route. One additive response header on `/api/v1/load` (contracts/answer-mark.md), next to the `x-synmetrix-*` headers that route already sets; consumers that do not know it ignore it. The refresh job reuses the cubejs image with a different entry point and shares no runtime state with query pods. |
| II. Multi-Tenancy First | PASS | Datasource, branch and version resolution are unchanged and still flow through `defineUserScope.js` and `buildSecurityContext.js`. The variant key is appended to the existing app id, which already carries the datasource and schema hashes, so compiled variants are isolated per tenant and model version. The derived cube keeps the cube's own tenant predicate verbatim; a predicate that reads anything but grouping columns makes the cube ineligible. The decision runs after row rules and access lists. |
| III. Test-Driven Development | PASS | Every module task is preceded by its failing test. The equivalence suite (source vs routed, cell for cell) is written before the derivation and decision code. |
| IV. Security by Default | PASS | No new entry point. Decisions are logged without values or tenant data. The refresh job's write credentials never reach query pods. Catalog names are validated against an identifier pattern and quoted before they appear in any statement. |
| V. Simplicity / YAGNI | PASS with tracked exceptions | Five items add complexity and are justified in Complexity Tracking. Scope cuts: YAML cubes only, `SELECT *`-style and `sql_table` cubes only, single-cube queries only, UTC-bucketed queries only, no REST routes, no combining of aggregate and source in one answer. |

**Post-design re-check (after Phase 1)**: unchanged. The design added no dependency, no PostgreSQL table, and no cross-service contract.

## Project Structure

### Documentation (this feature)

```text
specs/015-aggregate-routing/
├── plan.md              # This file
├── research.md          # Phase 0: decisions, evidence, ClickHouse options, rejected alternatives
├── data-model.md        # Phase 1: binding, column roles, structures, state
├── quickstart.md        # Phase 1: try it end to end on the first candidate
├── contracts/
│   ├── aggregate-contract.md   # what an aggregate table must look like (database side)
│   ├── answer-mark.md          # the header a routed answer carries (consumer side)
│   └── aggregates-cli.md       # generate and refresh commands
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
services/cubejs/
├── index.js                          # contextToAppId variant suffix; installAggregateRouting()
├── scripts/
│   └── aggregates.mjs                # `generate` and `refresh` commands (own credentials)
├── src/routes/index.js               # one more header in the existing response-header hook
└── src/utils/
    ├── repositoryFactory.js          # serve derived files when the context carries a variant
    ├── __tests__/repositoryFactoryAggregates.test.js
    └── aggregates/
        ├── contract.js               # binding parse, column roles, suffixes, the fill SELECT
        ├── catalog.js                # probe + timed cache per data source, refresh record
        ├── expressions.js            # EXPLAIN AST parse and classification (K / S / X)
        ├── derive.js                 # canonical cube + aggregate -> derived cube + reasons
        ├── suitability.js            # per-query decision: members, time, window, best aggregate
        ├── routing.js                # per-request hook, variant marking, decision log
        ├── generator.js              # classify source columns, emit the definition
        ├── refresh.js                # changed-partition detection, build, records
        └── __tests__/                # node:test unit tests + recorded AST fixtures
services/cubejs/test/aggregates/      # engine tests, need the disposable ClickHouse
├── docker-compose.clickhouse.yml     # single-node ClickHouse 26.8
├── harness.js                        # create fixtures, run both paths, compare
├── equivalence.test.js               # source vs routed, cell for cell
├── gateway.test.js                   # real Cube gateway: routed, unrouted, mixed, metadata
├── refresh.test.js                   # build, re-load, consolidation, rebuild, window rule
├── generator.test.js                 # generated aggregates for three real schemas
└── fixtures/                         # synthetic sources, captured table descriptions
tests/workflows/aggregate-routing/
└── off-by-default.yml                # StepCI: switch off, behaviour as today

../fraios/                            # separate repository
├── shared/schemas/clickhouse/
│   ├── aggregate_state.sql           # refresh records
│   ├── sales_lines.sql               # source: settings that consolidate old partitions
│   └── sales_lines__agg_1day.sql     # first candidate, produced by `generate`
└── infra/k8s/data/clickhouse/base/
    └── aggregate-refresh-cronjob.yaml
```

**Structure Decision**: one new directory, `services/cubejs/src/utils/aggregates/`, holds the capability. `contract.js` is the single implementation of the column contract and is used by discovery, derivation, generation and refresh, so the convention cannot drift between them. Three existing source files change: `index.js` (two small hooks), `repositoryFactory.js` (one branch) and `routes/index.js` (one header in the response-header hook that is already there). `package.json` gains one test script and `.env` one variable. `queryRewrite.js` is not modified and no route is added.

## Design

### Terms

- **Partition**: a ClickHouse partition of the source table (the spec's "period"). The aggregate is partitioned by the same expression, so a source partition and its aggregate partition have the same partition id.
- **Fingerprint**: a hash over the names of a partition's active parts. Any insert, merge, mutation or expiry changes it, and a past value never recurs.
- **Held**: the aggregate has the partition, built from the source partition's content at some refresh.
- **Coverage boundary** (`covered_until`): the earliest time-column value in any source partition the aggregate does not hold; the time of the pass when it holds all. Everything before it is held.
- **Verified**: the start time of the last complete, successful refresh pass.

### 1. Column contract (database side)

Full text in [contracts/aggregate-contract.md](./contracts/aggregate-contract.md).

- **Binding** (FR-002): the aggregate's table comment is a JSON object with exactly six fields: `aggregate_of` (`db.table`), `time_column`, `grain`, `min_age`, `min_window`, `max_staleness`. The last four are `"<n> <unit>"` with unit `second|minute|hour|day`; the grain must divide one day; `min_age` may be zero. Buckets are cut in UTC.
- **Location**: same database as the source. **Partitioning**: the source's partition expression, unchanged.
- **Out of use** (FR-027): clear the table comment.
- **Roles** (FR-003, FR-004), read from `system.columns`:

| Aggregate column | Type | Role |
|---|---|---|
| the bound time column | date-time, in the sorting key | time bucket |
| any plain-typed column in the sorting key | as source | grouping column |
| `<col>` | `SimpleAggregateFunction(sum, T)` | sum of source column `<col>` |
| `<col>__count` | `SimpleAggregateFunction(sum, UInt64)` | non-null count of `<col>` |
| `<col>__min`, `<col>__max` | `SimpleAggregateFunction(min\|max, T)` | minimum, maximum |
| `_rows` | `SimpleAggregateFunction(sum, UInt64)` | source row count |
| `<map>` | `SimpleAggregateFunction(sumMap, Map(String, T))`, T not nullable | per-key sum of a numeric map |
| anything else, including a plain column outside the sorting key | | unusable |

### 2. Catalog (`catalog.js`) — FR-001, FR-005, FR-023, FR-027

- ClickHouse data sources only; any other type has an empty catalog.
- Probe, through the existing tenant driver (`tenantDriverFactory`):
  1. `system.tables` rows whose comment starts with `{"aggregate_of"`: database, name, comment, partition key, sorting key, total rows.
  2. `system.tables` for the bound source tables: existence, partition key.
  3. `system.columns` for the aggregates: name, type, `is_in_sorting_key`.
  4. `<db>.aggregate_state`: per aggregate, the last verified time and coverage boundary, together with the server's `now()`. Age is computed from the server clock at probe time and advanced with the process's monotonic clock.
- Cache key: data source version (already tenant-scoped). Lifetime 60 s, stale-while-revalidate: a query never waits for a probe; with no catalog yet, nothing is routed.
- Each aggregate gets a structure fingerprint (hash of binding and columns). A changed fingerprint invalidates derived cubes built from it.
- An aggregate is rejected, with a reason that appears in the decision log, when its binding is invalid, its source table or time column does not exist, its time column is outside its sorting key, or its partition key differs from the source's. A column that fits no role is unusable; the aggregate stays usable for members that do not read it. An aggregate without a refresh record is accepted but never used (FR-023).

### 3. Expression classification (`expressions.js`) — FR-008, FR-009, FR-012

- One round trip per cube: `EXPLAIN AST SELECT e1, e2, …`, parsed into a tree of `Function`, `Identifier`, `Literal` nodes.
- Classes: **K** reads grouping columns only; **S** is exact when summed over aggregate rows; **X** unsafe.
- Rules: identifier → its column class (grouping column K, sum column S, anything else X); literal → K; any function whose arguments are all K → K; `arrayElement(summed map, K)` → S; `multiply` with exactly one S argument and the rest K → S; `divide(S, K)` → S; `plus`/`minus` with all-S arguments → S; numeric casts and `negate` of S → S; everything else → X. A read of the aggregate's time column anywhere but the plain time dimension → X.
- Cube member SQL becomes an expression by resolving `{CUBE}.col` and references to other dimensions recursively. Any other template form (`FILTER_PARAMS`, `SECURITY_CONTEXT`, another cube) makes the member X.
- Cached per (schema version, cube, structure fingerprint).

### 4. Derivation (`derive.js`) — FR-007 to FR-010, FR-012, FR-015 to FR-017

Input: the cube's YAML definition from the tenant's own schema files, loaded with `findDataSchemasByIds` using the file ids and checksums already in the security context (the loader `repositoryFactory` uses), and parsed once per schema version.

Eligibility of a cube (FR-012): defined in YAML with its own `sql` or `sql_table`; no `extends`; no `pre_aggregations`; its SQL is a single plain read of the bound source (`SELECT *`, optionally with `REPLACE (…)`, `WHERE`, `SETTINGS`; no `FINAL`, join, union, grouping, or nested read); the `WHERE` predicate is class K.

Derived cube:

- `sql`: the cube's SQL with the source table replaced by the aggregate table (FR-021: the aggregate alone). The `WHERE` predicate and `SETTINGS` are kept verbatim, so the cube's tenant restriction is unchanged (FR-017). A `REPLACE` item whose target the aggregate lacks is removed; an item of class K or S is kept and its target takes that class; an item of class X makes its target unusable.
- Dimensions and segments: kept when class K. The time dimension is kept when it is exactly the bound time column.
- Measures:

| Canonical measure | Condition | Derived measure |
|---|---|---|
| `sum` | expression class S | unchanged |
| `count` | its filters, if any, are class K | `number`: `sum(_rows)`, or `sumIf(_rows, <filters>)` so that no match gives 0 |
| `avg` | a single sum column with a stored `__count`, or a single key of a summed map | `number`: `sum(x) / nullIf(sum(x__count), 0)`; for a map key the divisor is `sum(_rows)` |
| `min`, `max` | class K, or a single column with a stored `__min`/`__max` | unchanged, or reads the stored field |
| `count_distinct` | class K | unchanged |
| `number` | reads only derived measures | unchanged |
| anything else | | left out |

- A measure with filters is kept only if every filter is class K (FR-010).
- Joins are dropped (only single-cube queries are routed). Titles, formats and meta are copied so annotations match.
- Output: the derived cube as YAML, the set of available members, and a reason for each member left out. Content-addressed by a variant key: hash of schema version, cube, aggregate, structure fingerprint and a derivation version constant.

### 5. Decision (`suitability.js`, `routing.js`) — FR-006, FR-011, FR-013, FR-014, FR-018, FR-019, FR-021, FR-023, FR-028, FR-029

- Hook: `installAggregateRouting(cubejs)` wraps the gateway's `getNormalizedQueries`, the one place where every query of a request is final (after access policies, `queryRewrite` and normalization, with relative date ranges resolved) and SQL is not yet generated. Every query surface calls it (FR-018). The wrapper recomputes the decision on every call, so a reused context cannot carry a stale decision.
- Per query, in order: one cube, with at least one aggregate in the catalog; no member expressions, ungrouped rows, or sub-query joins; every member available; time checks; window rule; refresh record.
- Time checks (FR-011): the query's time zone is UTC; the requested granularity is a standard one and a whole multiple of the grain (calendar granularities need the grain to divide a day, which the contract guarantees); range start, and range end plus one millisecond, fall on bucket boundaries. Only `timeDimensions.dateRange` and an `inDateRange` filter on the time dimension are accepted; any other date operator on it keeps the query on the source.
- Window rule (FR-021): take the query's resolved range on the time dimension. If it ends before the aggregate's coverage boundary, the query qualifies. If it reaches past the boundary, it qualifies only when it has no range at all or its length is at least `min_window`; otherwise it stays on the source with reason `window_too_short`.
- Refresh record (FR-023): the aggregate has a verified time and its age is within `max_staleness`; otherwise `not_verified` or `stale`.
- Request rule (FR-014): one aggregate must qualify for every query of the request, which implies they read the same cube; otherwise the whole request runs on the source with reason `request_mixed`.
- Selection (FR-019): among the aggregates that qualify for every query, coarsest grain, then fewest rows.
- Effect: `context.securityContext` is replaced by a copy whose `userScope.dataSource.aggregateVariant` is the variant key, or the marker is removed. `context.aggregateRouting` is set to the chosen aggregate and its coverage boundary, or cleared. Derived files are kept in a module-level map keyed by variant key, bounded to 200 variants with the least recently used evicted.
- Any exception inside the wrapper is logged and the original result is returned unmarked (FR-029).
- One structured log line per request (FR-028): request id, cube, chosen aggregate or reason code. No values.

### 6. Switch and answer mark (`index.js`, `repositoryFactory.js`, `routes/index.js`) — FR-015, FR-016, FR-027, FR-030

- `contextToAppId` appends `_AGG_<variantKey>` when the marker is present. `contextToOrchestratorId`, `schemaVersion` and `preAggregationsSchema` are unchanged, so routed queries share the tenant's driver and queue.
- `repositoryFactory` returns the derived files for a marked context. If the files are no longer in the map, it returns the canonical files, so the query still runs correctly on the source.
- Installed only when `AGGREGATE_ROUTING_ENABLED=true`. When off, nothing is wrapped and no probe runs.
- Answer mark (FR-030, [contracts/answer-mark.md](./contracts/answer-mark.md)): the response-header hook in `routes/index.js`, which already adds `x-synmetrix-authority-revision` to successful `/api/v1/load` responses, also adds `x-synmetrix-aggregate-covered-until` when `req.context.aggregateRouting` is set. The gateway path and the export route both answer from `req.context`, so both carry it. The body is not touched.

### 7. Generate (`generator.js`, `scripts/aggregates.mjs generate`) — FR-024 to FR-026

Contract in [contracts/aggregates-cli.md](./contracts/aggregates-cli.md).

- Inputs: source table, time column, grain, grouping set, `min_age`, `min_window`, `max_staleness`; read-only connection settings from the environment.
- Reads `system.columns` and `system.tables` of the source. Assigns roles (FR-025): the time column; the requested grouping columns; numeric columns outside the source's sorting key as metrics (four fields each); non-nullable numeric maps as summed maps; numeric `ALIAS` columns of the source as stored metrics; `_rows`. Everything else is left out with a reason.
- Exact types come from `DESCRIBE (<fill SELECT>)`, so no type mapping is hand-written. The fill `SELECT` is built by `contract.js`, the same builder refresh uses; it qualifies every source column (`src.col`).
- Declines (FR-026) when there is no usable time column, when the source's partition expression does not involve the time column, or when the grain does not nest inside it.
- Emits text only: `CREATE TABLE … ON CLUSTER` (replicated `AggregatingMergeTree`, the source's partition expression, every grouping column in the sorting key, binding comment), the list of left-out columns, and, when the source's merges change what a read returns and forced merging of old partitions is not configured on it, the `ALTER TABLE … MODIFY SETTING` statement that configures it (FR-026). It emits no fill statement: an aggregate is filled by refresh.

### 8. Refresh (`refresh.js`, `scripts/aggregates.mjs refresh`) — FR-020, FR-022

- Runs with its own write credentials on a schedule shorter than the smallest `max_staleness`.
- For every aggregate in the catalog, one pass:
  1. Note the pass start (server clock).
  2. For each source partition read its fingerprint and the oldest and newest value of the time column.
  3. Read the fingerprints recorded in `aggregate_state` and the partitions the aggregate has.
  4. A source partition belongs in the aggregate when its newest value is older than pass start minus `min_age`. For each such partition that the aggregate lacks, or whose recorded fingerprint differs: fill a staging table with the contract's fill `SELECT` over a plain read of that partition (inserting by column name), swap it in with `REPLACE PARTITION`, then record the fingerprint read in step 2.
  5. Drop aggregate partitions whose source partition is gone or no longer belongs, and clear their records.
  6. If every step succeeded, record for the aggregate the pass start as its verified time, and its coverage boundary: the oldest time-column value among source partitions it does not hold, or the pass start when it holds all.
  7. Drop the staging table.
- A merge that removes duplicates changes the partition's fingerprint, so the next pass rebuilds it; from then on the partition is exact (owner direction 2 and 3). A source change during a build leaves the recorded fingerprint behind the source, so the next pass rebuilds again. A failed pass records no verified time, so routing stops once the tolerance elapses.

### 9. Testing

- **Unit (node:test)**: contract parsing, roles and the fill `SELECT`; AST parsing and classification from recorded fixtures; derivation tables; time alignment, the window rule and selection; catalog cache behaviour with an injected query function; refresh decisions; fail-safe paths; the answer mark (present on a routed answer, absent otherwise); a guard that the wrapped gateway method exists and runs before SQL generation on the installed Cube version.
- **Engine tests** (`services/cubejs/test/aggregates/`, disposable ClickHouse 26.8): the reference query shapes from the 2026-11-20 query log on a synthetic source shaped like the first candidate, over windows the aggregate holds, compared cell for cell (NULL equals NULL, not-a-number equals not-a-number, relative tolerance 1e-9); a real Cube gateway exercising routed, unrouted and mixed requests and metadata; refresh through a partition's life (built, re-loaded, consolidated, rebuilt) with long and short windows that reach the present; generated aggregates for three real table descriptions, before and after merging parts.
- **StepCI**: with the switch off, statements and metadata are identical to today.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Per-request model variant plus a wrapper on a Cube-internal gateway method (`getNormalizedQueries`) | The only place where all queries of a request are final and SQL is not yet generated; needed for silent, name-preserving routing under the Rust planner. | Member rename in `queryRewrite`: response keys change, so it is not silent. Table name injected through the security context into cube SQL: breaks every path that lacks the flag. An accumulator inside `queryRewrite`: cannot tell where one request ends when a context is reused. |
| Feature flag `AGGREGATE_ROUTING_ENABLED` | Routing changes which table production queries read. It must deploy inert and be enabled per environment. | Always-on: a mis-declared aggregate would affect queries the moment it is created, with no way to stop it short of a rollback. |
| Expression parsing by a ClickHouse round trip (`EXPLAIN AST`) | Exactness must be proven for arbitrary member expressions in ClickHouse's own dialect. | A JavaScript SQL parser: new dependency, incomplete ClickHouse dialect. Regex checks: cannot prove linearity, so either unsafe or useless for "sum of an expression" measures, the dominant sum form in the local model survey (1,341 of 2,154). |
| Disposable ClickHouse container for tests | Exactness can only be shown by running both paths on the real engine, including merges. | Mocked results: would test the mocks. Tests against the shared dev cluster: not hermetic and need write access. |
| Refresh shipped in the cubejs image but run as a separate job | The column contract must have one implementation; refresh needs the same role and fill logic as generation. | A second implementation in the infrastructure repository: two copies of the contract, in two languages, that can drift. |
