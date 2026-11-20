# Contract: Aggregate Table

**Audience**: whoever defines an aggregate in the schema repository. The `generate` command produces definitions that follow this contract.

An aggregate that breaks a binding rule (sections 1 to 3) is ignored by routing. A column that breaks a column rule (section 4) is unusable, and members that read it stay on the source. Every role is read from the table itself.

## 1. Place and name

- Same database as the source table.
- Name: `<source>__agg_<grain>` with the grain written without spaces, for example `sales_lines__agg_1day`. The name is a convention for people; routing binds by the comment, not the name.

## 2. Binding (table comment)

A JSON object with exactly these six fields:

```json
{"aggregate_of": "cst.sales_lines", "time_column": "timestamp", "grain": "1 day", "min_age": "7 day", "min_window": "60 day", "max_staleness": "1 day"}
```

| Field | Rule | What it decides |
|---|---|---|
| `aggregate_of` | `database.table` of the source | which table is summarised |
| `time_column` | the source's time column; present in the aggregate under the same name | |
| `grain` | `"<n> <unit>"`, unit `second`, `minute`, `hour` or `day`; must divide one day | bucket size |
| `min_age` | `"<n> <unit>"`; may be `"0 second"` | a source partition is summarised only when its newest row is older than this |
| `min_window` | `"<n> <unit>"` | a query that reaches past what the aggregate holds uses it only if its window is at least this long |
| `max_staleness` | `"<n> <unit>"`, greater than zero | the aggregate is not used when no complete refresh pass ran within this time |

Buckets are cut in UTC: the aggregate's time column holds `toDateTime(toStartOfInterval(<time_column>, INTERVAL <grain>, 'UTC'), 'UTC')`. The source's time column must itself be kept in UTC, or a bucket could fall outside the partition of the rows it summarises.

Choosing `min_age`:

- Longer than the time after which rows of a period stop changing: the aggregate then holds only settled data. With a source partitioned by month, the current month is missing from routed long windows until it is that old.
- `"0 second"`: the aggregate holds everything as of the last refresh pass, including recent days that may still contain duplicates the database has not consolidated.

## 3. Engine and keys

- `AggregatingMergeTree` (replicated on a cluster).
- **Partition by exactly the source's partition expression.** Matching partitions must have the same partition id. The source's partition expression must involve the time column, and the grain must nest inside it (a 30-minute or one-day bucket inside a month).
- **Every plain column must be in the sorting key.** A plain column outside it gets an arbitrary value when rows merge, so routing treats it as unusable.
- Nullable grouping columns need `allow_nullable_key = 1`.

## 4. Columns

| Purpose | Name | Type | Filled with |
|---|---|---|---|
| time bucket | the source's time column name | as source | `toStartOfInterval(col, INTERVAL <grain>)` |
| grouping column | the source column's name | as source | the column |
| sum | the source column's name | `SimpleAggregateFunction(sum, T)` | `sum(col)` |
| non-null count | `<col>__count` | `SimpleAggregateFunction(sum, UInt64)` | `count(col)` |
| minimum | `<col>__min` | `SimpleAggregateFunction(min, T)` | `min(col)` |
| maximum | `<col>__max` | `SimpleAggregateFunction(max, T)` | `max(col)` |
| row count | `_rows` | `SimpleAggregateFunction(sum, UInt64)` | `count()` |
| per-key sum of a numeric map | the source column's name | `SimpleAggregateFunction(sumMap, Map(String, T))` | `sumMap(col)` |

Rules:

1. A column under a source column's bare name holds either the grouping value or the sum. Nothing else may use a bare source name.
2. `__count`, `__min` and `__max` exist only next to a sum of the same column.
3. A map's key type is `String` and its value type is not nullable.
4. The source's own `ALIAS` columns may be stored as metrics under the same name.

## 5. How an aggregate is filled and kept exact

Only by the refresh process, one partition at a time, from a plain read of the source without duplicate removal:

```sql
INSERT INTO <staging> (<columns in SELECT order>)
SELECT src.<grouping columns…>,
       toDateTime(toStartOfInterval(src.<time_column>, INTERVAL <grain>, 'UTC'), 'UTC') AS <time_column>,
       sum(src.<m>) AS <m>, count(src.<m>) AS <m>__count, min(src.<m>) AS <m>__min, max(src.<m>) AS <m>__max,
       sumMap(src.<map>) AS <map>,
       count() AS _rows
FROM <source> AS src
WHERE src._partition_id = '<partition id>'
GROUP BY <grouping columns…>, toDateTime(toStartOfInterval(src.<time_column>, INTERVAL <grain>, 'UTC'), 'UTC')
```

followed by `ALTER TABLE <aggregate> REPLACE PARTITION ID '<partition id>' FROM <staging>`.

Source columns are qualified with `src.` because an output alias would otherwise shadow the column it is built from. The insert names its columns because the table's column order differs from the `SELECT`.

A partition is rebuilt whenever the source partition's set of parts has changed since it was built. That includes the database merging a partition and removing duplicates, so a partition is exact from the first refresh after it has settled. For a replacing source table, old partitions settle by themselves when the source has these settings (off by default):

```sql
ALTER TABLE <source> MODIFY SETTING
  min_age_to_force_merge_seconds = <seconds>,
  min_age_to_force_merge_on_partition_only = 1;
```

## 6. Refresh records

`<database>.aggregate_state`, one per database, written by the refresh job only. Per aggregate it holds when the last complete pass started and up to where the aggregate holds data; per partition, which source content it was built from. Structure in [data-model.md](../data-model.md).

## 7. Which queries use an aggregate

A query whose members are all available, and whose bucket and range fit the grain, uses the aggregate when:

- its window ends before the point up to which the aggregate holds data, or
- its window reaches past that point and is at least `min_window` long, or has no time limit. The newest buckets of such an answer may be missing or behind. A routed answer from the query endpoint says through what time it is complete ([answer-mark.md](./answer-mark.md)).

A shorter window that reaches past that point reads the source. So does every query while the aggregate has no complete refresh pass within `max_staleness`.

## 8. Taking an aggregate out of use

1. Clear the table comment (`ALTER TABLE … MODIFY COMMENT ''`).
2. Wait 60 seconds (one catalog lifetime).
3. Drop the table.

Dropping first can fail queries that were routed from a still-cached structure.

## 9. Changing an aggregate

- **Adding a column** is safe at any time: routing re-reads the structure within 60 seconds and re-derives.
- **Removing or changing a column**: take the aggregate out of use first (section 8, steps 1 and 2), make the change, then restore the comment. A query routed from a still-cached structure could otherwise read a column that is gone.
- A column that no longer fits a role is treated as unusable.
