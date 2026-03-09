# 004: Smart Model Generation — Research & Findings

## Status: Pre-Spec Research Complete

This document captures all findings from the research phase. A formal spec will follow.

---

## 0. Introduction

### Goal

Replace Synmetrix's basic model generation with an intelligent, profile-driven system that understands the shape of the data — not just the schema. The system introspects ClickHouse tables, analyzes column types, cardinality, and data distribution, then generates rich Cube.js models with proper Map key expansion, ARRAY JOIN flattening, and type-aware dimension/measure classification.

### Why

The current generation produces skeletal models that require extensive manual work. ClickHouse tables used internally (semantic_events, data_points, entities) have complex structures — Maps with dynamic keys, nested arrays, grouped columns — that the standard CubeJS scaffolding cannot represent. Users must hand-build every Map key dimension, every ARRAY JOIN cube, and every measure aggregation. When the underlying data evolves (new Map keys appear, columns are added), there is no way to update models without losing manual customizations.

### What Changes

1. **Profile-driven generation**: Instead of reading only the schema, the system profiles the actual data — discovering Map keys, counting cardinality, detecting empty columns, enumerating low-cardinality values for filter support.

2. **Template-based output**: Profiling results feed into templates that render Cube.js YAML, decoupling the model structure from the introspection logic. Templates can evolve independently.

3. **Smart field ownership**: Every auto-generated field is tagged with `meta.auto_generated: true`. Users can freely add custom fields without the tag. On re-profiling, auto fields are updated or removed; user fields are never touched. Descriptions edited by users on auto fields are preserved.

4. **Partition-based multi-tenancy**: Each team/account has a ClickHouse partition. Profiling is scoped to the tenant's partition. Generated models enforce partition isolation at query time.

5. **Opt-in, additive**: This is a new path alongside existing generation — not a replacement. Users choose "Smart Generate" for ClickHouse datasources. Other database types continue using the standard flow.

### Who It Affects

- **Backend**: Actions service (new RPC handler), CubeJS service (new profiling route, enhanced queryRewrite, security context changes), Hasura (new action, team settings migration)
- **Frontend**: Models page (new generation option, re-profile button), minimal UI additions
- **Data model**: New `settings` JSONB column on the `teams` table

### Constraints

- ClickHouse only in v1 (other engines later)
- Manual triggering only (no scheduled re-profiling yet)
- No table joins (deferred)
- Configuration is ephemeral (not persisted between runs)
- Dynamic dimension rewriting (Map key → `['key']` at query time) is aspirational for v1, may be deferred

---

## 1. Problem Statement

Synmetrix currently generates Cube.js models using CubeJS's built-in `ScaffoldingTemplate`, which produces basic models from database table schemas. This approach:

- Generates flat, minimal models with no awareness of data characteristics
- Cannot handle ClickHouse-specific types (Map, Array, Nested, LowCardinality)
- Has no concept of ARRAY JOIN for flattening nested structures
- Provides no way to update models when underlying data changes without overwriting manual edits
- Lacks multi-tenant partition enforcement

A working Python prototype exists (`cxs-inbox/cube/cube_orchestrator.py`) that solves these problems for ClickHouse. This plan covers porting that capability into Synmetrix as a native feature.

---

## 2. Prototype Analysis

### 2.1 Architecture

The prototype is an external Python pipeline with two phases:

**Phase 1 — Profile & Generate:**
1. `profile_table()` introspects a ClickHouse table (schema + data statistics)
2. `ProfileBasedCubeGenerator` converts profiling output into Cube.js YAML
3. Generates RAW cube (all columns) + Flattened cubes (one per ARRAY JOIN column)

**Phase 2 — Upload & Merge:**
1. Authenticates to Synmetrix via GraphQL
2. Fetches latest version's existing models
3. Smart-merges new models with existing (preserves unchanged, updates changed, adds new)
4. Creates a single atomic version

### 2.2 Key Files (Python Prototype)

| File | Purpose |
|------|---------|
| `cxs-inbox/cube/cube_orchestrator.py` | Main orchestrator — two-phase pipeline |
| `cxs-inbox/libs/core/cxs/core/utils/profile_table.py` | ClickHouse table profiler (1200 lines) |
| `cxs-inbox/cube/generate_cube_from_profile.py` | Cube YAML generator from profiling output |
| `cxs-inbox/cube/multi_table_config.py` | YAML config model (tables, joins, partitions) |
| `cxs-inbox/cube/multi_table_processor.py` | Multi-table processing orchestrator |
| `cxs-inbox/cube/upload_cubes_to_synmetrix.py` | Extended upload service with merge logic |
| `cxs-inbox/cube/upload_service.py` | Base upload service (auth, retry, validation) |
| `cxs-inbox/cube/utils/naming.py` | Filename and model name generation |
| `cxs-inbox/cube/utils/field_processors.py` | Field type processors (Basic, Map, Array) |
| `cxs-inbox/cube/utils/config.py` | SynmetrixConfig and DatabaseConfig |
| `cxs-inbox/cube/utils/validators.py` | Column validation utilities |
| `cxs-inbox/cube/utils/reporting.py` | Cube generation summary reporter |
| `cxs-inbox/cube/utils/db_description_resolver.py` | DB column description lookup index |
| `cxs-inbox/cube/utils/paths.py` | Schema base directory resolution |
| `cxs-inbox/cube/utils/exceptions.py` | Custom exceptions (DatabaseError, ConfigurationError, ModelGenerationError, UploadError, YamlSyntaxError) |
| `cxs-inbox/cube/utils/cube_model.py` | CubeModel dataclass (name, file_path, code) with YAML validation |
| `cxs-inbox/cube/primary_key_detector.py` | Auto-detects primary keys from table schema |
| `cxs-inbox/cube/table_profile_to_json.py` | Serializes ProfiledTable to JSON for reporting |
| `cxs-inbox/cube/synmetrix_python_client/` | Python GraphQL client for Synmetrix API (auth, queries, mutations) |

