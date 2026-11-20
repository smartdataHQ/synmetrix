# Quickstart: Aggregate-Aware Query Routing

End to end on the first candidate, `cst.sales_lines` on dev. Table and column names are examples; every step is the same for any time-series source table.

## Prerequisites

- The feature is deployed with `AGGREGATE_ROUTING_ENABLED` unset (inert).
- A ClickHouse account for `generate` (read) and one for `refresh` (write to aggregates and `aggregate_state`).
- `cst.aggregate_state` exists (from the schema repository).

## 1. Let the source consolidate its old partitions

Old partitions keep duplicates until the database merges them into one part. These settings make it do so by itself once every part of a partition is older than seven days:

```sql
ALTER TABLE cst.sales_lines ON CLUSTER fraios MODIFY SETTING
  min_age_to_force_merge_seconds = 604800,
  min_age_to_force_merge_on_partition_only = 1;
```

Applied on dev on 2026-11-20. `generate` prints this statement for a source that lacks it.

## 2. Generate the aggregate

```bash
node services/cubejs/scripts/aggregates.mjs generate \
  --source cst.sales_lines \
  --time-column timestamp \
  --grain "1 day" \
  --group-by partition,sold_location,main_category,category,product_id,product,brand,supplier,uom,bundled_units,unit_size,unit_price,unit_cost \
  --min-age "7 day" \
  --min-window "60 day" \
  --max-staleness "1 day" \
  --cluster fraios > sales_lines__agg_1day.sql
```

Why this grouping set: the model in use computes `quantity` from `units`, `bundled_units`, `unit_size` and `uom`, and revenue as `quantity * unit_price`. Those formulas stay exact only if every input except `units` is a grouping column. Columns left out of the grouping set are stored as metrics or dropped; the command lists them.

The three time settings:

- `--min-age "7 day"`: only months whose newest row is older than a week are summarised. A daily job re-loads the last three days of this table, so older rows no longer change. Use `"0 second"` to summarise everything as of each refresh.
- `--min-window "60 day"`: a query that reaches into data the aggregate does not hold uses the aggregate only if it spans at least 60 days.
- `--max-staleness "1 day"`: if no refresh pass completes for a day, the aggregate is no longer used.

## 3. Apply and fill

1. Commit `sales_lines__agg_1day.sql` to `../fraios/shared/schemas/clickhouse/` and apply the `CREATE TABLE` through the usual schema path.
2. Run a refresh pass. It builds every partition that is old enough and records what the aggregate holds:

```bash
node services/cubejs/scripts/aggregates.mjs refresh --only cst.sales_lines__agg_1day
```

3. Deploy the scheduled refresh job (`../fraios/infra/k8s/data/clickhouse/base/aggregate-refresh-cronjob.yaml`) at an interval well under one day.

## 4. Switch routing on

Set `AGGREGATE_ROUTING_ENABLED=true` on the cubejs query pods of the environment and restart them.

## 5. Check

Run a dashboard query that should qualify (revenue by month over the last twelve months, UTC) and look at the cubejs log for its request id:

```text
aggregate routing  requestId=…  cube=line_items  aggregate=cst.sales_lines__agg_1day
```

A query that does not qualify logs a reason instead, for example:

```text
aggregate routing  requestId=…  cube=line_items  reason=window_too_short
aggregate routing  requestId=…  cube=line_items  reason=member_unavailable:line_items.transactions:column_not_in_aggregate
```

Confirm what the consumer sees is unchanged in shape: the same member names and columns in the response, and the same model list from `/api/v1/meta`. The routed response has one extra header, and an unrouted one does not:

```text
x-synmetrix-aggregate-covered-until: 2026-11-01T00:00:00.000Z
```

Buckets that end at or before that time are complete; later ones may be missing or behind.

## 6. Verify equality

The engine tests compare both paths on a disposable ClickHouse:

```bash
cd services/cubejs
docker compose -f test/aggregates/docker-compose.clickhouse.yml up -d
yarn test:aggregates
```

## 7. Take an aggregate out of use

```sql
ALTER TABLE cst.sales_lines__agg_1day ON CLUSTER fraios MODIFY COMMENT '';
-- wait 60 seconds, then:
DROP TABLE cst.sales_lines__agg_1day ON CLUSTER fraios SYNC;
```

## What to expect

| Situation | Behaviour |
|---|---|
| Window entirely in months the aggregate holds | Answered from the aggregate; equals the source as of the last refresh |
| Last twelve months | Answered from the aggregate alone; held months are exact, the newest month or weeks are missing or behind |
| Today, the last seven days, the last thirty days | Reads the source (shorter than `min_window` and reaching the present) |
| A list of all values of a dimension | Answered from the aggregate; a value that exists only in data not yet held is missing until it is |
| Rows are re-loaded into an old month | That month is behind until the next refresh pass rebuilds it |
| The database merges an old month and removes duplicates | The next refresh pass rebuilds it; from then on it is exact |
| Query uses a member the aggregate cannot reproduce | Runs on the source; reason logged |
| Hourly bucket on a one-day aggregate | Runs on the source, or on a finer aggregate if one exists |
| Refresh job stopped for longer than `max_staleness` | The aggregate is no longer used; queries run on the source |
| Switch off | Nothing is probed or routed; behaviour identical to before |
