# Data Model: Aggregate-Aware Query Routing

**Date**: 2026-11-20 | **Plan**: [plan.md](./plan.md)

No PostgreSQL or Hasura entity changes. The feature has two ClickHouse-side objects (defined in the schema repository) and four in-memory structures in the cubejs process.

## Terms

| Term | Meaning |
|---|---|
| Partition | A ClickHouse partition of the source table (the spec's "period"). The aggregate uses the same partition expression, so matching partitions share a partition id. |
| Fingerprint | `groupBitXor(cityHash64(name))` over a partition's active parts. Changes with any insert, merge, mutation or expiry; a past value never recurs. |
| Held | The aggregate has the partition, built from the source partition's content at some refresh. |
| Coverage boundary | The earliest time-column value in any source partition the aggregate does not hold; the time of the pass when it holds all. Everything before it is held. |
| Verified | The start time of the last complete, successful refresh pass. |

## ClickHouse-side

### Aggregate table

One per source table and grain. Rules in [contracts/aggregate-contract.md](./contracts/aggregate-contract.md).

**Binding** (table comment, JSON, exactly these fields):

| Field | Type | Rule |
|---|---|---|
| `aggregate_of` | string | `database.table` of the source; same database as the aggregate; the table exists |
| `time_column` | string | a date-time column of both tables; in the aggregate's sorting key |
| `grain` | string | `"<n> <unit>"`, unit `second\|minute\|hour\|day`; divides 86,400 seconds |
| `min_age` | string | `"<n> <unit>"`, same units; may be zero. A source partition is held only when its newest row is older than this |
| `min_window` | string | `"<n> <unit>"`, same units. The shortest window that may use the aggregate when the window reaches past the coverage boundary |
| `max_staleness` | string | `"<n> <unit>"`, same units; greater than zero. How long the aggregate may go without a complete refresh pass before it is no longer used |

An aggregate is rejected and never used when its comment is not this object or breaks a rule, its source table or time column does not exist, its time column is outside its sorting key, or its partition key differs from the source's. Column problems never reject an aggregate: the column is unusable (below).

**Column roles** (derived, never declared):

| Role | Recognised by | Class for expressions |
|---|---|---|
| time bucket | name equals `time_column` | usable only as the plain time dimension |
| grouping column | plain type and `is_in_sorting_key = 1` | K |
| sum | `SimpleAggregateFunction(sum, T)`, name without suffix, not `_rows` | S |
| non-null count | name `<col>__count`, `SimpleAggregateFunction(sum, UInt64)` | read only by the average rule |
| minimum / maximum | name `<col>__min` / `<col>__max`, `SimpleAggregateFunction(min\|max, T)` | read only by the min/max rule |
| row count | name `_rows`, `SimpleAggregateFunction(sum, UInt64)` | read only by the count and map-average rules |
| per-key sum of a map | `SimpleAggregateFunction(sumMap, Map(String, T))`, T numeric and not nullable | `map['key']` is S |
| unusable | anything else | X |

A `<col>__count`, `<col>__min` or `<col>__max` column has its role only if `<col>` exists as a sum column; otherwise it is unusable.

### Refresh records

One table per database that holds aggregates: `<database>.aggregate_state`. Written only by the refresh job.

| Column | Type | Meaning |
|---|---|---|
| `aggregate` | `String` | aggregate table name, without database |
| `partition_id` | `String` | partition id (the same in source and aggregate); empty string for the aggregate-level row |
| `fingerprint` | `UInt64` | partition row: the source partition's fingerprint read before the build, 0 after the partition was dropped. Aggregate-level row: 0 |
| `verified_at` | `DateTime('UTC')` | aggregate-level row: start of the last complete pass. Partition row: time it was built |
| `covered_until` | `DateTime64(3, 'UTC')` | aggregate-level row: the coverage boundary after that pass. Partition row: unused |
| `updated_at` | `DateTime64(3, 'UTC')` | row version |

Engine: replicated `ReplacingMergeTree(updated_at)`, ordered by `(aggregate, partition_id)`. Readers take the latest row per key with `argMax(…, updated_at)`.

## In memory (cubejs process)

### Catalog entry

Key: data source version (tenant-scoped). Lifetime: 60 seconds, refreshed in the background.

```text
CatalogEntry
  loadedAt            monotonic time of the probe
  serverNowAtLoad     ClickHouse now() at the probe
  aggregates[]        AggregateStructure, accepted ones
  rejected[]          { table, reason }
```

### Aggregate structure

```text
AggregateStructure
  table               "database.table" of the aggregate
  source              "database.table" of the source
  timeColumn          string
  grainSeconds        integer
  minAgeSeconds       integer
  minWindowSeconds    integer
  maxStalenessSeconds integer
  totalRows           integer (for selection among equal grains)
  columns             Map<name, { role, type }>
  verifiedAt          server time of the last complete pass, or null
  coveredUntil        coverage boundary after that pass, or null
  fingerprint         hash of binding + columns
```

Usable for routing when `verifiedAt` is not null and `serverNowAtLoad + elapsed - verifiedAt <= maxStalenessSeconds`.

### Derived cube

Key (variant key): hash of schema version, cube name, aggregate table, structure fingerprint, derivation version constant.

```text
DerivedCube
  variantKey          string
  cube                cube name (unchanged)
  aggregate           AggregateStructure.table
  files               [{ fileName, content }]   one YAML file holding the one derived cube
  available           Set<"cube.member">
  leftOut             Map<"cube.member", detailCode>
  ineligible          detailCode | null         when the cube as a whole cannot be derived
```

Held in a map bounded to 200 variants (least recently used evicted). Never written to the database, never returned by any metadata call.

### Routing decision

One per request (the unit Cube rewrites together). All queries of a request share it: one aggregate must qualify for every query, or none is routed.

```text
RoutingDecision
  requestId           string
  cube                string | null
  aggregate           "database.table" | null
  variantKey          string | null
  coveredUntil        time | null               the aggregate's coverage boundary; sent to the consumer as the answer mark
  reason              reasonCode | null         set when aggregate is null
```

**Reason codes** (stable; used in the decision log and tests):

| Code | Meaning |
|---|---|
| `no_catalog` | catalog not loaded yet, or the data source is not ClickHouse |
| `no_aggregate` | no accepted aggregate for the cube's source table |
| `cube_not_eligible` | the cube breaks an eligibility rule (detail code appended) |
| `multi_cube` | the query reads more than one cube |
| `unsupported_query` | member expression, ungrouped rows, sub-query join, or unknown feature |
| `member_unavailable` | a member is not in the derived cube (member and its detail code appended) |
| `timezone` | the query is not bucketed in UTC |
| `granularity` | the requested bucket is not a whole multiple of the grain, or is non-standard |
| `range_not_aligned` | a range bound is not on a bucket boundary |
| `time_filter` | a date operator other than a range on the time dimension |
| `window_too_short` | the window reaches past the coverage boundary and is shorter than `min_window` |
| `not_verified` | no refresh record |
| `stale` | last complete pass older than `max_staleness` |
| `request_mixed` | the request's queries do not all qualify for one aggregate (one is unsuitable, or they read different cubes) |
| `error` | an exception in discovery, derivation or decision |

**Detail codes** appended to `member_unavailable` (and stored in `DerivedCube.leftOut`):

| Code | Meaning |
|---|---|
| `column_not_in_aggregate` | the member reads a column the aggregate does not carry |
| `not_grouping_column` | a dimension, segment or filter reads a column that is not a grouping column |
| `not_exact_when_summed` | a sum whose expression is not linear in exactly one summed value |
| `no_stored_field` | an average, minimum or maximum without the stored field it needs |
| `reads_time_column` | the member reads the time column other than as the plain time dimension |
| `unsupported_member` | rolling window, multi-stage, sub-query, or an unresolvable template reference |
| `depends_on_unavailable_member` | a calculation over a member that is itself unavailable |

**Detail codes** appended to `cube_not_eligible`:

| Code | Meaning |
|---|---|
| `not_yaml` | the cube is not defined in a YAML model file |
| `extends` | the cube extends another cube |
| `pre_aggregations` | the cube declares built-in pre-aggregations |
| `not_plain_read` | the cube's SQL is not a single plain `SELECT *` read of the source |
| `predicate_not_grouping` | the cube's `WHERE` reads a column that is not a grouping column |

**Rejection reasons** for an aggregate (recorded in `CatalogEntry.rejected`):

| Code | Meaning |
|---|---|
| `invalid_binding` | the comment is not the six-field object, or a field breaks its rule |
| `source_missing` | the source table does not exist |
| `time_column_missing` | the time column is absent from the source or the aggregate, or outside the aggregate's sorting key |
| `partition_key_mismatch` | the aggregate's partition expression differs from the source's |

## Life of a partition

```text
has rows younger than min_age  -> not held; missing from routed answers
old enough, not held           -> built by the next refresh pass, fingerprint recorded
held, source unchanged         -> exact as of its build
source partition changes       -> behind until the next pass rebuilds it (one-step swap)
   (a re-load, or the database consolidating duplicates)
source partition removed       -> dropped from the aggregate, record cleared
```

## Life of an aggregate

```text
created (no comment)           -> not in catalog
bound (comment set)            -> in catalog, reason not_verified
verified (pass recorded)       -> used while within max_staleness
stale (no pass in time)        -> reason stale; used again after the next complete pass
retired (comment cleared)      -> leaves the catalog within one lifetime; then safe to change or drop
```
