# Research: Aggregate-Aware Query Routing

**Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

All experiments were throwaway prototypes: Cube-generated SQL from a local cubejs container (Cube 1.7.30), run in an isolated `clickhouse local` 26.8.7 with synthetic rows. Nothing was created on any cluster. Cluster facts come from read-only queries on the dev ClickHouse (26.8.7, 1 shard, 3 replicas).

## What ClickHouse offers for aggregate tables

| Option | How it works | Fit here |
|---|---|---|
| `AggregatingMergeTree` filled by a job | One row per group; `SimpleAggregateFunction` columns hold plain values that merge by their function. | **Chosen.** Any measure that is exact on "one row per group" works, and it can be filled partition by partition. |
| `SummingMergeTree` | Sums numeric columns of rows with the same key on merge. | A subset of the above: sums only, no minimum or maximum. |
| Insert-triggered materialized view | Runs a query on every inserted block and writes the result to a target table. | **Rejected.** It sees inserts, not merges. The source re-inserts three days of rows daily and removes the old copies on merge, so the view would count them twice and never correct itself. |
| Refreshable materialized view | Re-runs a whole query on a schedule and swaps the result in. `system.view_refreshes` exists on 26.8. | **Rejected for large tables.** Every refresh recomputes everything; at product grain that is hundreds of millions of groups from 1.14 billion rows. Its behaviour on a replicated cluster without a replicated database was not tested. |
| Projection | An aggregate stored inside each part of the source; the optimizer uses it by itself. | **Rejected** (tested). Not used when the query filters on the raw time column, when it buckets with Cube's time expression, or with `FINAL`. Also restricted on `ReplacingMergeTree`. |
| TTL with `GROUP BY` | Rolls old rows up inside the source table itself. | **Rejected.** It destroys the detail rows. |
| `CoalescingMergeTree` | Keeps the latest non-null value per key. | Not an aggregate of sums. |

## What ClickHouse offers for deduplication

| Option | What it does | Use here |
|---|---|---|
| Background merges of `ReplacingMergeTree` | Rows with the same sorting key collapse when their parts merge. | **Relied on.** A partition that is one part has no duplicates. A merge changes the partition's parts, so the refresh rebuilds it. |
| `min_age_to_force_merge_seconds` with `min_age_to_force_merge_on_partition_only` | Merges a partition down to one part once every part in it is older than the given age. Both are off (0) by default. | **Switched on for the first candidate on dev (2026-11-20, 7 days).** Sandbox: three parts with duplicates became one duplicate-free part within seconds, with no command issued. On dev: of 114 old partitions that were more than one part, 92 had merged within the hour, with no replica delay. |
| `OPTIMIZE TABLE … PARTITION … FINAL` | Merges one partition now. | A manual alternative to the setting. |
| `FINAL` in a `SELECT` | Removes duplicates at read time. | **Not used.** No statement in this feature contains it. |
| `OPTIMIZE … DEDUPLICATE` | Removes fully identical rows. | Not needed for a replacing table. |
| Insert-block deduplication | Drops an identical block that is inserted twice. | Covers retries only, not re-loads of changed rows. |

## Decisions

### D1. Physical form: a separate aggregate table

- **Decision**: one `AggregatingMergeTree` table per source and grain, in the source's database, partitioned by the source's partition expression. It holds the source partitions whose newest row is older than the aggregate's `min_age`.
- **Rationale**: see the two tables above. Partitioning like the source gives every source partition one matching aggregate partition with the same partition id, which lets the refresh replace exactly one partition at a time.

### D2. The contract lives in ClickHouse metadata

- **Decision**: the table comment binds an aggregate to its source and carries its settings (`aggregate_of`, `time_column`, `grain`, `min_age`, `min_window`, `max_staleness`). Column roles come from name, type and sorting-key membership.
- **Rationale**: no artifact in the semantic layer (owner constraint). Types such as `SimpleAggregateFunction(sum, …)` already state the function, and `system.columns.is_in_sorting_key` states what is a grouping column.
- **Alternatives considered**: a twin cube authored in the model (visible, duplicates definitions); cube `meta` entries (still a model change); a naming convention alone (cannot carry the grain or the time settings).
- **Evidence**: the Synmetrix ClickHouse account already reads `system.columns` and `system.tables` (37 successful reads in 14 days, none failed). Its grant is `SELECT ON <database>.*`, so aggregates must live in the source's database.

### D3. Replacement by a derived in-memory cube variant