### 2.3 Profiling Deep Dive (`profile_table.py`)

**Two-pass introspection:**

**Pass 1 — Schema analysis** (`DESCRIBE TABLE`):
- Parses every column's ClickHouse type string recursively
- Handles nested types: `LowCardinality(Nullable(Array(Map(String, Float64))))`
- Classifies each column:
  - `BASIC` — scalar types (String, Int, Date, UUID, Boolean)
  - `ARRAY` — Array(...) columns
  - `MAP` — Map(K,V) columns
  - `NESTED` — ClickHouse Nested type (array of structs)
  - `GROUPED` — dot-separated column names sharing a prefix (not actual nested arrays)
- Determines value types: `String`, `Number`, `Date`, `UUID`, `Boolean`, `Other`
- Detects parent/child relationships for dotted column names

**Pass 2 — Data profiling** (batched SELECT queries):
- Generates column-type-specific SQL aggregations:
  - **Basic strings**: `uniq()`, `countIf(NOT NULL AND != '')`
  - **Basic numbers/dates**: `min()`, `max()`, `countIf(NOT NULL)`
  - **Maps**: `groupUniqArrayArray(mapKeys())` to discover all keys, then per-key profiling
  - **Arrays**: `countIf(arrayExists(...))`, `arrayUniq(arrayFlatten(...))`
  - **Nested**: type column discovery via `arrayDistinct(arrayFlatten(groupArray(...)))`
  - **Grouped (Map subkeys)**: `generate_map_key_sql()` / `generate_array_map_key_sql()`
- Batches 10 columns per query, falls back to individual queries on failure
- Optional **LC probe**: for string columns with <200 unique values, enumerates actual values via `arraySort(groupUniqArray(...))`

**Output: `ProfiledTable`**
```
ProfiledTable:
  database: str
  table: str
  where_clause: str (partition filter)
  rows: int
  columns: Dict[str, ColumnDetails | NestedColumnInfo | GroupedColumnInfo]

ColumnDetails:
  name, type (raw CH type string)
  column_type: BASIC | ARRAY | MAP | GROUPED | NESTED
  key_data_type: ValueType (for Maps)
  value_data_type: ValueType
  required: bool
  is_nested, is_nested_subcolumn, parent_name, child_name, nested_path
  profile: ColumnProfile

ColumnProfile:
  min_value, max_value, avg_value (numeric/date)
  value_rows: int (non-null count)
  unique_values: int (distinct count)
  unique_keys: List[str] (Map keys)
  value_list: Dict[str, List[str]] (LC probe results)
  has_values: bool
```

### 2.4 Field Processors (`utils/field_processors.py`)

The prototype uses a factory pattern for processing different column types into cube fields:

```
CubeField:
  name: str
  sql: str
  type: str          # "string", "number", "time", "boolean"
  field_type: str    # "dimension" or "measure"
  aggregation: str   # For measures: "sum", "avg", "min", "max", "count"

FieldProcessorFactory → dispatches to:
  BasicFieldProcessor:
    - String/Date/UUID/Boolean → dimension
    - Number → measure (type: sum)
  MapFieldProcessor:
    - Discovers keys from profile.unique_keys
    - Each key → separate field: {CUBE}.mapCol['keyName']
    - String value keys → dimensions, numeric → measures
    - Also handles Map value_list from LC probe for per-key value enumeration
  ArrayFieldProcessor:
    - Checks should_use_array_join() per column
    - Non-ARRAY-JOIN arrays: basic profiling
    - ARRAY JOIN arrays: handled separately in flattened cube generation
```

### 2.5 Primary Key Detection (`primary_key_detector.py`)

- Auto-detects primary keys from ClickHouse table schema
- Can be overridden via `configured_primary_keys` parameter
- Fallback: uses `entity_gid` if no keys detected
- Primary key dimensions get `primary_key: true` and `public: true` in YAML

### 2.6 DB Description Resolver (`utils/db_description_resolver.py`)

- Builds an index of human-readable descriptions for table columns
- Looks up descriptions by dot-path with wildcard parent matching
- Used to add `description` fields to generated dimensions/measures
- **In the new system**: Descriptions on existing auto-generated fields are preserved during merge, so this external lookup is not needed — users can edit descriptions in the model and they survive re-profiling

### 2.7 Cube Generation Deep Dive (`generate_cube_from_profile.py`)

**`ProfileBasedCubeGenerator.build_cube_yaml()`:**

1. **RAW Cube** (no ARRAY JOIN):
   - Iterates all columns via `FieldProcessorFactory`
   - `BasicFieldProcessor`: strings/dates/UUIDs → dimensions, numbers → measures (type: sum)
   - `MapFieldProcessor`: discovers keys from profile, creates one field per key. String keys → dimensions, numeric keys → measures. Values accessed via `{CUBE}.mapCol['keyName']`
   - Filters out columns with `has_values=false` (via `_filter_fields_by_profile_data()`)
   - Auto-detects and marks primary keys (`detect_primary_keys()`)
   - RAW cube name = `table.lower()`, sql_table = `{database}.{table}`

2. **Flattened Cubes** (one per ARRAY JOIN column):
   - Deep-copies all RAW cube fields
   - Removes fields that reference the array join source column (`{CUBE}.{aj_col}.*`)
   - Profiles array join columns (`_profile_array_join_columns()`) to discover sub-fields
   - Adds flattened array element fields:
     - Numeric array values → measures (sum)
     - String → dimensions
     - Int8 → boolean dimensions (sql: `(alias.col) = 1`)
   - Renames base commerce fields to avoid name collisions (`_rename_base_commerce_fields()`)
   - Generates custom SQL with `LEFT ARRAY JOIN` syntax (`_build_custom_sql_with_array_joins()`)
   - Names each flattened cube using the configured alias
   - Adds count measure if no measures exist

