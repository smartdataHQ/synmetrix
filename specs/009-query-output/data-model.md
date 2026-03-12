# Data Model: Improved Query Output

**Feature**: 009-query-output
**Date**: 2026-03-12

## Entities

### OutputFormat (enum)

Serialization format applied to query results before returning to client.

| Value | Content-Type | Description |
|-------|-------------|-------------|
| `json` | `application/json` | Default — current behavior, row-per-object JSON |
| `csv` | `text/csv` | RFC 4180 CSV with header row |
| `jsonstat` | `application/json` | JSON-Stat 2.0 dataset |

**Validation**: Must be one of the enum values. Unknown values return 400 with supported formats listed.

### QueryResult

Raw output from database driver execution.

| Field | Type | Description |
|-------|------|-------------|
| rows | Array<Object> | Row-per-object results from `driver.query()` |
| columns | Array<string>\|null | Column names. Derived from: (1) first row keys if rows exist, (2) driver field metadata if available (e.g., `pg` result.fields), or (3) null if empty result with no metadata. |

**Note**: For ClickHouse CSV path, QueryResult is bypassed — raw bytes returned from database to client. ClickHouse always includes column names in `CSVWithNames` output even for empty results.

### JSONStatDataset

JSON-Stat 2.0 dataset built from query results. Conforms to https://json-stat.org/full/.

| Field | Type | Description |
|-------|------|-------------|
| version | string | Always `"2.0"` |
| class | string | Always `"dataset"` |
| id | Array<string> | Ordered dimension IDs |
| size | Array<number> | Category count per dimension |
| role | Object | **Dataset-level** role assignments: `{ time?: string[], geo?: string[], metric?: string[] }`. Each value is an array of dimension IDs. |
| dimension | Object | Dimension metadata keyed by dimension ID. Each value has `label`, `category`. |
| value | Array<number\|null> | Flat value array in row-major order |
| status | Object\|undefined | Optional sparse status map for null/missing values |
| extension | Object\|undefined | Optional metadata (warnings about heuristic inference, binary column omissions) |

**Relationships**:
- `id.length === size.length` (one size per dimension)
- `value.length === product(size)` (total observation count)
- Each dimension in `dimension` has `category.index` and `category.label`
- Dimension IDs in `role.time`, `role.metric`, etc. MUST exist in `id`

### Dimension (within JSONStatDataset.dimension)

| Field | Type | Description |
|-------|------|-------------|
| label | string | Human-readable dimension name |
| category | Object | `{ index: {id: position}, label: {id: label} }` |

**Note**: Roles are NOT on individual dimensions. They are assigned at the dataset level in `JSONStatDataset.role`. This conforms to the JSON-Stat 2.0 specification.

**Mapping from query results**:
- Columns listed in `timeDimensions` request hint → added to `role.time`
- Columns listed in `measures` request hint → modeled as categories of a metric-role dimension, added to `role.metric`
- Without hints: numeric columns inferred as measures, column name patterns (`year`, `date`, `month`, `quarter`, `period`) inferred as time. An `extension.warning` is included when heuristics are used.

### FormatRequest (request extension)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| format | OutputFormat | `"json"` | Desired output format |
| query | string | (required) | SQL query to execute |
| measures | string[]\|undefined | — | Column names that are measures (for JSON-Stat only). Enables exact dimension/measure classification. |
| timeDimensions | string[]\|undefined | — | Column names that are time dimensions (for JSON-Stat only). Enables exact `role.time` assignment. |

Added to the existing `POST /api/v1/run-sql` request body. `measures` and `timeDimensions` are ignored for `json` and `csv` formats.

### ExportState (frontend, transient)

UI state for the format export flow in the Explore page.

| Field | Type | Description |
|-------|------|-------------|
| selectedFormat | OutputFormat | User's chosen export format |
| isExporting | boolean | Whether an export is in progress |
| error | string\|null | Error message from failed export |

**Lifecycle**: Created when user opens the format selector on the **last-executed exploration** (not the current draft). Export always operates on the exploration that produced the currently visible results. Reset after download completes or error dismissal. Not persisted.

## State Transitions

None — this feature is stateless. Format is applied per-request to query results. No persistent state changes.

## No Database Schema Changes

This feature adds no tables, columns, or migrations. All changes are in the application layer (route handlers, response serialization).