- **Decision**: build a variant of the cube with the same cube and member names, the source table replaced inside the cube's own SQL, and measures rewritten by role. Key it into the app id; serve it from `repositoryFactory`.
- **Rationale**: Cube generates all SQL, so member names, output columns and annotations are identical by construction. The canonical compile is untouched, so `/meta`, validation and the pre-aggregation refresh worker never see the variant.
- **Alternatives considered**: member rename to a sibling cube (response keys change); table name through `SECURITY_CONTEXT` in cube SQL (works under Tesseract, but every path without the flag renders a broken table name, and measures cannot be rewritten); rewriting the final SQL text (fragile, cannot fix `count`).
- **Evidence**: gateway spike. Suitable queries read the aggregate with identical output columns; unsuitable ones read the source; `/meta` listed only the canonical cube; two compiled models were held.

### D4. Decide once per request, after rewriting

- **Decision**: wrap the gateway's `getNormalizedQueries`.
- **Rationale**: it returns every query of the request in final form (access policies, `queryRewrite` and normalization applied, relative date ranges resolved), and every surface calls it before generating SQL: `load`, `sql`, `dryRun`, `stream`, `sqlApiLoad`, and our export route. Recomputing on each call avoids stale state on contexts that Cube reuses (WebSocket subscriptions keep one context object).
- **Consequence**: one request has one context and therefore one variant, so a request is routed only when one aggregate qualifies for all its queries.
- **Alternatives considered**: deciding inside `queryRewrite` (called per query, with no signal for where a request starts or ends).
- **Evidence**: call order read in api-gateway 1.7.30 and 1.8.16 (access policies, then `queryRewrite`, then `getSqlQueriesInternal` re-requests the compiler from the context).

### D5. Exactness is proven on ClickHouse's own syntax tree

- **Decision**: classify each expression by walking the output of `EXPLAIN AST`: K (grouping columns only), S (exact when summed), X (unsafe).
- **Rationale**: no SQL parser dependency; ClickHouse parses its own dialect. The tree is a plain indented list of `Function`, `Identifier` and `Literal` nodes.
- **Alternatives considered**: a JavaScript SQL parser (new dependency, incomplete dialect); requiring measures to reference a single named column (would exclude 1,341 of 2,154 sum measures in the local model survey).
- **Evidence**: the real cube's rewritten `quantity` expression (casts, `ifNull`, `if`, `transform`, division) classified as S; `quantity * quantity` and a filter on a summed column classified as X.
- **Note**: the tree does not print the target name of a `REPLACE` item or the `FINAL` keyword. Those are read from the statement text.

### D6. One stored field per function

- **Decision**: `<col>` holds the sum; `<col>__count`, `<col>__min`, `<col>__max` the other functions; `_rows` the row count; a numeric map is stored as a per-key sum.
- **Rationale**: average, minimum, maximum and count are wrong by name alone (`count` 2,000,000 vs 24,500; `avg` 2.5 vs 204; `max` 4 vs 250 in the sandbox) and exact with these fields. A count must become `sumIf(_rows, filter)`, because a filtered sum returns an empty value where a count returns 0.
- **Map metrics**: the source reads a missing key as 0, so a plain average over a key equals `sum(key) / sum(_rows)`, which the aggregate reproduces exactly. A minimum or maximum by key cannot be reproduced (source 0, aggregate 5 in the sandbox), so it stays on the source and no minimum or maximum map is stored. `sumMap` rejects a `LowCardinality(String)` key on 26.8; the aggregate's map key is `String`.
- **Alternatives considered**: opaque states (`AggregateFunction(avg, …)`), which work but cannot be read by name; parallel arrays with `-ForEach`, which are exact but positional and only available as states.

### D7. Time rules

- **Decision**: the grain divides one day; buckets are cut in UTC; a query qualifies when its bucket is a whole multiple of the grain, its time zone is UTC, and its range starts and ends on bucket boundaries. Among qualifying aggregates the coarsest is used.
- **Evidence**: with 30-minute and one-day aggregates, hour queries used the 30-minute table, day, week and month queries used the one-day table, a range starting at 10:30 used the 30-minute table, and all results were identical; minute queries and a 10:15 start stayed on the source. A day aggregate queried with a range starting at 12:00 returned a different sum.
- **Alternatives considered**: supporting time zones whose offset is a multiple of the grain. Correct but requires tracking daylight-saving transitions across the range; dashboards bucket in UTC today.

### D8. Plain reads, rebuilt on change; deduplication is the database's