3. **YAML output**: `yaml.dump()` with `cubes: [...]` structure

### 2.8 Upload & Merge Logic (`upload_cubes_to_synmetrix.py`)

**Merge strategy (`merge_models()`):**
```
For each model in latest version:
  If model name exists in new batch AND content differs → REPLACE (conflict resolved)
  If model name exists in new batch AND content same → PRESERVE
  If model name NOT in new batch → PRESERVE (keep existing)

For each model in new batch:
  If model name NOT in existing → ADD (new model)
```

Returns `MergeResult` with counts: existing_preserved, updated, new, conflicts_resolved, total.

All merged models uploaded as a single atomic version with MD5 checksum.

### 2.9 Naming Conventions

| Context | Pattern | Example |
|---------|---------|---------|
| Output filename (with partition) | `{table}_{partition}.cubes.yml` | `data_points_blue_is.cubes.yml` |
| Output filename (no partition) | `{table}.cubes.yml` | `data_points.cubes.yml` |
| Upload model name (with partition) | `{table}_{partition}_cube.yml` | `data_points_blue_is_cube.yml` |
| Upload model name (no partition) | `{table}_cube.yml` | `data_points_cube.yml` |

Partition sanitization: non-alphanumeric (except hyphens) → underscores, deduped, trimmed.

### 2.10 Configuration (YAML)

```yaml
tables:
  data_points:
    database: cst
    partition: blue.is          # Optional, scopes profiling
    profile_config: {}          # Passed to profile_table()
    primary_keys: [entity_gid]
    array_join_columns:
      - column: commerce.products
        alias: products
    joins:                      # DEFERRED — not in v1
      - source_column: entity_gid
        target_table: ql_entities
        target_column: entity_gid
        join_type: left_join
        relationship: many_to_one

global:
  output_directory: ./models
  log_level: INFO
```

**In the new system**: Config is **ephemeral** — exists only during the generate/update operation. Not persisted.

---

## 3. Existing Synmetrix Code Affected

### 3.1 Current Model Generation Flow

```
Frontend (DataModelGeneration component)
  → Hasura mutation: gen_dataschemas(datasource_id, branch_id, tables[], overwrite, format)
  → Hasura Action → POST http://actions:3000/rpc/gen_schemas
  → genSchemas.js → cubejsApi.generateSchemaFiles()
  → CubeJS POST /api/v1/generate-models
  → generateDataSchema.js route:
    ├─ driver.tablesSchema()           # Get raw DB schema
    ├─ ScaffoldingTemplate.generate()  # Basic model generation
    ├─ findDataSchemas()               # Get existing schemas
    ├─ Merge/overwrite logic
    └─ createDataSchema()              # Save as new version
```

### 3.2 Backend Files (Absolute Paths)

**RPC Handlers** (`/Users/stefanbaxter/Development/synmetrix/services/actions/src/rpc/`):

| File | Purpose | Impact |
|------|---------|--------|
| `genSchemas.js` | Entry point for schema generation | Will need parallel path for smart generation |
| `fetchTables.js` | Lists available DB tables | Used as-is for table selection |
| `fetchMeta.js` | Gets cube metadata | Used for validation |
| `recalculateDataschemas.js` | Creates initial branch/version on new datasource | May need update |
| `genSchemasDocs.js` | Auto-generates docs for versions | Used as-is |
| `exportDataModels.js` | ZIP export | Used as-is |

**CubeJS Routes** (`/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/routes/`):

| File | Purpose | Impact |
|------|---------|--------|
| `generateDataSchema.js` | Core generation endpoint (POST /api/v1/generate-models) | New parallel route or enhanced |
| `getSchema.js` | Returns DB schema structure (GET /api/v1/get-schema) | Used as-is |

**CubeJS Utils** (`/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/`):

| File | Purpose | Impact |
|------|---------|--------|
| `queryRewrite.js` | Currently only access control checks | Will need partition filter injection + dimension rewriting |
| `checkAuth.js` | JWT verification, security context | Must thread partition from team settings |
| `defineUserScope.js` | Branch/version/access resolution | Must include team settings/partition |
| `buildSecurityContext.js` | Content-hashed context for cache | Must include partition |
| `driverFactory.js` | Creates DB drivers (25+ types) | ClickHouse driver used for profiling |
| `dataSourceHelpers.js` | CRUD for versions/dataschemas | Used for merge logic |

**Actions Utils** (`/Users/stefanbaxter/Development/synmetrix/services/actions/src/utils/`):

| File | Purpose | Impact |
|------|---------|--------|
| `cubejsApi.js` | HTTP client for CubeJS endpoints | New methods for profiling endpoint |

### 3.3 Frontend Files (`/Users/stefanbaxter/Development/client-v2`)

**Components:**

| Component | Absolute Path | Impact |
|-----------|------|--------|
| `DataModelGeneration` | `/Users/stefanbaxter/Development/client-v2/src/components/DataModelGeneration/index.tsx` | Add "Smart Generate" option |
| `CodeEditor` | `/Users/stefanbaxter/Development/client-v2/src/components/CodeEditor/index.tsx` | Show auto_generated field indicators |
| `ModelsSidebar` | `/Users/stefanbaxter/Development/client-v2/src/components/ModelsSidebar/index.tsx` | Add "Re-profile" action |
| `DataSchemaForm` | `/Users/stefanbaxter/Development/client-v2/src/components/DataSchemaForm/index.tsx` | May need updates for smart-generated schemas |
| `SQLRunner` | `/Users/stefanbaxter/Development/client-v2/src/components/SQLRunner/index.tsx` | Used as-is |
| `Console` | `/Users/stefanbaxter/Development/client-v2/src/components/Console/index.tsx` | Used as-is (validation errors) |
| `VersionsList` | `/Users/stefanbaxter/Development/client-v2/src/components/VersionsList/index.tsx` | Used as-is |
| `VersionPreview` | `/Users/stefanbaxter/Development/client-v2/src/components/VersionPreview/index.tsx` | Used as-is |
| `Models` page | `/Users/stefanbaxter/Development/client-v2/src/pages/Models/index.tsx` | Orchestrate new flow |

