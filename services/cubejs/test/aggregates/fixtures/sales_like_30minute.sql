-- A second, finer aggregate of the source in sales_like.sql (load that first).

CREATE TABLE agg_test.sales__agg_30minute
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
    quantity SimpleAggregateFunction(sum, Float64),
    metrics SimpleAggregateFunction(sumMap, Map(String, Float64)),
    _rows SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY (partition, toStartOfMonth(timestamp))
ORDER BY (partition, timestamp, sold_location, main_category, product_id, uom, bundled_units, unit_size, unit_price, is_volume_pack)
SETTINGS allow_nullable_key = 1
COMMENT '{"aggregate_of": "agg_test.sales", "time_column": "timestamp", "grain": "30 minute", "min_age": "0 second", "min_window": "60 day", "max_staleness": "1 day"}';
