# Contract: jsonstat-toolkit Extensions

**Package**: `smartdataHQ/toolkit` (fork of `jsonstat/toolkit` v2.2.2)
**Language**: JavaScript (ESM + CJS)

## New Methods

### `JSONstat.fromRows(columns, rows, options?)` — Static Factory

Builds a JSON-Stat 2.0 dataset directly from database result sets.

```javascript
const dataset = JSONstat.fromRows(
  ["country", "year", "revenue"],       // column names
  [
    ["US", "2025", 100],
    ["US", "2026", 110],
    ["UK", "2025", 200],
  ],
  {
    measures: ["revenue"],               // which columns are measures
    timeDimensions: ["year"],            // which columns are time dimensions
  }
);

dataset.class    // "dataset"
dataset.version  // "2.0"
dataset.id       // ["country", "year", "metric"]
dataset.value    // [100, 110, 200]
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| columns | string[] | yes | Column names from database result |
| rows | any[][] | yes | Row arrays (columnar order matching `columns`) |
| options.measures | string[] | no | Column names that are measures (default: inferred from numeric data types with heuristic warning) |
| options.timeDimensions | string[] | no | Column names to assign as time dimensions |

**Returns**: JSONstat Dataset instance

**Role assignment**: Roles are assigned at the **dataset level** per JSON-Stat 2.0 specification — `dataset.role.time` contains dimension IDs with time semantics, `dataset.role.metric` contains the metric dimension ID. Roles are NOT placed on individual dimension objects. When `options.measures` is provided, classification is exact. Without hints, numeric columns are inferred as measures and column name patterns (`year`, `date`, `month`, `quarter`, `period`) are inferred as time, with an `extension.warning` included.

### `dataset.toCSV(options?)` — Instance Method

Produces CSV directly from the flat value array and dimension metadata without intermediate tabular conversion.

```javascript
const csv = dataset.toCSV();
// "country,year,revenue\nUS,2025,100\nUS,2026,110\nUK,2025,200\n"

const csv2 = dataset.toCSV({ delimiter: "\t" });
// "country\tyear\trevenue\nUS\t2025\t100\n..."
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| options.delimiter | string | no | Field delimiter (default: `","`) |
| options.header | boolean | no | Include header row (default: `true`) |

**Returns**: string (CSV content)

### `dataset.unflattenIterator()` — Instance Method (Streaming)

Yields rows one at a time from the flat value array without collecting all results into an array.

```javascript
for (const row of dataset.unflattenIterator()) {
  // row = { country: "US", year: "2025", revenue: 100 }
  process(row);
}
```

**Returns**: Generator<Object> — yields one row-object per observation

## Performance Optimizations (Internal)

These changes affect internal behavior only — no API surface changes:

| Optimization | Method | Before | After |
|---|---|---|---|
| Category reverse-lookup | `toTable()` | O(categories²) per dimension | O(1) via pre-built position→ID map |
| Label expansion | `toTable()` | Pre-allocates full arrays | Computed on-the-fly via modular arithmetic |
| Dice materialization | `Dice()` | Converts entire dataset to tabular | Direct iteration via Unflatten |
| Deep clone | `Dice()` | `JSON.parse(JSON.stringify())` | Structured clone |
| Per-cell Category | `Transform()` | Full Category() resolution | Lightweight label-only cache |
| Sparse expansion | `normalize()` | Full-length array allocation | Sparse-aware (proportional to actual values) |
| Metadata cache | `Data()` | Re-scans dimensions per call | Coordinate→dimension cache |

## Compatibility

- All existing upstream tests (~80) must pass without modification
- All existing public API methods maintain identical behavior
- New methods are additive only — no breaking changes