**GraphQL:**

| File | Absolute Path | Impact |
|------|------|--------|
| Datasources GQL | `/Users/stefanbaxter/Development/client-v2/src/graphql/gql/datasources.gql` | New mutation for smart generation |
| Schemas GQL | `/Users/stefanbaxter/Development/client-v2/src/graphql/gql/schemas.gql` | May need updates for meta field queries |
| Versions GQL | `/Users/stefanbaxter/Development/client-v2/src/graphql/gql/versions.gql` | Used as-is |
| Generated types | `/Users/stefanbaxter/Development/client-v2/src/graphql/generated.ts` | Regenerated after action/type changes |

**Hooks:**

| File | Absolute Path | Impact |
|------|------|--------|
| `useSources` | `/Users/stefanbaxter/Development/client-v2/src/hooks/useSources.ts` | New methods for smart generation |
| `useModelsIde` | `/Users/stefanbaxter/Development/client-v2/src/hooks/useModelsIde.ts` | Tab state for re-profile flow |
| `useVersions` | `/Users/stefanbaxter/Development/client-v2/src/hooks/useVersions.ts` | Used as-is |

**Other Frontend Files:**

| File | Absolute Path | Purpose |
|------|------|---------|
| Dataschema type | `/Users/stefanbaxter/Development/client-v2/src/types/dataschema.ts` | Type definition for schema objects |
| Monaco config | `/Users/stefanbaxter/Development/client-v2/src/utils/constants/monaco.ts` | Editor configuration |
| Checksum util | `/Users/stefanbaxter/Development/client-v2/src/utils/helpers/dataschemasChecksum.ts` | MD5 checksum for versions |

### 3.4 Hasura Metadata (`/Users/stefanbaxter/Development/synmetrix/services/hasura/metadata/`)

| File | Absolute Path | Impact |
|------|------|--------|
| Actions config | `/Users/stefanbaxter/Development/synmetrix/services/hasura/metadata/actions.yaml` | New action for smart generation (handler, timeout, permissions) |
| Actions GraphQL | `/Users/stefanbaxter/Development/synmetrix/services/hasura/metadata/actions.graphql` | New input types and mutations |
| Tables metadata | `/Users/stefanbaxter/Development/synmetrix/services/hasura/metadata/tables.yaml` | Team settings column permissions (admin/owner write only) |

### 3.5 Hasura Migrations (`/Users/stefanbaxter/Development/synmetrix/services/hasura/migrations/`)

New migration needed for:
- `ALTER TABLE teams ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb`
- Hasura metadata tracking for the new column
- Permission rules (select: all roles, update: owner/admin only)

---

## 4. Database Schema Findings

### 4.1 Current Schema (Relevant Tables)

**teams:**
- `id` (uuid PK), `name` (text, unique CI), `user_id` (uuid FK→users), `created_at`, `updated_at`
- **No settings/config column exists**

**datasources:**
- `id` (uuid PK), `name`, `db_type`, `db_params` (jsonb — connection config), `user_id`, `team_id` (FK→teams)
- `db_params` pattern: JSONB with computed field `db_params_computed` that masks passwords via `hide_password()` SQL function

**members:**
- `id` (uuid PK), `user_id` (FK→users), `team_id` (FK→teams)
- Unique constraint on (user_id, team_id)

**member_roles:**
- `id` (uuid PK), `member_id` (FK→members), `team_role` (FK→team_roles.name), `access_list_id` (FK→access_lists)

**access_lists:**
- `id` (uuid PK), `name`, `team_id` (FK→teams), `config` (jsonb — access control config)
- Structure: `{ datasources: { [id]: { cubes: [...] } } }`

**branches:**
- `id` (uuid PK), `name` (default 'main'), `datasource_id` (FK→datasources), `status`, `user_id`

**versions:**
- `id` (uuid PK), `branch_id` (FK→branches), `checksum`, `user_id`, `created_at`

**dataschemas:**
- `id` (uuid PK), `name` (filename), `code` (YAML/JS content), `datasource_id`, `user_id`, `checksum`

### 4.2 Settings Storage — Recommendation

**No dedicated settings table exists.** Existing JSONB config patterns in the codebase:

| Table | Column | Pattern |
|-------|--------|---------|
| `datasources` | `db_params` | JSONB with computed field for masking sensitive values |
| `access_lists` | `config` | JSONB for per-team access control rules |
| `explorations` | `playground_settings` | JSONB for UI state |
| `reports` | `delivery_config` | JSONB for delivery settings |
| `alerts` | `locks_config` | JSONB for alert config |

**Best option: Add a `settings` JSONB column to the `teams` table.**

Rationale:
- Partition is a team-level property (one team per account currently)
- Follows the existing `db_params` pattern on datasources
- Simple migration: `ALTER TABLE teams ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb`
- Can store partition and future admin-only settings
- Hasura permissions restrict write access to admin/owner roles
- No need for a separate table (avoids join overhead for a 1:1 relationship)

**Structure:**
```jsonb
{
  "partition": "brimborg.is",
  "clickhouse_database": "cst",
  "internal_tables": ["semantic_events", "data_points", "entities"]
}
```

**Alternative considered**: A separate `team_settings` table with key-value rows. Rejected because:
- Adds join complexity for simple lookups
- No clear benefit over JSONB for a small, known set of properties
- Existing codebase consistently uses JSONB columns for config