- **Decision**: an aggregate partition is built from a plain read of its source partition and rebuilt whenever that partition's fingerprint has changed. `min_age` (which may be zero) keeps partitions with younger rows out of the aggregate.
- **Rationale** (owner direction 2 to 4): no statement removes duplicates at read time. When the database merges a partition and removes duplicates, its part set changes, the refresh rebuilds it, and from then on it is exact. So historical data is exact from the first refresh after it has settled.
- **Evidence from the first candidate**: recent days hold duplicates waiting for a merge (18 November: 295,496 of 719,545 rows). An old two-part partition (June 2026, 14,395,029 rows) holds none. Before the forced-merge settings only 20 of the largest tenant's 87 monthly partitions were one part; within an hour of switching them on, 65 were.
- **Alternatives considered**: building with `FINAL` (no statement may use it); building a partition only once it is a single part (old partitions that have not merged yet would be missing from long windows).

### D9. The aggregate alone; long windows only when the window reaches the present

- **Decision** (owner direction 5): a routed query reads the aggregate and nothing else. A window that lies within what the aggregate holds is routed. A window that reaches past it is routed only if it is at least `min_window` long or has no time limit; shorter ones read the source. The aggregate is used only while a complete refresh pass is recorded within `max_staleness`.
- **Consequence, accepted by the owner**: in a routed long window the periods the aggregate holds are exact as of the last refresh; newer periods are missing, and a held period that changed since the last refresh is behind until the next one.
- **Rationale**: the slow queries are long windows; short windows that include now are fast on the source already and must be current.
- **Alternative tested and not chosen**: combining aggregate and source in one statement, with ClickHouse deciding per partition at query time whether the aggregate was built from the source's current part set (aggregate rows for current partitions, raw source rows shaped as groups of one for the rest). In the sandbox this equalled the source at every step of a partition's life, read only the parts each branch needed, and its metadata check cost 3 to 5 ms on dev. The owner chose not to combine: more machinery than the use case needs.

### D10. Refresh by source partition

- **Decision**: fingerprint each source partition from the names of its active parts; build partitions that belong in the aggregate and are missing or changed into a staging table with a plain read; swap with `REPLACE PARTITION`; record the fingerprint that was read before the build. After a complete pass record its start time and the coverage boundary.
- **Rationale**: any insert, merge, mutation or expiry changes the set of part names, so the fingerprint detects every kind of change without knowing its cause. The swap is atomic per partition. One month of the largest tenant is about 14 million rows.
- **Safety**: if the source changes during a build, the recorded fingerprint differs from the source's, so the next pass rebuilds. A failed pass records no time, so the aggregate falls out of use after `max_staleness`.
- **Constraint**: the grain must nest inside the source's partition expression.
- **Alternatives considered**: refreshable materialized view (see the options table); replacing rows by key in a replacing aggregate (groups that disappear from the source would stay).

### D11. Generation from metadata

- **Decision**: classify source columns from `system.columns`; build the fill `SELECT`; ask ClickHouse to `DESCRIBE` it for exact types; emit the definition as text. The same fill `SELECT` is what refresh runs, so an aggregate has one fill path.
- **Evidence**: aggregates generated for three real schemas (124, 40 and 306 columns) matched the source on every stored metric for sum, average, minimum, maximum and count, also after merging parts (0 mismatches). Two prototype lessons are part of the design: qualify source columns in the fill `SELECT` (an output alias otherwise shadows its own input) and have refresh insert by column name.
- **Input the operator must give**: the grouping set. All 79 low-cardinality columns of the sales table gave no reduction; six gave 200,000 → 31,192 rows in the sandbox.

### D12. One script, no routes

- **Decision**: `services/cubejs/scripts/aggregates.mjs` with `generate` and `refresh`, using the same modules as routing.
- **Rationale**: one implementation of the contract. Synmetrix's query account stays read-only; the script takes its own connection settings.
- **Alternatives considered**: REST routes for generation, explanation and comparison (not requested; the decision log and the equivalence suite cover the need); a second implementation in the infrastructure repository (two copies of the contract).

### D12a. A routed answer carries a coverage mark

