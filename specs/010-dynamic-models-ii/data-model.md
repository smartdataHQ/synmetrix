# Data Model: Dynamic Models II

**Branch**: `010-dynamic-models-ii` | **Date**: 2026-03-15

## Entities

### Filter Condition (transient — not persisted in database)

Represents a single data filter applied during profiling and smart generation.

| Field       | Type                | Description                                                    |
|-------------|---------------------|----------------------------------------------------------------|
| column      | string              | Column name in the target table                                |
| operator    | enum                | One of: `=`, `!=`, `>`, `>=`, `<`, `<=`, `IN`, `NOT IN`, `LIKE`, `IS NULL`, `IS NOT NULL` |
| value       | string \| number \| string[] \| number[] \| null | Filter value(s). Type depends on column: strings escaped+quoted, numbers validated+unquoted, dates as ISO strings. Array for IN/NOT IN. Null for IS NULL/IS NOT NULL. Empty IN arrays rejected. |

**Storage**: Serialized as flat JSON array in the generated model's cube-level `meta.generation_filters`. Not stored in any database table — persisted only within the model file itself. All filters are AND-ed together (conjunctive only — no OR combinators or nested groups in v1).

**Validation rules**:
- `column` must exist in the table schema (validated before profiling)
- `operator` must be from the allowed enum
- `value` required for all operators except IS NULL/IS NOT NULL
- Maximum 10 filter conditions per generation request

### AI-Generated Metric (embedded in Cube.js model file)

A measure or dimension created by the LLM, stored inline in the Cube.js model file.

| Field                  | Type    | Description                                                        |
|------------------------|---------|--------------------------------------------------------------------|
| name                   | string  | Cube.js field name (snake_case, unique within cube)                |
| sql                    | string  | Cube.js SQL expression (may reference `{CUBE}` and `{FILTER_PARAMS}` template vars) |
| type                   | string  | Any valid Cube.js type. Measures: `number` (derived calculations like ratios/percentages), `sum`, `avg`, `count`, `countDistinct`, `countDistinctApprox`, `min`, `max`, `runningTotal`, `string`, `boolean`, `time`. Dimensions: `string`, `number`, `time`, `boolean`. Per CubeValidator.js:567. |
| fieldType              | enum    | `dimension` or `measure`                                           |
| meta.ai_generated      | boolean | Always `true` — distinguishes from profiler and user fields        |
| meta.ai_model          | string  | OpenAI model ID used (e.g., `gpt-5.4`)                            |
| meta.ai_generation_context | string | Human-readable explanation of why this metric was created      |
| meta.ai_generated_at   | string  | ISO 8601 timestamp of generation                                  |
| meta.source_columns    | string[] | Raw ClickHouse table column names (as from `DESCRIBE TABLE`) this metric depends on. NOT generated Cube.js member names. Used for stale detection — if any referenced column is dropped from the table, the metric is removed. |
| description            | string  | Human-readable description (editable by user, preserved on regen) |

**Lifecycle**:
1. Created by LLM during smart generation
2. Persisted in the Cube.js model file (JS or YAML)
3. On regeneration: extracted from existing model → sent to LLM as context → LLM returns superset
4. Removed only if source columns no longer exist in the table

**Uniqueness**: Field name must be unique within the cube. Collisions with profiler-generated fields resolved by appending `_ai` suffix.

### Generation Metadata (embedded in cube-level `meta`)

Cube-level metadata added to the generated model.

| Field                    | Type           | Description                                         |
|--------------------------|----------------|-----------------------------------------------------|
| meta.generation_filters  | FilterCondition[] | Filters applied during this generation (for re-population) |
| meta.ai_enrichment_status | string        | `success`, `partial`, `failed`, or `skipped`        |
| meta.ai_metrics_count    | number         | Count of AI-generated metrics in this model         |

## Relationships

```
Cube (model file)
 ├── meta.generation_filters[] → FilterCondition (persisted for re-population)
 ├── meta.ai_enrichment_status → generation outcome
 ├── dimensions[]
 │    ├── auto_generated fields (from profiler)
 │    ├── ai_generated fields (from LLM)
 │    └── user-created fields (manual)
 └── measures[]
      ├── auto_generated fields (from profiler)
      ├── ai_generated fields (from LLM)
      └── user-created fields (manual)
```

## State Transitions

### AI Metric Lifecycle

```
[New Table] → Profile → LLM Generate → ai_generated metrics created
                                          ↓
[Regenerate] → Profile → Extract existing ai_generated metrics
                           → LLM Generate (with existing metrics as context)
                           → Superset validation
                           → Merge (preserve user description edits)
                                          ↓
[Column Dropped] → Detect stale metrics (meta.source_columns check)
                    → Remove stale, surface in diff preview
```

### Filter Lifecycle

```
[First Generation] → User adds filters → Stored in meta.generation_filters
                                           ↓
[Regeneration] → Filters loaded from meta.generation_filters
                  → Pre-populated in UI
                  → User modifies or keeps
                  → New filters stored in meta.generation_filters
```