---

## 5. Key Design Decisions

### 5.1 Opt-In, Not Replacement

Smart model generation is a **new, parallel path** — it does **not replace** the existing `gen_dataschemas` flow which uses CubeJS `ScaffoldingTemplate`. Users choose between:
- **Standard generation** (existing): Basic model from DB schema, works for all database types
- **Smart generation** (new): Profile-based model with auto-tagging, ClickHouse only for now

The UI adds an opt-in option alongside the existing generation wizard. The existing flow remains the default.

### 5.2 Template-Based Generation

Instead of building YAML via Python dicts / `yaml.dump()`, the new system uses templates:

- Profiling output feeds into templates that render Cube.js YAML
- Decouples "what does a cube look like" from "what did we learn about the table"
- Templates can be versioned and customized per use-case
- **Template engine**: TBD — candidates include Handlebars, Nunjucks, EJS, or TypeScript template literals

### 5.3 `meta.auto_generated` Field Tagging

Auto-generated fields are labeled in the Cube.js YAML:

```yaml
dimensions:
  - name: user_id
    sql: "{CUBE}.user_id"
    type: string
    meta:
      auto_generated: true    # System-managed, safe to update/remove on re-profile

  - name: custom_metric       # No auto_generated tag — user-owned, never touched
    sql: "CASE WHEN ..."
    type: string
```

**Re-profile merge rules:**
- Fields with `meta.auto_generated: true` → update if column still exists, remove if column gone from DB
- Fields without that tag → **never touched**
- Descriptions on existing auto-generated fields are **preserved** during merge (serves as the "DB description resolver" — users can add descriptions that survive re-profiling)

**The `meta` property is important** and is used to determine field handling in various use-cases beyond just merge. It is a valid Cube.js property on dimensions, measures, and segments. Future use-cases may add additional meta keys for different field behaviors (e.g., UI hints, query rewriting flags, access control markers).

### 5.4 Partition-Based Multi-Tenancy

- Each team has a `partition` value in `teams.settings` — **static per account**
- Currently one team per account; this may change in the future
- Stored as a team-level setting, writable only by admin or API
- **During profiling**: Used as WHERE clause (`WHERE partition = '{team.partition}'`) to scope introspection to tenant's data
- **At runtime**: Injected into CubeJS queries via `queryRewrite` or `sql_where` in generated models
- Only applies to internal ClickHouse tables (semantic_events, data_points, entities)
- External datasources are **never** subject to partition filtering

**Current state of queryRewrite** (`/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/queryRewrite.js`):
- Currently only performs **access control** — checks if user can access specific cube dimensions/measures
- Does **not** modify queries, inject filters, or rewrite SQL
- Owners/admins bypass all checks
- Will need to be extended for partition injection and potentially dynamic dimension rewriting

**Current security context flow:**
```
checkAuth.js: JWT → extract userId → findUser() → get dataSources + members
  → defineUserScope.js: resolve dataSource, branch, version, access list
    → buildSecurityContext.js: create content-hashed context (dataSourceId, dbType, dbParams, schemaVersion)
      → stored as req.securityContext.userScope
```
Partition must be threaded through this chain from `teams.settings` into the security context.

### 5.5 Dynamic Dimension Rewriting — DEFERRED

**Full research documented in: [004a-dynamic-field-resolution.md](./004a-dynamic-field-resolution.md)**

Instead of generating N separate static dimensions per Map key, dimensions can be generated dynamically at schema compilation time using Cube.js `asyncModule` + JS data model files. Research confirmed this is feasible — `asyncModule` generates real, first-class compiled dimensions that pass standard validation, support pre-aggregations, and are exposed in the Meta API.

Key finding: `queryRewrite` cannot solve this (it runs after compilation and cannot inject new members). The solution is to generate JS model files with embedded profiling output (Map keys, Nested types, LC values) that produce dimensions at compile time. Schema recompilation is triggered automatically when the profiling output changes (via `schemaVersion` hash).

**Deferred from v1** — requires further collaboration, access to example data, and benchmarking of compilation performance with realistic Map key counts. The profiling infrastructure built in v1 (Map key discovery, LC probe, Nested type enumeration) directly feeds this feature when ready.

### 5.6 Array Join Auto-Detection

The profiler identifies `Array(...)` type columns automatically. In the new flow:
- Profiling detects all Array-typed columns
- UI presents them as candidates for ARRAY JOIN
- User selects which arrays to flatten (or auto-selects all)
- No persistent config needed — selection is ephemeral per generation run

### 5.7 Joins — Deferred

Table joins (source_column → target_table.target_column) are **out of scope** for this spec. The prototype supports them but they add significant complexity.

---

## 6. Networking Consideration

The dev ClickHouse instance (`dev-clickhouse`, 100.87.250.36) is on Tailscale. Docker Desktop has Tailscale/host networking enabled, but containers currently cannot reach it. Options:
- Run profiling service outside Docker during dev
- Configure Docker host networking for the profiling container
- Debug Docker Desktop Tailscale routing
- This is a dev environment concern, not an architecture issue

---

## 7. Scope Summary

### In Scope (v1)

1. **TypeScript profiling service** — port `profile_table.py` to TypeScript, runs in Actions/CubeJS service, ClickHouse only
2. **Template-based Cube YAML generation** — from profiling output, with a suitable template engine
3. **`meta.auto_generated` field tagging** — label system-managed fields
4. **Smart merge on re-profile** — update auto fields, preserve user fields, preserve descriptions
5. **Team settings** — `settings` JSONB column on teams table for partition and other admin config
6. **Partition enforcement** — during profiling (WHERE clause) and at query time
7. **LC probe** — enumerate low-cardinality values for filter/autocomplete support
8. **Minimal UI changes** — opt-in "Smart Generate" alongside existing generation, "Re-profile" button on existing models
9. **Map key expansion** — discover and generate per-key fields from Map columns
10. **Array join detection** — auto-detect Array columns, let user select for ARRAY JOIN

