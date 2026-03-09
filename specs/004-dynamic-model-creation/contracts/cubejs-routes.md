# CubeJS Route Contracts: Dynamic Model Creation

## New Route: POST /api/v1/profile-table

**Purpose**: Profile a ClickHouse table — introspect schema and data characteristics.

**Authentication**: Requires valid JWT and `x-hasura-datasource-id` header (standard CubeJS auth via `checkAuth`).

### Request

```json
{
  "table": "semantic_events",
  "schema": "cst",
  "branchId": "uuid-branch-id"
}
```

**`branchId`** (required): Needed to look up existing model files on this branch for merge option defaults. Also ensures the security context resolves the correct branch (Decision 10).

### Response (200 OK)

```json
{
  "database": "cst",
  "table": "semantic_events",
  "partition": "brimborg.is",
  "row_count": 1500000,
  "sampled": true,
  "sample_size": 100000,
  "primary_keys": ["entity_gid"],
  "existing_model": {
    "file_name": "semantic_events.yml",
    "file_format": "yml",
    "has_user_content": true,
    "supports_reprofile": true,
    "suggested_merge_strategy": "merge"
  },
  "columns": [
    {
      "name": "entity_gid",
      "raw_type": "String",
      "column_type": "BASIC",
      "value_type": "STRING",
      "has_values": true,
      "unique_values": 45000,
      "unique_keys": null,
      "lc_values": null
    },
    {
      "name": "metrics",
      "raw_type": "Map(String, Float64)",
      "column_type": "MAP",
      "value_type": "NUMBER",
      "has_values": true,
      "unique_values": null,
      "unique_keys": ["revenue", "clicks", "impressions"],
      "lc_values": null
    },
    {
      "name": "event_type",
      "raw_type": "LowCardinality(String)",
      "column_type": "BASIC",
      "value_type": "STRING",
      "has_values": true,
      "unique_values": 5,
      "unique_keys": null,
      "lc_values": {"event_type": ["page_view", "identify", "track", "purchase", "screen"]}
    }
  ],
  "array_candidates": [
    {
      "column": "commerce.products",
      "element_type": "Map(String, String)",
      "suggested_alias": "products"
    }
  ]
}
```

### Response (400/500)

```json
{
  "error": "Profiling failed: connection timeout on column 'large_map'"
}
```

**`existing_model`** (null if no model file for this table exists on the branch):
- `file_name`: Current model filename (e.g., `semantic_events.yml` or `semantic_events.js`)
- `file_format`: `"yml"` or `"js"` — allows UI to warn about JS→YAML replacement
- `has_user_content`: Whether the existing model has user content (for merge option defaults)
- `supports_reprofile`: Whether the model has provenance metadata (smart-generated)
- `suggested_merge_strategy`: Backend recommendation based on existing model state (`"auto"`, `"merge"`, or `"replace"`)

### Behavior

1. Creates driver via `driverFactory({ securityContext })`
2. Resolves team settings from security context (partition, internal tables)
3. Fetches existing dataschemas for the branch to populate `existing_model` info
4. Runs `SELECT count() FROM {schema}.{table}` to get total row count
5. Runs `DESCRIBE TABLE {schema}.{table}` — schema analysis pass
6. If table is internal and team has partition configured, all profiling queries include `WHERE partition IN ('{value}')`
7. If row count exceeds sampling threshold (default 1M rows), profiling queries use ClickHouse `SAMPLE` clause for statistical accuracy without full table scan
8. Runs batched SELECT queries (10 columns per batch) — data profiling pass (with sampling if applicable)
9. Detects primary keys from `system.tables`
10. Identifies array candidates (Array-typed columns)
11. Runs LC probe for columns with <200 unique values
12. Returns ProfiledTable JSON (includes `sampled: true` and `sample_size` when sampling was used)
13. On per-column failure: continues with remaining columns, reports failures in response

---

## New Route: POST /api/v1/smart-generate

**Purpose**: Profile table, generate YAML model, merge with existing, save as new version.

**Authentication**: Same as profile-table.

### Request

```json
{
  "table": "semantic_events",
  "schema": "cst",
  "branchId": "uuid-branch-id",
  "arrayJoinColumns": [
    { "column": "commerce.products", "alias": "products" }
  ],
  "maxMapKeys": 500,
  "mergeStrategy": "auto"
}
```

