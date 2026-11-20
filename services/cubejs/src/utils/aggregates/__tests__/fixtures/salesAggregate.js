/**
 * The aggregate of test/aggregates/fixtures/sales_like.sql as the catalog
 * would describe it, for unit tests that have no database.
 */
import { classifyColumns, parseBinding, structureFingerprint } from "../../contract.js";

const saf = (fn, type) => `SimpleAggregateFunction(${fn}, ${type})`;
const key = (name, type) => ({ name, type, is_in_sorting_key: 1 });
const value = (name, type) => ({ name, type, is_in_sorting_key: 0 });

export const COLUMNS = [
  key("partition", "LowCardinality(String)"),
  key("timestamp", "DateTime64(3)"),
  key("sold_location", "LowCardinality(String)"),
  key("main_category", "LowCardinality(String)"),
  key("product_id", "String"),
  key("uom", "LowCardinality(String)"),
  key("bundled_units", "Nullable(Float32)"),
  key("unit_size", "Nullable(Float32)"),
  key("unit_price", "Nullable(Float64)"),
  key("is_volume_pack", "Bool"),
  value("units", saf("sum", "Float64")),
  value("units__count", saf("sum", "UInt64")),
  value("units__min", saf("min", "Float32")),
  value("units__max", saf("max", "Float32")),
  value("discount", saf("sum", "Nullable(Float64)")),
  value("discount__count", saf("sum", "UInt64")),
  value("quantity", saf("sum", "Float64")),
  value("metrics", saf("sumMap", "Map(String, Float64)")),
  value("_rows", saf("sum", "UInt64")),
];

/** @param {object} [patch] fields of the catalog's structure to override */
export function structure(columns = COLUMNS, name = "sales__agg_1day", patch = {}) {
  const { binding } = parseBinding(
    JSON.stringify({
      aggregate_of: "agg_test.sales", time_column: "timestamp", grain: "1 day",
      min_age: "0 second", min_window: "60 day", max_staleness: "1 day",
    }),
  );
  return {
    table: `agg_test.${name}`,
    name,
    ...binding,
    partitionKey: "(partition, toStartOfMonth(timestamp))",
    sortingKey: columns.filter((column) => column.is_in_sorting_key).map((column) => column.name).join(", "),
    primaryKey: columns.filter((column) => column.is_in_sorting_key).map((column) => column.name).join(", "),
    storagePolicy: "default",
    totalRows: 7200,
    verifiedAt: null,
    coveredUntil: null,
    columns: classifyColumns(columns, binding),
    fingerprint: structureFingerprint(binding, columns),
    ...patch,
  };
}