### Deferred (see [004a-dynamic-field-resolution.md](./004a-dynamic-field-resolution.md))

11. **Dynamic field resolution** — compile-time Map/Nested key resolution via `asyncModule` + JS data models instead of static field expansion. Research complete, implementation deferred.

### Out of Scope

- Table joins between cubes
- Non-ClickHouse database engines
- Scheduled/automated re-profiling (manual trigger only for now)
- Persistent table configuration (config is ephemeral)

---

## 8. Internal Tables

The following ClickHouse tables are considered "internal" and are the only ones this feature applies to in v1:

- `semantic_events`
- `data_points`
- `entities`

These tables share characteristics:
- Partitioned by tenant/account
- Complex column types (Map, Array, Nested)
- Require ARRAY JOIN for flattening
- Query rewriting needed for partition isolation

---

## 9. Prototype Calling Interface

The Python orchestrator's public API — this is what the new TypeScript implementation must replicate:

```python
# Main entry point
run_orchestrator(
    tables=[{"table_name": "semantic_events", "partition": "brimborg.is"}],  # or None for all
    team_name="Default team",
    datasource_name="clickhouse dev",
    datasource_branch="main"
) -> OrchestratorResult

# OrchestratorResult:
#   success: bool
#   generated_files: Dict[str, str]     # table_name → file_path
#   upload_results: List[UploadResult]
#   error_message: Optional[str]
#   execution_time: Optional[float]
```

When `tables=None`, processes all tables in the YAML config. When provided, processes only specified tables with optional partition override. Tables not found in config are skipped with a warning.

---

## 10. Existing Hasura Action Signature (gen_dataschemas)

The current action that smart generation runs alongside (not replaces):

```graphql
# From /Users/stefanbaxter/Development/synmetrix/services/hasura/metadata/actions.graphql
type Mutation {
  gen_dataschemas(
    datasource_id: uuid!
    branch_id: uuid!
    tables: [SourceTable!]!
    overwrite: Boolean
    format: String           # "yaml" or "js"
  ): GenSourceSchemaOutput
}

input SourceTable {
  name: String!
  schema: String!
}

type GenSourceSchemaOutput {
  message: String
  code: String!
}
```

From `actions.yaml`: handler = `{{ACTIONS_URL}}/rpc/gen_schemas`, timeout = 180s, permissions = `[role: user]`.

---

## 11. Existing Frontend GraphQL Mutations (Schema Operations)

```graphql
# From /Users/stefanbaxter/Development/client-v2/src/graphql/gql/datasources.gql
mutation GenDataSchemas(
  $datasource_id: uuid!
  $branch_id: uuid!
  $tables: [SourceTable!]!
  $overwrite: Boolean
  $format: String
) { gen_dataschemas(...) { code message } }

query FetchTables($id: uuid!) { fetch_dataset(datasource_id: $id) { ... } }
query FetchMeta($datasource_id: uuid!, $branch_id: uuid!) { fetch_meta(...) { cubes { ... } } }

# From /Users/stefanbaxter/Development/client-v2/src/graphql/gql/versions.gql
mutation CreateVersion($object: versions_insert_input!) {
  insert_versions_one(object: $object) { id checksum created_at }
}

query CurrentVersion($branch_id: uuid!) {
  versions(where: {branch_id: {_eq: $branch_id}}, order_by: {created_at: desc}, limit: 1) {
    id checksum created_at dataschemas { id name code }
  }
}
```

---

## 12. Key Source Code Contents

### 12.1 Current queryRewrite.js (Complete)

```javascript
// /Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/queryRewrite.js
const getColumnsArray = (cube) => [
  ...(cube?.dimensions || []),
  ...(cube?.measures || []),
  ...(cube?.segments || []),
];

const queryRewrite = async (query, { securityContext }) => {
  const { userScope } = securityContext;
  const { dataSourceAccessList, role } = userScope;

  if (["owner", "admin"].includes(role)) {
    return query;  // Owners/admins bypass all checks
  }

  if (!dataSourceAccessList) {
    throw new Error("403: You have no access to the datasource");
  }

  // Only checks ACCESS — does NOT modify the query
  const queryNames = getColumnsArray(query);
  const accessNames = Object.values(dataSourceAccessList).reduce(
    (acc, cube) => [...acc, ...getColumnsArray(cube)], []
  );

  queryNames.forEach((cn) => {
    if (!accessNames.includes(cn)) {
      throw new Error(`403: You have no access to "${cn}" cube property`);
    }
  });

  return query;
};
```

### 12.2 Current buildSecurityContext.js (Complete)

```javascript
// /Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/buildSecurityContext.js
const buildSecurityContext = (dataSource, branch, version) => {
  const data = {
    dataSourceId: dataSource.id,
    dbType: dataSource.db_type?.toLowerCase(),
    dbParams: dataSource.db_params,
  };

  data.dbParams = prepareDbParams(data.dbParams, data.dbType);
  const dataSourceVersion = JSum.digest(data, "SHA256", "hex");

  const dataModels =
    version?.dataschemas ||
    branch?.versions?.[0]?.dataschemas ||
    dataSource.branches?.[0]?.versions?.[0]?.dataschemas || [];

  const files = dataModels.map((schema) => schema.id);
  const schemaVersion = createMd5Hex(files);
  const preAggregationSchema = createMd5Hex(data.dataSourceId);

  return { ...data, dataSourceVersion, preAggregationSchema, schemaVersion, files };
};
```

### 12.3 Current defineUserScope.js (Complete)