**`mergeStrategy`** (optional, default `"auto"`):
- `"auto"`: Smart default — merge if existing model has user content (custom fields, edited descriptions, joins, pre_aggregations, segments); replace if no user content detected.
- `"merge"`: Always merge. Preserve all user content, update only auto-generated fields. Stale auto fields are removed, new ones added.
- `"replace"`: Full replace. Discard all existing content (user fields, joins, etc.) and write a clean smart-generated model. Previous version preserved in history.
- `"merge_keep_stale"`: Like `"merge"`, but do NOT remove auto-generated fields for columns no longer in the data. Useful when columns are temporarily empty or renamed.

### Response (200 OK)

```json
{
  "code": "ok",
  "message": "Smart generation complete: 45 dimensions, 12 measures, 2 cubes",
  "version_id": "uuid-new-version-id",
  "file_name": "semantic_events.yml",
  "changed": true,
  "profile_summary": {
    "row_count": 1500000,
    "columns_profiled": 28,
    "columns_skipped": 2,
    "map_keys_discovered": 156,
    "array_candidates": 3
  },
  "model_summary": {
    "dimensions_count": 45,
    "measures_count": 12,
    "cubes_count": 2
  }
}
```

**Response fields**:
- `version_id`: ID of the newly created version (null when `changed: false`)
- `file_name`: Name of the generated/updated model file
- `changed`: `false` when checksum matches existing version (FR-014) — no new version created
```

### Behavior

1. Profiles the table (same as profile-table route)
2. Builds cube JS objects from profiling results:
   - RAW cube: all profiled columns → dimensions/measures
   - Flattened cubes: one per selected array join column
3. Adds `meta.auto_generated: true` to all generated fields
4. Adds provenance metadata to cube-level `meta` (source_database, source_table, source_partition, generated_at)
5. Serializes to YAML via `yaml.stringify()`
6. Fetches existing dataschemas for the branch (`findDataSchemas`)
7. If model file for this table exists:
   - Parses existing YAML
   - Applies `mergeStrategy` (default `"auto"`):
     - `"auto"`: Detects user content (fields without `auto_generated`, edited descriptions, `joins`/`pre_aggregations`/`segments` blocks). If found → merge. If not → replace.
     - `"merge"`: Always merge — preserve user content, update auto fields, remove stale auto fields, add new auto fields.
     - `"replace"`: Discard existing model entirely, write fresh generation.
     - `"merge_keep_stale"`: Like merge, but retain auto fields for columns no longer in data.
   - In all merge modes: `joins`, `pre_aggregations`, `segments` are always preserved (never auto-generated).
8. If checksum matches existing version: returns without creating new version (FR-014)
9. Creates new version via `createDataSchema` (existing Hasura mutation)
10. Purges compiler cache (`compilerCache.purgeStale()`)
11. Returns generation summary

---

## Existing Route Changes

### Partition Isolation via `sql` with WHERE clause (in yamlGenerator)

**Decision**: Partition filtering is embedded in the generated YAML model by using `sql` (with a WHERE clause) instead of `sql_table`, NOT in `queryRewrite()`. Note: `sql_where` is NOT a valid Cube.dev property.

**Why not queryRewrite**: The existing `queryRewrite.js` has an early return for owner/admin roles (line 26-28) that bypasses all checks. Placing partition filtering there would allow owners/admins to bypass partition isolation. Additionally, `internalTables.includes(cubeName)` matching is brittle for flattened ARRAY JOIN cubes whose names differ from the source table.

**Generated YAML output** (when table is internal and team has partition configured):

```yaml
cubes:
  - name: semantic_events
    sql: "SELECT * FROM cst.semantic_events WHERE partition = 'brimborg.is'"
    meta:
      auto_generated: true
      source_database: cst
      source_table: semantic_events
      source_partition: brimborg.is
      generated_at: "2026-03-08T12:00:00Z"
```

**Generated YAML output** (non-partitioned or non-internal table):

```yaml
cubes:
  - name: semantic_events
    sql_table: cst.semantic_events
    meta:
      auto_generated: true
      source_database: cst
      source_table: semantic_events
      generated_at: "2026-03-08T12:00:00Z"
