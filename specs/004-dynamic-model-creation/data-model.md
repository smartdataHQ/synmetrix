# Data Model: Dynamic Model Creation

**Branch**: `004-dynamic-model-creation` | **Date**: 2026-03-08

## Database Schema Changes

### teams.settings (new column)

| Field | Type | Default | Nullable | Description |
|-------|------|---------|----------|-------------|
| settings | jsonb | `'{}'::jsonb` | NOT NULL | Team-level admin configuration |

**JSONB Structure**:
```json
{
  "partition": "brimborg.is",
  "internal_tables": ["semantic_events", "data_points", "entities"]
}
```

**Fields within settings**:
- `partition` (string, optional): Tenant partition value used for profiling WHERE clause and runtime query filtering. Absence means no partition filtering.
- `internal_tables` (string[], optional): Explicit list of ClickHouse table names subject to partition filtering. Only tables on this list get partition-scoped profiling and runtime query isolation. Absence or empty array means no tables are treated as internal.

**Permissions**:
- Select: all roles (via existing team membership filter)
- Update: owner role only (consistent with existing `name` update permission)

### Hasura Metadata Updates

**tables.yaml** — teams table:
- Add `settings` to select permissions columns for role `user`
- Add `settings` to update permissions columns for role `user` (same owner-only filter as `name`)

## Ephemeral Data Structures (Not Persisted)

### ProfiledTable

Returned by the profiling endpoint. Not stored in the database.

```
ProfiledTable:
  database: string              — ClickHouse database name
  table: string                 — Table name
  partition: string | null      — Partition value used for profiling
  row_count: number             — Total rows (within partition scope)
  sampled: boolean              — Whether sampling was used (true when row_count > threshold)
  sample_size: number | null    — Number of rows sampled (null if not sampled)
  existing_model: ExistingModelInfo | null  — Info about existing model on branch
  columns: Map<string, ProfiledColumn>

ProfiledColumn:
  name: string                  — Column name
  raw_type: string              — Original ClickHouse type string (e.g., "Map(String, Float64)")
  column_type: enum             — BASIC | ARRAY | MAP | NESTED | GROUPED
  value_type: enum              — STRING | NUMBER | DATE | UUID | BOOLEAN | OTHER
  key_data_type: enum | null    — For Map columns: type of keys
  value_data_type: enum | null  — For Map columns: type of values
  is_nullable: boolean
  parent_name: string | null    — For dotted/grouped columns
  child_name: string | null     — For dotted/grouped columns
  profile:
    has_values: boolean         — Whether column has any non-null data
    value_rows: number          — Count of non-null rows
    unique_values: number       — Distinct count
    min_value: any | null       — For numeric/date columns
    max_value: any | null       — For numeric/date columns
    unique_keys: string[]       — For Map columns: discovered keys
    lc_values: Map<string, string[]> | null  — For LC columns: enumerated values per key

ExistingModelInfo:
  file_name: string             — Current model filename (e.g., "semantic_events.yml")
  file_format: string           — "yml" or "js"
  has_user_content: boolean     — Whether model has user-created fields, edited descriptions, joins, etc.
  supports_reprofile: boolean   — Whether model has provenance metadata (smart-generated)
  suggested_merge_strategy: string  — Backend recommendation ("auto", "merge", or "replace")
```

### SmartGenerationRequest

Input to the smart-generate endpoint (step 2 of two-step flow).

```
SmartGenerationRequest:
  datasource_id: uuid
  branch_id: uuid
  table: string                 — Table name to profile and generate for
  schema: string                — Database/schema name
  array_join_columns: Array<{   — User-selected arrays to flatten
    column: string
    alias: string
  }>
  max_map_keys: number          — Override for max Map keys per column (default 500)
```

### SmartGenerationResult

Returned to the frontend after generation completes.

```
SmartGenerationResult:
  code: string                  — "ok" or error code
  message: string               — Human-readable status
  version_id: uuid | null       — ID of newly created version (null if changed: false)
  file_name: string             — Name of generated/updated model file
  changed: boolean              — Whether a new version was created (false if checksum matches)
  profile_summary:              — Summary of what was profiled
    row_count: number
    columns_profiled: number
    columns_skipped: number     — Columns that failed or had no data
    map_keys_discovered: number
    array_candidates: number
  model_summary:                — Summary of what was generated
    dimensions_count: number
    measures_count: number
    cubes_count: number         — 1 (raw) + N (flattened)
```

## Cube-Level Provenance Metadata

Embedded in generated YAML cube definitions. Enables re-profile without external config.

**Non-partitioned table** (uses `sql_table`):

```yaml
cubes:
  - name: semantic_events
    sql_table: cst.semantic_events
    meta:
      auto_generated: true
      source_database: cst
      source_table: semantic_events
      generated_at: "2026-03-08T12:00:00Z"
    dimensions:
      - name: entity_gid
        sql: "{CUBE}.entity_gid"
        type: string
        primary_key: true
        meta:
          auto_generated: true
```

**Partitioned internal table** (uses `sql` with WHERE clause — `sql_where` is NOT a valid Cube.dev property):

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
    dimensions:
      - name: entity_gid
        sql: "{CUBE}.entity_gid"
        type: string
        primary_key: true
        meta:
          auto_generated: true