```javascript
// /Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/defineUserScope.js
export const getDataSourceAccessList = (allMembers, selectedDataSourceId, selectedTeamId) => {
  const dataSourceMemberRole = allMembers.find(
    (member) => member.team_id === selectedTeamId
  )?.member_roles?.[0];

  if (!dataSourceMemberRole) throw new Error("403: member role not found");

  const { access_list: accessList } = dataSourceMemberRole;
  const dataSourceAccessList = accessList?.config?.datasources?.[selectedDataSourceId]?.cubes;
  return { role: dataSourceMemberRole?.team_role, dataSourceAccessList };
};

const defineUserScope = (allDataSources, allMembers, selectedDataSourceId, selectedBranchId, selectedVersionId) => {
  const dataSource = allDataSources.find((source) => source.id === selectedDataSourceId);
  // ... resolves branch (by ID or default "active"), version, access list
  const dataSourceContext = buildSecurityContext(dataSource, selectedBranch, selectedVersion);
  return { dataSource: dataSourceContext, ...dataSourceAccessList };
};
```

### 12.4 Current checkAuth.js (Key Parts)

```javascript
// /Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/checkAuth.js
const checkAuth = async (req) => {
  // Extracts from headers:
  const dataSourceId = req.headers["x-hasura-datasource-id"];
  const branchId = req.headers["x-hasura-branch-id"];
  const branchVersionId = req.headers["x-hasura-branch-version-id"];

  // JWT decode → extract userId
  jwtDecoded = jwt.verify(authToken, JWT_KEY, { algorithms: [JWT_ALGORITHM] });
  const { "x-hasura-user-id": userId } = jwtDecoded?.hasura || {};

  // Fetch user data (dataSources + members)
  const user = await findUser({ userId });

  // Build security context
  const userScope = defineUserScope(
    user.dataSources, user.members,
    dataSourceId, branchId, branchVersionId
  );

  req.securityContext = { authToken, userId, userScope };
};
```

### 12.5 CubeJS index.js (How queryRewrite is Registered)

```javascript
// /Users/stefanbaxter/Development/synmetrix/services/cubejs/index.js
import queryRewrite from "./src/utils/queryRewrite.js";

const options = {
  queryRewrite,         // ← Registered here as Cube.js option
  contextToAppId,
  contextToOrchestratorId,
  dbType,
  driverFactory,
  checkAuth,
  repositoryFactory,
  scheduledRefreshContexts,
  // ...
};
```

### 12.6 dataSourceHelpers.js (Version/Schema CRUD)

Key functions used for saving generated models:

```javascript
// /Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/dataSourceHelpers.js
createDataSchema(branchId, schemas, userId)
  // Inserts new version with nested dataschemas via Hasura GraphQL mutation
  // schemas = [{name, code, datasource_id}]
  // Creates checksum from combined code

findDataSchemas(branchId)
  // Fetches latest version's dataschemas for a branch
  // Returns array of {id, name, code, checksum}

findDataSchemasByIds(ids)
  // Fetches specific dataschemas by ID array
```

### 12.7 generateDataSchema.js Route (Current Generation)

```javascript
// /Users/stefanbaxter/Development/synmetrix/services/cubejs/src/routes/generateDataSchema.js
// POST /api/v1/generate-models
// 1. Gets driver from driverFactory
// 2. driver.tablesSchema() → raw DB schema
// 3. Normalizes schema (NO_SCHEMA_KEY for empty schemas)
// 4. ScaffoldingTemplate.generateFilesByTableNames(selectedTables) → model files
// 5. findDataSchemas(branchId) → existing schemas
// 6. Overwrite logic: merge new with existing (or replace all if overwrite=true)
// 7. createDataSchema(branchId, mergedSchemas, userId) → new version
// 8. Purges compiler cache
```

### 12.8 Prototype's Upload GraphQL Query (Fetching Existing Models for Merge)

```graphql
# Used by upload_cubes_to_synmetrix.py to fetch existing models before merge
query GetLatestVersion($branchId: uuid!) {
  versions(
    where: {branch_id: {_eq: $branchId}}
    order_by: {created_at: desc}
    limit: 1
  ) {
    id
    checksum
    created_at
    dataschemas {
      name
      code
    }
  }
}
```

---

## 13. New Smart Merge vs Prototype Merge

The prototype's merge operates at the **model file level** (whole file replace/preserve). The new smart merge operates at the **field level within a model**:

**Prototype merge (file-level):**
- Model file exists with same name + same content → preserve
- Model file exists with same name + different content → replace entire file
- Model file doesn't exist → add

**New smart merge (field-level, using `meta.auto_generated`):**
- Parse existing model YAML into dimensions/measures/segments
- For each field in existing model:
  - Has `meta.auto_generated: true` → system-managed, can be updated/removed
  - No `auto_generated` tag → user-owned, always preserved
- For each field from new profiling:
  - Matching auto-generated field exists → update SQL/type, **preserve description**
  - No matching field → add with `meta.auto_generated: true`
- Auto-generated fields in existing model not in new profiling → remove (column was dropped)
- User fields → always kept as-is, regardless of profiling output

This is a fundamental difference from the prototype — the new system works **inside** model files, not just between them.

---

## 14. Example Generated YAML (Target Output)

What a smart-generated model should look like after profiling `semantic_events` with partition `brimborg.is`:

