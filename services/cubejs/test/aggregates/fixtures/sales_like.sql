-- A source shaped like the first candidate (a replacing table, partitioned by
-- tenant and month) with one aggregate at day grain and the refresh records.
-- Four months of 2026 for two tenants. The newest month holds every row twice,
-- unmerged: merges are stopped so that a plain read keeps seeing both copies
-- until a test lets the database merge.

DROP DATABASE IF EXISTS agg_test SYNC;

CREATE DATABASE agg_test;

CREATE TABLE agg_test.sales
(
    partition LowCardinality(String),
    timestamp DateTime64(3),
    event_gid String,
    position UInt16,
    sold_location LowCardinality(String),
    main_category LowCardinality(String),
    product_id String,
    uom LowCardinality(String),
    bundled_units Nullable(Float32),
    unit_size Nullable(Float32),
    unit_price Nullable(Float64),
    is_volume_pack Bool,
    units Float32,
    discount Nullable(Float64),
    checkout_id String,
    metrics Map(LowCardinality(String), Float32),
    loaded_at DateTime64(3),
    quantity Float64 ALIAS toFloat64(units * ifNull(bundled_units, 1))
)
ENGINE = ReplacingMergeTree(loaded_at)
PARTITION BY (partition, toStartOfMonth(timestamp))
ORDER BY (partition, sold_location, product_id, event_gid, timestamp, position);

SYSTEM STOP MERGES agg_test.sales;

INSERT INTO agg_test.sales
    (partition, timestamp, event_gid, position, sold_location, main_category, product_id, uom, bundled_units, unit_size,
     unit_price, is_volume_pack, units, discount, checkout_id, metrics, loaded_at)
SELECT
    ['t1', 't2'][1 + intDiv(number, 30) % 2],
    toDateTime64('2026-01-01 00:00:00', 3, 'UTC') + toIntervalSecond(number * 259),
    toString(number),
    number % 3,
    concat('store', toString(intDiv(number, 10) % 3)),
    ['food', 'drink', 'home'][1 + (number % 10) % 3],
    concat('p', toString(number % 10)),
    ['pc', 'kg', 'd', 'wk'][1 + (number % 10) % 4],
    if((number % 10) % 5 = 0, NULL, 1 + (number % 10) % 3),
    if((number % 10) = 7, NULL, 0.5 + (number % 10) % 4),
    if((number % 10) = 9, NULL, 10 + (number % 10)),
    (number % 10) % 2 = 0,
    1 + (number % 5) * 0.5,
    if(number % 4 = 0, NULL, (number % 7) * 0.25),
    concat('c', toString(intDiv(number, 3))),
    if(number % 3 = 0, map('weight', (number % 9) * 0.5), map('weight', (number % 9) * 0.5, 'volume', number % 2)),
    toDateTime64('2026-05-01 00:00:00', 3, 'UTC')
FROM numbers(40000);

INSERT INTO agg_test.sales
    (partition, timestamp, event_gid, position, sold_location, main_category, product_id, uom, bundled_units, unit_size,
     unit_price, is_volume_pack, units, discount, checkout_id, metrics, loaded_at)
SELECT partition, timestamp, event_gid, position, sold_location, main_category, product_id, uom, bundled_units, unit_size,
       unit_price, is_volume_pack, units, discount, checkout_id, metrics, loaded_at + toIntervalSecond(1)
FROM agg_test.sales
WHERE toStartOfMonth(timestamp) = '2026-04-01';

CREATE TABLE agg_test.sales__agg_1day
(
    partition LowCardinality(String),
    timestamp DateTime64(3),
    sold_location LowCardinality(String),
    main_category LowCardinality(String),
    product_id String,
    uom LowCardinality(String),
    bundled_units Nullable(Float32),
    unit_size Nullable(Float32),
    unit_price Nullable(Float64),
    is_volume_pack Bool,
    units SimpleAggregateFunction(sum, Float64),
    units__count SimpleAggregateFunction(sum, UInt64),
    units__min SimpleAggregateFunction(min, Float32),
    units__max SimpleAggregateFunction(max, Float32),
    discount SimpleAggregateFunction(sum, Nullable(Float64)),
    discount__count SimpleAggregateFunction(sum, UInt64),
    discount__min SimpleAggregateFunction(min, Nullable(Float64)),
    discount__max SimpleAggregateFunction(max, Nullable(Float64)),
    quantity SimpleAggregateFunction(sum, Float64),
    metrics SimpleAggregateFunction(sumMap, Map(String, Float64)),
    _rows SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY (partition, toStartOfMonth(timestamp))
ORDER BY (partition, timestamp, sold_location, main_category, product_id, uom, bundled_units, unit_size, unit_price, is_volume_pack)
SETTINGS allow_nullable_key = 1
COMMENT '{"aggregate_of": "agg_test.sales", "time_column": "timestamp", "grain": "1 day", "min_age": "0 second", "min_window": "60 day", "max_staleness": "1 day"}';

CREATE TABLE agg_test.aggregate_state
(
    aggregate String,
    partition_id String,
    fingerprint UInt64,
    verified_at DateTime('UTC'),
    covered_until DateTime64(3, 'UTC'),
    updated_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (aggregate, partition_id);
