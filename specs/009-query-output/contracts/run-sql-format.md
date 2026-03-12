# Contract: run-sql Format Parameter

**Endpoint**: `POST /api/v1/run-sql`
**Service**: CubeJS (`services/cubejs/src/routes/runSql.js`)

## Request

Extends existing request body with optional `format` field and JSON-Stat hints.

```json
{
  "query": "SELECT country, year, sum(revenue) as revenue FROM sales GROUP BY country, year",
  "format": "jsonstat",
  "measures": ["revenue"],
  "timeDimensions": ["year"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| query | string | yes | — | SQL query to execute |
| format | string | no | `"json"` | Output format: `"json"`, `"csv"`, `"jsonstat"` |
| measures | string[] | no | — | SQL column aliases that are measures (used for JSON-Stat dimension/measure classification). Without this, the system infers from data types with a heuristic warning. Must be actual SQL aliases (e.g., `orders__count`), not semantic member names (e.g., `Orders.count`). |
| timeDimensions | string[] | no | — | SQL column aliases that are time dimensions (used for JSON-Stat `role.time` assignment). Without this, the system infers from column name patterns. Must be actual SQL aliases. |

**Note**: `measures` and `timeDimensions` are only used when `format=jsonstat`. They are ignored for `json` and `csv` formats. When the frontend exports via the gen_sql → run-sql chain, it MUST pass these hints using the SQL column aliases from gen_sql's `column_metadata` response (not the semantic member names from playground state).

**Headers** (existing, unchanged):
- `Authorization: Bearer {jwt}` — required
- `x-hasura-datasource-id: {uuid}` — required
- `x-hasura-branch-id: {uuid}` — optional
- `x-hasura-branch-version-id: {uuid}` — optional

## Response: JSON (default)

**Status**: 200
**Content-Type**: `application/json`

```json
[
  {"id": 1, "name": "Alice", "created_at": "2026-01-01"},
  {"id": 2, "name": "Bob", "created_at": "2026-01-02"}
]
```

Unchanged from current behavior.

## Response: CSV

**Status**: 200
**Content-Type**: `text/csv`
**Content-Disposition**: `attachment; filename="query-result.csv"`

```csv
id,name,created_at
1,Alice,2026-01-01
2,Bob,2026-01-02
```

- RFC 4180 compliant
- Header row with column names
- Values containing commas, quotes, or newlines are properly escaped
- For ClickHouse: returned via native `FORMAT CSVWithNames` (full response loaded into memory in P1 MVP; upgraded to true streaming in P3/US6)
- For other databases: serialized row-by-row from driver results
- Empty result set: ClickHouse returns header-only CSV natively. For other databases where `driver.query()` returns `[]` with no column metadata, the response is an empty body with `Content-Length: 0` (see Metadata Strategy below).

## Response: JSON-Stat

**Status**: 200
**Content-Type**: `application/json`
**Content-Disposition**: `attachment; filename="query-result.json"`

```json
{
  "version": "2.0",
  "class": "dataset",
  "id": ["country", "year", "metric"],
  "size": [3, 2, 1],
  "role": {
    "time": ["year"],
    "metric": ["metric"]
  },
  "dimension": {
    "country": {
      "label": "country",
      "category": {
        "index": {"US": 0, "UK": 1, "DE": 2},
        "label": {"US": "US", "UK": "UK", "DE": "DE"}
      }
    },
    "year": {
      "label": "year",
      "category": {
        "index": {"2025": 0, "2026": 1},
        "label": {"2025": "2025", "2026": "2026"}
      }
    },
    "metric": {
      "label": "metric",
      "category": {
        "index": {"revenue": 0},
        "label": {"revenue": "Revenue"}
      }
    }
  },
  "value": [100, 110, 200, 210, 300, 310]
}
```

- Conforms to JSON-Stat 2.0 specification (https://json-stat.org/full/)
- **Roles are at the dataset level** in the `role` object — NOT on individual dimensions. `role.time` is an array of dimension IDs with time semantics; `role.metric` is an array of dimension IDs representing measures.
- Measures modeled as categories of a metric-role dimension
- Values in row-major order
- Nulls represented as `null` in value array
- When `measures` and `timeDimensions` hints are provided in the request, classification is exact. Without hints, the system uses heuristics (numeric columns → measures, column name patterns → time) and includes `"extension": { "warning": "Dimension/measure classification was inferred from data types. Pass measures and timeDimensions for exact results." }`.

## Empty Result Metadata Strategy

Column names for empty results depend on the driver:

| Driver | Empty Result Behavior | CSV Response |
|--------|----------------------|--------------|
| ClickHouse (`FORMAT CSVWithNames`) | Header row always included by database | Header-only CSV |
| Drivers with field metadata (e.g., `pg` returns `result.fields`) | Column names available | Header-only CSV |
| Drivers returning only `[]` with no metadata | Column names unknown | Empty body (`Content-Length: 0`) |

For JSON-Stat with empty results: return a valid dataset with empty `value: []` array and empty category indices. If column names are unknown, return `400` with `"Cannot produce JSON-Stat without column metadata for empty result sets. Re-run with at least one row or provide column hints."`.

## Error Responses

**Unsupported format** (400):
```json
{
  "error": "Unsupported format: xml. Supported formats: json, csv, jsonstat"
}
```

**SQL API blocked** (403) — existing behavior, unchanged:
```json
{
  "code": "sql_api_blocked",
  "message": "SQL API access is not available for teams with active access control rules..."
}
```

**Auth errors** (401/403/404) — existing behavior, unchanged.
