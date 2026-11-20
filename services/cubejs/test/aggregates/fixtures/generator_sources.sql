-- Three synthetic source tables for the generator tests. Their column types,
-- keys and partitioning follow three real tables of different shape (a wide
-- sales table, a narrow series table built on maps, a very wide event table
-- built on arrays); the real definitions are not kept in this repository.
-- Plain MergeTree and no row expiry, so a source cannot change under a test.

DROP DATABASE IF EXISTS gen_test SYNC;

CREATE DATABASE gen_test;

CREATE TABLE gen_test.retail_lines
(
    `entity_gid` LowCardinality(UUID),
    `partition` LowCardinality(String),
    `timestamp` DateTime64(3),
    `business_day` LowCardinality(Date),
    `event_gid` UUID,
    `position` UInt16,
    `checkout_id` String,
    `customer_id` Nullable(String),
    `store` LowCardinality(String),
    `store_id` LowCardinality(String),
    `category` LowCardinality(String),
    `product_id` String,
    `product` LowCardinality(String),
    `uom` LowCardinality(String),
    `tax_rate` LowCardinality(Float32),
    `is_return` Nullable(Bool),
    `is_volume_pack` Nullable(Bool),
    `delivered_at` Nullable(DateTime64(3)),
    `units` Nullable(Float32),
    `bundled_units` Nullable(Float32),
    `unit_price` Nullable(Float64),
    `unit_cost` Nullable(Float64),
    `discount` Nullable(Float64),
    `points` Nullable(Int32),
    `scans` UInt32 DEFAULT 1,
    `dimensions` Map(LowCardinality(String), LowCardinality(String)),
    `metrics` Map(LowCardinality(String), Float32),
    `flags` Map(LowCardinality(String), Bool),
    `properties` JSON,
    `loaded_at` DateTime64(3) DEFAULT now64(3),
    `quantity` Float64 ALIAS toFloat64(units * ifNull(bundled_units, 1)),
    `revenue` Float64 ALIAS quantity * unit_price,
    `cost` Float64 ALIAS quantity * unit_cost,
    `margin` Float64 ALIAS revenue - cost,
    `store_label` String ALIAS concat(store_id, ' ', store)
)
ENGINE = MergeTree
PARTITION BY (partition, toStartOfMonth(timestamp))
ORDER BY (entity_gid, store_id, product_id, event_gid, checkout_id, timestamp, position)
SETTINGS allow_suspicious_low_cardinality_types = 1;

CREATE TABLE gen_test.series_points
(
    `series_gid` LowCardinality(UUID),
    `entity_gid` LowCardinality(UUID),
    `partition` LowCardinality(String),
    `period` LowCardinality(String),
    `timestamp` DateTime64(3, 'UTC'),
    `valid_until` Nullable(DateTime64(3, 'UTC')),
    `signature` UUID,
    `access` Enum8('Local' = 1, 'Group' = 2, 'Shared' = 3, 'Public' = 4),
    `source` LowCardinality(String),
    `unit` LowCardinality(String),
    `revision` UInt8,
    `tags` Array(LowCardinality(String)),
    `location` Point,
    `labels` Map(LowCardinality(String), LowCardinality(String)),
    `owners` Map(LowCardinality(String), LowCardinality(UUID)),
    `flags` Map(LowCardinality(String), Bool),
    `metrics` Map(LowCardinality(String), Float64),
    `counters` Map(String, UInt32),
    `context` JSON,
    `loaded_at` DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY (partition, toYYYYMM(timestamp))
ORDER BY (series_gid, entity_gid, period, timestamp, signature, partition);

CREATE TABLE gen_test.wide_events
(
    `entity_gid` UUID,
    `partition` LowCardinality(String),
    `type` LowCardinality(String),
    `event` LowCardinality(String),
    `timestamp` DateTime64(3) CODEC(Delta(8), ZSTD(1)),
    `event_gid` UUID,
    `session_id` Nullable(String) CODEC(ZSTD(1)),
    `user_id` Nullable(UUID),
    `ip` Nullable(IPv4),
    `country` LowCardinality(String),
    `device` LowCardinality(String),
    `birthday` Nullable(Date),
    `is_bot` Nullable(Bool),
    `duration_ms` Nullable(Int64),
    `scroll_depth` Nullable(Float64),
    `revenue` Nullable(Float64),
    `amount` Decimal(18, 4),
    `sequence` Int32,
    `product_ids` Array(LowCardinality(String)),
    `product_names` Array(Nullable(String)),
    `product_prices` Array(Nullable(Float64)),
    `product_units` Array(Nullable(Int32)),
    `product_gids` Array(Nullable(UUID)),
    `product_added_at` Array(Nullable(DateTime64(3))),
    `involved_gids` Array(UUID),
    `traits` Map(LowCardinality(String), String),
    `switches` Map(LowCardinality(String), Bool),
    `measurements` Map(LowCardinality(String), Float64),
    `note` String
)
ENGINE = MergeTree
PARTITION BY (partition, toStartOfMonth(timestamp))
ORDER BY (entity_gid, type, event, timestamp, event_gid);
