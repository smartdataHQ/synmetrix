# Contract: `aggregates.mjs` commands

**Location**: `services/cubejs/scripts/aggregates.mjs`, shipped in the cubejs image.
**Shared code**: `src/utils/aggregates/contract.js`, `generator.js`, `refresh.js`. The same modules serve query routing, so the column contract has one implementation.

## Connection

Both commands read their own connection settings from the environment. They do not use tenant data-source credentials and are never run by query pods.

| Variable | Meaning |
|---|---|
| `AGGREGATES_CLICKHOUSE_URL` | HTTP(S) endpoint |
| `AGGREGATES_CLICKHOUSE_USER` | account name |
| `AGGREGATES_CLICKHOUSE_PASSWORD` | password |

`AGGREGATES_CLICKHOUSE_URL` must address one replica, not a load-balanced service: `refresh` builds each partition in a staging table that exists only on the server it is connected to.

`generate` needs `SELECT` on the source table and on `system.tables` and `system.columns`.

`refresh` needs these privileges and no others (the engine tests run a pass with exactly this set):

```sql
GRANT SELECT ON system.parts TO <account>;
GRANT SELECT ON system.tables TO <account>;
GRANT SELECT ON system.columns TO <account>;
GRANT SELECT, INSERT ON <database>.aggregate_state TO <account>;
-- per aggregate:
GRANT SELECT ON <database>.<source> TO <account>;
GRANT SELECT, INSERT, ALTER DELETE ON <database>.<aggregate> TO <account>;
GRANT CREATE TABLE, DROP TABLE, SELECT, INSERT, TRUNCATE, ALTER MODIFY COMMENT ON <database>.<aggregate>__staging TO <account>;
```

With them the account cannot write to a source table, drop an aggregate or change its binding. A new aggregate needs its three grants before the first pass.

## `generate`

Produces an aggregate definition as text on standard output. Executes nothing that changes data (FR-024). The aggregate is filled by `refresh`.

```text
node scripts/aggregates.mjs generate \
  --source <database.table> \
  --time-column <column> \
  --grain "<n> <unit>" \
  --group-by <col>[,<col>…] \
  --min-age "<n> <unit>" \
  --min-window "<n> <unit>" \
  --max-staleness "<n> <unit>" \
  [--cluster <name>]
```

**Output**, in this order:

1. `CREATE TABLE IF NOT EXISTS <database>.<source>__agg_<grain> [ON CLUSTER <name>] …` following [aggregate-contract.md](./aggregate-contract.md), with the binding comment.
2. A comment block listing every source column that was left out, with a reason (FR-026).
3. When the source's engine is not plain `MergeTree` and forced merging of old partitions is not configured on it: the `ALTER TABLE <source> MODIFY SETTING min_age_to_force_merge_seconds = …, min_age_to_force_merge_on_partition_only = 1` statement, as a comment, with a note that old partitions otherwise keep their duplicates (FR-026).

**Column assignment** (FR-025):

| Source column | Becomes |
|---|---|
| `--time-column` | time bucket |
| listed in `--group-by` | grouping column |
| numeric, not in the source's sorting key, not listed in `--group-by` | metric: sum, `__count`, `__min`, `__max` |
| numeric `ALIAS`, not listed in `--group-by` | stored metric, same four fields |
| `ALIAS` declared non-nullable while its expression can be NULL | left out: reading it fails on a row with a missing value, which would stop every build |
| map of string to non-nullable number | per-key sum |
| anything else | left out, with a reason |
| (always) | `_rows` |

**Declines with a non-zero exit code and a reason** (FR-026) when:

- the source table or a named column does not exist;
- `--time-column` is not a date-time column, or is not kept in UTC;
- the source's partition expression does not involve the time column;
- the grain does not divide one day, or does not nest inside the source's partition expression;
- a `--group-by` column has a type that cannot be a grouping column (map, array, nested, JSON);
- a column the source's partition expression reads is not listed in `--group-by`;
- a `--group-by` column is an `ALIAS` declared non-nullable while its expression can be NULL.

**Exit codes**: `0` definition written; `2` declined (reason on standard error); `1` connection or unexpected error, including a missing option.

## `refresh`

Brings every aggregate in the catalog in step with its source and records what it holds (FR-020, FR-022).

```text
node scripts/aggregates.mjs refresh [--only <database.aggregate>]
```

**One pass, per aggregate**:

1. Note the pass start time (server clock).
2. For every source partition, read its fingerprint (a hash over the names of its active parts) and the oldest and newest value of the time column in it.
3. Read the fingerprints recorded in `aggregate_state` and the partitions the aggregate has.
4. A source partition belongs in the aggregate when its newest value is older than the pass start minus `min_age`. For each such partition that the aggregate lacks, or whose recorded fingerprint differs: fill a staging table (`<aggregate>__staging`, never replicated) with the contract's fill statement over a plain read of that partition, check that every row landed in that partition, then `ALTER TABLE <aggregate> REPLACE PARTITION ID … FROM <staging>`, then record the fingerprint read in step 2.
5. For each aggregate partition whose source partition is gone or no longer belongs: drop it and record fingerprint 0.
6. If every step succeeded, record for the aggregate the pass start as its verified time, and its coverage boundary: the oldest time-column value among the source partitions it does not hold, or the pass start when it holds all.
7. Drop the staging table.

**Guarantees**:

- A reader sees a partition's old content or its new content, never a mixture (atomic swap).
- A partition whose source changed, including by a merge that removes duplicates, is rebuilt by the next pass.
- If the source changes during a build, the recorded fingerprint is the older one, so the next pass rebuilds again.
- If any step fails, no verified time is recorded for that aggregate; routing stops by itself once `max_staleness` elapses.
- No statement uses duplicate removal at read time.
- Aggregates are processed independently: a failure in one does not stop the others.
- The staging table is dropped at the end of the pass, also after a failure.

**Scheduling**: run at an interval shorter than the smallest `max_staleness` minus the expected pass duration. Passes must not overlap for the same aggregate; the job is configured to forbid concurrent runs.

**Exit codes**: `0` all aggregates verified; `3` at least one aggregate failed (details on standard error); `1` connection or unexpected error.

**Log output**: one line per aggregate with partitions checked, built and dropped, and the duration (`refresh  aggregate=…  checked=…  built=…  dropped=…  ms=…`); a failed aggregate and a table whose binding was rejected are reported on standard error. No row values.