```yaml
cubes:
  - name: semantic_events
    description: "Auto-generated raw cube for cst.semantic_events"
    sql_table: cst.semantic_events
    dimensions:
      - name: entity_gid
        sql: "{CUBE}.entity_gid"
        type: string
        primary_key: true
        public: true
        meta:
          auto_generated: true
      - name: event_type
        sql: "{CUBE}.event_type"
        type: string
        meta:
          auto_generated: true
      - name: timestamp
        sql: "{CUBE}.timestamp"
        type: time
        meta:
          auto_generated: true
      - name: traits_city
        sql: "{CUBE}.traits['city']"
        type: string
        description: "User-edited description that survives re-profiling"
        meta:
          auto_generated: true
      - name: custom_cohort        # User-added, no auto_generated tag — never touched
        sql: "CASE WHEN {CUBE}.traits['plan'] = 'pro' THEN 'power' ELSE 'free' END"
        type: string
    measures:
      - name: revenue
        sql: "{CUBE}.metrics['revenue']"
        type: sum
        meta:
          auto_generated: true
      - name: count
        type: count
        meta:
          auto_generated: true

  - name: products                 # Flattened cube via ARRAY JOIN
    description: "Flattened cube via ARRAY JOIN on commerce.products for cst.semantic_events"
    sql: >
      SELECT *, products.product_id, products.quantity, products.price
      FROM cst.semantic_events
      LEFT ARRAY JOIN commerce.products AS products
    dimensions:
      - name: entity_gid
        sql: "{CUBE}.entity_gid"
        type: string
        primary_key: true
        public: true
        meta:
          auto_generated: true
      - name: product_id
        sql: "products.product_id"
        type: string
        meta:
          auto_generated: true
    measures:
      - name: quantity
        sql: "products.quantity"
        type: sum
        meta:
          auto_generated: true
      - name: price
        sql: "products.price"
        type: sum
        meta:
          auto_generated: true
```

---

## 15. ClickHouse Type Parsing Details

The profiler recursively parses ClickHouse type strings. Key parsing rules that must be ported:

```
Input: "LowCardinality(Nullable(String))"
  → Peel annotations: [lowcardinality, nullable]
  → Core type: string
  → ColumnType: BASIC, ValueType: STRING

Input: "Array(Map(String, Float64))"
  → Core type: array
  → Args[0]: Map(String, Float64)
    → Core type: map
    → Key: String → ValueType.STRING
    → Value: Float64 → ValueType.NUMBER
  → ColumnType: ARRAY (parent is Array(Map))

Input: "Map(String, UInt64)"
  → Core type: map
  → ColumnType: MAP, key_data_type: STRING, value_data_type: NUMBER

Dotted column name: "commerce.product_id"
  → parent_name: "commerce", child_name: "product_id"
  → ColumnType: GROUPED (if parent is a real Map/Array(Map) column)
  → SQL access: depends on parent type (Map key vs Array(Map) key)
```

ValueType resolution:
- `string`, `fixedstring`, `enum*` → STRING
- `int*`, `uint*`, `float*`, `decimal*`, `double` → NUMBER
- `date*`, `datetime*` → DATE
- `uuid` → UUID
- `bool*` → BOOLEAN
- Everything else (point, tuple, etc.) → OTHER

---

## 16. Profiling SQL Patterns (Must Port to TypeScript)

These are the exact ClickHouse SQL patterns generated by `profile_table.py` that the TypeScript implementation must reproduce:

**Basic string column:**
```sql
uniq(`column_name`) as column_name__distinct_count,
countIf(`column_name` IS NOT NULL and `column_name` != '') as column_name__value_rows
```

**Basic number/date column:**
```sql
min(`column_name`) as column_name__min_value,
max(`column_name`) as column_name__max_value,
countIf(`column_name` IS NOT NULL) as column_name__value_rows
```

**Map column (discover keys):**
```sql
groupUniqArrayArray(mapKeys(`column_name`)) as column_name__map_keys,
arrayUniq(flatten(groupArrayArray(mapKeys(`column_name`)))) as column_name__distinct_count,
countIf(length(mapKeys(`column_name`)) > 0) as column_name__value_rows
```

**Map key extraction (string value):**
```sql
uniq(`parent`['key_name']) as parent_key__distinct_count,
countIf(`parent`['key_name'] IS NOT NULL and `parent`['key_name'] != '') as parent_key__value_rows
```

**Map key extraction (numeric value):**
```sql
min(`parent`['key_name']) as parent_key__min_value,
max(`parent`['key_name']) as parent_key__max_value,
countIf(`parent`['key_name'] IS NOT NULL) as parent_key__value_rows
```

**Array column (string elements):**
```sql
countIf(arrayExists(x -> x != '', `column_name`)) as column_name__value_rows,
arrayUniq(arrayFilter(x -> x != '', arrayFlatten(groupArray(`column_name`)))) as column_name__distinct_count
```

**Array(Map) key extraction (string value):**
```sql
arrayUniq(arrayFlatten(arrayMap(m -> m['key_name'], `parent`))) as parent_key__distinct_count,
sum(arrayLength(arrayFilter(v -> v IS NOT NULL and v != '', arrayMap(m -> m['key_name'], `parent`)))) as parent_key__value_rows
```

**Nested column (type discovery):**
```sql
arrayDistinct(arrayFlatten(groupArray(`parent.type_column`))) as parent__map_keys,
countIf(length(arrayFlatten(`parent.type_column`)) > 0) as parent__value_rows
```

**Low-cardinality probe (for columns with <200 unique values):**
```sql
arraySort(groupUniqArray(`column_name`)) as column_name__column_name__map_keys
-- For Map columns with LC keys:
arraySort(groupUniqArray(trim(`column_name`['map_key']))) as column_name__map_key__map_keys
```

**Batching:** 10 columns per query. On failure, falls back to individual column queries.

**WHERE clause:** All queries append `WHERE partition IN ['value']` when partition is specified.

---

## 17. Technology Choices Still To Be Made

1. **Template engine** for Cube YAML generation — Handlebars, Nunjucks, EJS, or TypeScript template literals
2. **ClickHouse client library** for TypeScript — `@clickhouse/client` (official), `clickhouse` npm package, or route through CubeJS's existing driver
3. **Where profiling code lives** — in CubeJS service (has driver access) vs Actions service (has RPC pattern) vs new dedicated service
4. **Query rewrite approach for partition** — `sql_where` in model template vs `queryRewrite` filter injection vs both
