# API Contracts: Dynamic Models II

**Branch**: `010-dynamic-models-ii` | **Date**: 2026-03-15

## Modified Endpoints

### POST /api/v1/profile-table (CubeJS)

**Change**: Add `filters` parameter to request body.

**Request body additions**:
```json
{
  "table": "events",
  "schema": "default",
  "branchId": "uuid",
  "filters": [
    { "column": "country", "operator": "=", "value": "US" },
    { "column": "event_date", "operator": ">=", "value": "2025-01-01" },
    { "column": "status", "operator": "IN", "value": ["active", "pending"] },
    { "column": "deleted_at", "operator": "IS NULL", "value": null }
  ]
}
```

**Response additions**: Profile statistics reflect the filtered subset. When an existing model is found for the table/branch, the response includes:
```json
{
  "previous_filters": [
    { "column": "country", "operator": "=", "value": "US" }
  ]
}
```
`previous_filters` is extracted from the existing model's `meta.generation_filters`. Null/absent if no existing model or no stored filters. The frontend uses this to pre-populate the filter builder before profiling starts.

---

### POST /api/v1/smart-generate (CubeJS)

**Change**: Add `filters` parameter. Response gains AI metric information.

**Request body additions**:
```json
{
  "table": "events",
  "schema": "default",
  "branchId": "uuid",
  "filters": [
    { "column": "country", "operator": "=", "value": "US" }
  ],
  "arrayJoinColumns": [],
  "maxMapKeys": 500,
  "mergeStrategy": "auto",
  "profileData": null,
  "dryRun": false
}
```

**Response additions**:
```json
{
  "code": "ok",
  "message": "Smart generation complete: 45 dimensions, 8 measures, 5 AI metrics, 2 cubes",
  "version_id": "uuid",
  "file_name": "events.js",
  "changed": true,
  "change_preview": {
    "fields_added": [],
    "fields_updated": [],
    "fields_removed": [],
    "fields_preserved": [],
    "blocks_preserved": [],
    "ai_metrics_added": [
      {
        "name": "avg_revenue_per_user",
        "type": "number",
        "member_type": "measure",
        "ai_generation_context": "Average revenue per unique user, calculated from revenue and user_id columns"
      }
    ],
    "ai_metrics_retained": [],
    "ai_metrics_removed": [],
    "summary": "Adding 3 fields, 5 AI metrics. Preserving 2 user fields and joins."
  },
  "ai_enrichment": {
    "status": "success",
    "model": "gpt-5.4",
    "metrics_count": 5,
    "error": null
  },
  "previous_filters": [
    { "column": "country", "operator": "=", "value": "US" }
  ]
}
```

---

## Modified GraphQL Actions

### smart_gen_dataschemas (Hasura Action → Actions RPC)

**Change**: Add `filters` input parameter.

**GraphQL schema addition**:
```graphql
input FilterConditionInput {
  column: String!
  operator: String!
  value: jsonb  # Hasura transport type; backend normalizes to string | number | string[] | number[] | null
}

# Updated mutation
mutation SmartGenDataSchemas(
  $datasource_id: uuid!
  $branch_id: uuid!
  $table_name: String!
  $table_schema: String!
  $array_join_columns: [ArrayJoinInput]
  $max_map_keys: Int
  $merge_strategy: String
  $profile_data: jsonb
  $dry_run: Boolean
  $filters: [FilterConditionInput]     # NEW
) {
  smart_gen_dataschemas(
    datasource_id: $datasource_id
    branch_id: $branch_id
    table_name: $table_name
    table_schema: $table_schema
    array_join_columns: $array_join_columns
    max_map_keys: $max_map_keys
    merge_strategy: $merge_strategy
    profile_data: $profile_data
    dry_run: $dry_run
    filters: $filters                  # NEW
  ) {
    code
    message
    version_id
    file_name
    changed
    change_preview
    ai_enrichment          # NEW: {status, model, metrics_count, error}
    previous_filters       # NEW: filters from existing model (for pre-population)
  }
}
```

### Profile table SSE endpoint (direct CubeJS, bypasses Hasura)

**Change**: The frontend profiles tables via direct SSE to `POST /api/v1/profile-table` (not through Hasura). This endpoint MUST also accept `filters` in the request body and pass them through to the profiler. The `filters` parameter is sent as JSON in the SSE request body alongside `table`, `schema`, and `branchId`.
```

---

## Model File Contract (Cube.js JS/YAML)

### New meta fields on cube level

```javascript
cube(`events`, {
  sql_table: `default.events`,

  meta: {
    auto_generated: true,
    source_database: 'default',
    source_table: 'events',
    generated_at: '2026-03-15T10:30:00Z',
    // NEW: filters applied during generation
    generation_filters: [
      { column: 'country', operator: '=', value: 'US' }
    ],
    // NEW: AI enrichment status
    ai_enrichment_status: 'success',
    ai_metrics_count: 5,
  },

  dimensions: {
    // ... profiler-generated dimensions (unchanged) ...
  },

  measures: {
    count: {
      sql: `*`,
      type: `count`,
      meta: { auto_generated: true },
    },

    // NEW: AI-generated metric example
    avg_revenue_per_user: {
      sql: `${CUBE.total_revenue} / nullIf(${CUBE.unique_users}, 0)`,
      type: `number`,  // 'number' is the correct type for derived calculations (ratios, percentages)
      description: 'Average revenue generated per unique user',
      meta: {
        ai_generated: true,
        ai_model: 'gpt-5.4',
        ai_generation_context: 'Ratio metric: total revenue divided by unique user count, with null-safe division',
        ai_generated_at: '2026-03-15T10:30:05Z',
        source_columns: ['amount', 'user_id'],  // Raw ClickHouse column names, NOT generated member names
      },
    },

    yoy_revenue_growth: {
      sql: `(${CUBE.total_revenue} - ${CUBE.total_revenue_prev_year}) / nullIf(${CUBE.total_revenue_prev_year}, 0) * 100`,
      type: `number`,  // 'number' for derived calculations
      description: 'Year-over-year revenue growth percentage',
      meta: {
        ai_generated: true,
        ai_model: 'gpt-5.4',
        ai_generation_context: 'Time comparison: YoY growth using revenue and created_at as time dimension',
        ai_generated_at: '2026-03-15T10:30:05Z',
        source_columns: ['amount', 'created_at'],  // Raw ClickHouse column names
      },
    },
  },
});
```

### Field category identification

| `meta` flag          | Category          | Merge behavior                                      |
|----------------------|-------------------|-----------------------------------------------------|
| `auto_generated: true` | Profiler-generated | Updated on regen, removed if column dropped         |
| `ai_generated: true`  | LLM-generated      | Superset retained on regen, removed if source cols dropped |
| Neither              | User-created       | Always preserved, never touched by generation       |