```

**Behavior**: The `yamlGenerator.js` module checks whether the source table is in the team's `internal_tables` list and a partition value exists. If so, it generates the cube with `sql` (including a WHERE clause) instead of `sql_table`. Non-internal or non-partitioned tables use `sql_table` as normal. On re-profile, the `sql`/`sql_table` choice is regenerated from current team settings. `queryRewrite.js` is NOT modified for this feature.

### queryRewrite.js — No Changes

The existing `queryRewrite.js` remains unchanged. Partition isolation is handled entirely by `sql` with WHERE clause in the generated model. The owner/admin early-return bypass (line 26-28) is unaffected.

### Filename Convention

Smart-generated model files use `{table_name}.yml` (e.g., `semantic_events.yml`). If schema prefix is needed to avoid cross-database collisions, use `{schema}_{table_name}.yml`. This allows the merger to locate existing models by table name during re-profile.

### buildSecurityContext.js Extension

Add `partition` and `internalTables` to the security context hash to ensure cache isolation between tenants with different partition values.

### defineUserScope.js Extension

Extract `partition` and `internal_tables` from the user's team settings and pass them through to the security context.

---

## SSE Progress Streaming

Both `/api/v1/profile-table` and `/api/v1/smart-generate` support Server-Sent Events (SSE) for real-time progress feedback.

**Trigger**: When the request includes `Accept: text/event-stream` header, the route streams progress events instead of returning a single JSON response. Without this header, routes behave as standard synchronous JSON endpoints.

**Authentication**: Same JWT auth via `checkAuth` — the frontend already calls CubeJS directly for other `/api/v1/*` endpoints.

### Event Format

```
event: progress
data: {"step":"schema_analysis","message":"Analyzing table schema...","progress":0.05}

event: progress
data: {"step":"profiling","message":"Profiling columns 1-10 of 28...","progress":0.25,"detail":{"batch":1,"total_batches":3}}

event: progress
data: {"step":"profiling","message":"Profiling columns 11-20 of 28...","progress":0.50,"detail":{"batch":2,"total_batches":3}}

event: progress
data: {"step":"lc_probe","message":"Discovering low-cardinality values...","progress":0.70}

event: progress
data: {"step":"pk_detection","message":"Detecting primary keys...","progress":0.75}

event: progress
data: {"step":"building","message":"Building cube definitions...","progress":0.80}

event: progress
data: {"step":"merging","message":"Merging with existing model...","progress":0.85}

event: progress
data: {"step":"saving","message":"Saving new version...","progress":0.95}

event: complete
data: {"code":"ok","message":"Smart generation complete: 45 dimensions, 12 measures","profile_summary":{...},"model_summary":{...}}
```

**Error event** (terminates stream):
```
event: error
data: {"error":"Profiling failed: connection timeout","step":"profiling"}
```

### Progress Steps

| Step | Route | Description |
|------|-------|-------------|
| `schema_analysis` | Both | DESCRIBE TABLE parsing |
| `profiling` | Both | Batched column profiling (reports batch N of M) |
| `lc_probe` | Both | Low-cardinality value enumeration |
| `pk_detection` | Both | Primary key detection from system.tables |
| `building` | smart-generate only | Converting profiled data to cube objects |
| `yaml_generation` | smart-generate only | Serializing cubes to YAML |
| `merging` | smart-generate only | Merging with existing model (if applicable) |
| `saving` | smart-generate only | Creating new version via Hasura |

### Implementation

The `progressEmitter` utility (`services/cubejs/src/utils/smart-generation/progressEmitter.js`) provides a consistent interface:

```javascript
// Usage in route handler:
const emitter = createProgressEmitter(res, req.headers.accept);
emitter.emit('schema_analysis', 'Analyzing table schema...', 0.05);
// ... do work ...
emitter.emit('profiling', `Profiling columns ${start}-${end} of ${total}...`, progress, { batch, total_batches });
// ... when done ...
emitter.complete(responsePayload);
// On error:
emitter.error('Profiling failed: connection timeout', 'profiling');
```

When `Accept` is not `text/event-stream`, the emitter is a no-op and the route returns standard JSON via `res.json()`. This keeps the routes SSE-agnostic — a single code path handles both modes.