- **Decision** (owner direction 6; cxs2 spec 290, section 5.1): a successful `/api/v1/load` response that was served from an aggregate carries the header `x-synmetrix-aggregate-covered-until` with the aggregate's coverage boundary. An unrouted response carries no such header. The body is unchanged.
- **Rationale**: a dashboard holds a long-window row set and also asks short-window questions about single buckets. The two can disagree on recent buckets. With the mark, the dashboard answers only buckets wholly before the boundary from its row set.
- **How**: the route already adds `x-synmetrix-authority-revision` and `x-synmetrix-capabilities` in a response-header hook; the mark is one more header there, read from the request context the decision wrote to. The gateway path and the export route both use that context.
- **Alternatives considered**: a field in the response body (changes the answer's content, and a multi-query response has several result objects); a separate endpoint to ask what an aggregate covers (a second request, and it could disagree with the answer it describes).

### D13. Scope cuts for the first version

- YAML cubes with their own `sql` or `sql_table`, no `extends`.
- Cube SQL of the form `SELECT * [REPLACE (…)] FROM <source> [WHERE …] [SETTINGS …]`. In the local model survey this covers 182 of 454 cubes (144 `SELECT *`, 38 `sql_table`); explicit column lists (72) and joins, unions and nested reads (199) are not routed.
- Single-cube, grouped queries without member expressions.
- Cubes without built-in pre-aggregations.

### D14. Off by default

- **Decision**: `AGGREGATE_ROUTING_ENABLED=true` installs the wrapper; otherwise nothing runs.
- **Rationale**: the deployment must be inert, as with the default-models rollout.

## Evidence summary

| Experiment | Result |
|---|---|
| Table-name swap inside the real no-`FINAL` cube SQL, six dashboard shapes | Identical results |
| Same, `count` / off-boundary range / dropped column | Different, different, database error |
| Per-function fields: sum, avg, min, max, count, non-null count | Exact, before and after merge |
| Through Cube: avg, min, max, count, filtered count ratio, map-key sum and avg | Identical rows and output columns |
| Full chain (probe, derive, decide, compare) on a sales-shaped table | 10 of 14 measures kept; 6 routed shapes identical; 5 stayed on source with a reason |
| Gateway spike: single, compare-date-range and mixed requests | Routed, routed, not routed; `/meta` canonical |
| Grain selection with 30-minute and one-day aggregates | Correct table chosen; identical results |
| Generator on three real schemas | 0 mismatches, also after merge |
| Alternative not chosen: combined read through a partition's life (built, loaded into, merged, rebuilt, dropped) | 0 differences at every step; only the needed parts read |
| Forced merge of an old partition without any command (sandbox) | 3 parts → 1, duplicates removed |
| Forced-merge settings on `cst.sales_lines` on dev | Applied on all three replicas; 114 → 22 old multi-part partitions within the hour; no replica delay |

## Facts about the first candidate (`cst.sales_lines`, 2026-11-20)

- `ReplicatedReplacingMergeTree`, no version column; partitioned by `(partition, toStartOfMonth(timestamp))`; 1.14 billion rows, 1.12 billion for one tenant in 87 monthly partitions.
- Cube SQL in use: `SELECT * REPLACE (…) FROM cst.sales_lines WHERE partition = '…' SETTINGS asterisk_include_alias_columns = 1`, without `FINAL`. A second variant that reads the last two months with `FINAL` was still being issued on that day.
- One month (13.99 million rows) groups to 3.84 million rows at day × store × product × price, 1.06 million at day × store × category × supplier × brand, and 33 thousand at day × store × main category.
- Heaviest shapes: revenue by month over a year (5.8 s average, 764 million rows read); a store-name list that reads all rows (207 runs in 21 hours).

## To verify during implementation

1. The wrapper on Cube 1.8.16 at runtime. **Confirmed on 2026-11-20** against a real 1.8.16 gateway with the Rust planner on: `sql`, the `load` path (`getNormalizedQueries` then `getSqlQueriesInternal`), a compared date range, a mixed request, a relative range (already resolved), a reused context, and `meta` behave as designed. `dryRun` returns no statement text in 1.8.16, so tests assert on its success and the mark, not on a table name. Still to see on the deployed service (T057).
2. `EXPLAIN AST` through the tenant driver. **Confirmed on 2026-11-20 at account level**: the platform's account on dev (`synmetrix_query`) runs with `readonly = 2`, and `EXPLAIN AST` (including `SELECT * REPLACE`, map elements and `IN` lists) runs in a stricter `readonly = 1` session on the dev server. The driver path is exercised by the engine tests; the deployed service is checked in T057.
3. Replicated `AggregatingMergeTree` with `ON CLUSTER`, and `REPLACE PARTITION` from a staging table, on three replicas. The sandbox was single-node.
4. Removing unknown `REPLACE` targets in derivation. ClickHouse 26.8 ignores them, but the derivation does not rely on that.
5. The answer mark on Cube 1.8.16: that `req.context` is the object the wrapped gateway method receives, for the gateway path and the export route.

## Owner direction recorded (2026-11-20)

1. Lag is acceptable; this is mostly for historical data.
2. Rely on the database's own deduplication. The forced-merge settings were switched on for the first candidate on dev at the owner's request.
3. Historical data must be exact as soon as it is stable.
4. The age from which data is summarised is configurable per aggregate (`min_age`).
5. Aggregate and source are not combined. A long window is answered from the aggregate and its newest data may be wrong; the aggregate is not used for short windows that include now (`min_window`).
6. An answer served from an aggregate says so and through what time it holds data (the answer mark), so the dashboard can read newer buckets from the source.