```

## Merge Strategies

The user controls merge behavior via `mergeStrategy` (passed in the smart-generate request). The frontend presents this as toggles in the profiling preview / re-profile UI.

### Available Strategies

| Strategy | Behavior | When to use |
|----------|----------|-------------|
| `"auto"` (default) | Smart default: detect user content → merge if found, replace if not | Most cases — safe default |
| `"merge"` | Always merge. Preserve user fields, edited descriptions, joins, pre_aggregations, segments. Update/add/remove auto fields. | User has customizations they want to keep |
| `"replace"` | Full replace. Discard all existing content. Write clean smart-generated model. **Requires user confirmation warning.** | User wants a clean slate |
| `"merge_keep_stale"` | Like `"merge"`, but do NOT remove auto-generated fields for columns no longer in data. | Columns temporarily empty or renamed; user wants to keep the fields for now |

### Auto Strategy Decision Logic

When `mergeStrategy` is `"auto"` (or omitted), the merger detects user content to decide:

| Existing Model State | Auto Action |
|---------------------|-------------|
| No existing model for this table | Create new model file |
| Existing **standard-generated** model (no `auto_generated` tags) | Replace entirely (user chose "Smart Generate" — previous version in history) |
| Existing **smart-generated** model with **no user content** | Replace entirely (no user work to lose) |
| Existing **smart-generated** model with **user content** | Merge (preserve user content, update auto fields) |

**User content detection**: A model has "user content" if any of these are true:
- Any dimension/measure lacks the `auto_generated` tag (user-created field)
- Any `auto_generated` field has a `description` that differs from the auto-generated default (user-edited)
- A `joins` block exists (smart generation never creates joins)
- A `pre_aggregations` block exists
- A `segments` block exists

### Frontend Presentation

The frontend shows merge options when an existing model is detected in the profiling preview:

- **"Preserve custom changes"** toggle (default: ON when user content detected, OFF when no user content)
  - ON → `"merge"` strategy
  - OFF → `"replace"` strategy (with confirmation warning)
- **"Keep removed columns"** toggle (visible only when "Preserve custom changes" is ON)
  - ON → `"merge_keep_stale"` strategy
  - OFF → `"merge"` strategy

## Field-Level Merge Rules

During re-profile/merge, the merger processes each field in the existing model:

| Existing Field State | New Profile State | Action |
|---------------------|-------------------|--------|
| `auto_generated: true`, column still exists | Profile has updated data | Update SQL, type; **preserve description** |
| `auto_generated: true`, column removed | Not in profile | Remove field |
| `auto_generated: true`, no change | Same in profile | Keep as-is |
| No `auto_generated` tag (user field) | Any | Never touch |
| Not in existing model | New column in profile | Add with `auto_generated: true` |

## Cube-Level Property Merge Rules

The merger also handles cube-level properties beyond fields:

| Property | Merge Behavior |
|----------|---------------|
| `joins` (cube-to-cube relationships) | **Always preserve**. Smart generation does not create or modify joins. Any user-defined `joins` block is carried forward unchanged during re-profile. |
| `sql` / `sql_table` | Regenerated by smart generation (auto-generated). Updated to reflect current partition settings. |
| `meta` (provenance) | Regenerated: `source_database`, `source_table`, `source_partition`, `generated_at` are updated. User-added meta keys (without `auto_generated`) are preserved. |
| `description` (cube-level) | Preserved if user-edited. Only overwritten if no existing description. |
| `public` (cube-level) | Preserved if user-set. |
| `pre_aggregations` | **Always preserve**. Smart generation does not create pre-aggregations. |
| `segments` | **Always preserve**. Smart generation does not create segments. |

## Multi-Cube Merge Rules

Smart-generated YAML files may contain multiple cubes (1 raw + N flattened ARRAY JOIN cubes). During merge, each cube is processed independently:

### Cube Identity Matching

Cubes are matched between the existing model and the new generation by their **`name` property**. This is the stable identity key.

| Existing Cube | New Generation | Action |
|--------------|----------------|--------|
| Cube with `meta.auto_generated: true` | Matching name in new generation | Merge per field-level rules |
| Cube with `meta.auto_generated: true` | No matching name (e.g., array deselected) | Remove cube |
| Cube without `auto_generated` (user-created) | Any | Never touch — preserve as-is |
| Not in existing model | New cube in generation | Append to file |

### Flattened Cube Naming

Flattened cubes use the naming convention `{table_name}_{alias}` (e.g., `semantic_events_products`). The alias comes from the user's array join selection. If the alias changes between generations, the old cube is removed (auto-generated) and a new one is created.

### Collision Handling

- If a user-created cube has the same name as a new auto-generated cube, the user cube is preserved and the auto cube is skipped (logged as warning in generation summary).
- Field names within a cube must be unique. The cube builder disambiguates by prefixing with the source column name on collision.

## Entity Relationships

```
Team 1──1 Team Settings (settings JSONB column)
Team 1──N Datasources
Datasource 1──N Branches
Branch 1──N Versions (immutable, ordered by created_at)
Version 1──N Dataschemas (model files: name + code)
Dataschema ──contains── Cubes (1 raw + 0..N flattened per smart-generated file)
Cube ──contains── Dimensions + Measures (each optionally tagged auto_generated)
```
