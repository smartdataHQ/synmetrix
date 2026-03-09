# 004a: Dynamic Field Resolution via asyncModule — Deferred Research

## Status: Research Complete, Implementation Deferred

This document is a companion to [004-smart-model-generation.md](./004-smart-model-generation.md). It covers the dynamic dimension rewriting feature that was explored during the smart model generation research but deferred from v1 scope. This document contains everything needed to pick up this work in a future session.

---

## 0. Context

### The Problem

ClickHouse tables used internally (semantic_events, data_points, entities) contain Map columns like `metrics Map(String, Float64)` and `traits Map(String, String)`. These Maps have dynamic keys that vary per tenant/partition. The naive approach generates a static dimension per discovered key (e.g., `metrics_revenue`, `metrics_clicks`, `traits_city`), which:

- Produces hundreds of dimensions for tables with many Map keys
- Becomes stale when new keys appear in the data
- Requires re-profiling and re-generation to discover new keys
- Creates bloated cube definitions

### The Goal

Support dynamic field access where:
```
Query: Events.metrics_revenue    →  SQL: metrics['revenue']
Query: Events.traits_city        →  SQL: traits['city']
Query: Events.ids_customer_id    →  SQL: nested type lookup by ID column
```

...without pre-defining every possible key as a static dimension in YAML. Instead, dimensions are generated dynamically at schema compilation time from profiled data, and the schema recompiles when the data evolves.

### Relationship to 004

In the main smart model generation spec (004), this feature is listed under "May Include (v1, needs further work)" / Section 5.5. The main spec handles static field generation with `meta.auto_generated` tagging. This document covers the dynamic alternative that can replace or complement static generation for Map/Nested columns specifically.

---

## 1. The Core Constraint

Cube.js validates all query members against the **compiled schema** before execution. There is **no mechanism** to pass an undefined field through validation. Every queryable field must be a compiled dimension or measure at the time the query is processed.

This means:
- `queryRewrite` cannot inject ad-hoc SQL — it can only reference already-compiled members
- There is no "wildcard dimension" or "parameterized dimension" concept in Cube.js
- The SQL API has limited member expressions, but these are blocked on the REST API path

**The only viable approach is to generate the dimensions dynamically at schema compilation time.**

### Query Processing Pipeline (Exact Execution Order)

Understanding this order is critical — it proves why `queryRewrite` cannot solve the dynamic field problem:

```
1. HTTP request received (REST API or GraphQL)
2. Query parsed from input
3. normalizeQuery() — Joi schema validation (STRUCTURAL ONLY)
   └─ Checks member names match regex: ^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$
   └─ Does NOT check if members exist in schema
4. applyRowLevelSecurity() — RBAC filters from access policies
5. queryRewrite() — custom rewrite function (Synmetrix's access control)
   └─ Can modify query.dimensions, query.measures, query.filters
   └─ BUT can only reference members that exist in compiled schema
6. normalizeQuery() — runs AGAIN on the rewritten query
7. Schema compiler (CubeEvaluator) — resolves member names to SQL
   └─ THIS is where undefined members FAIL
   └─ "Cannot find member 'Events.metrics_revenue'" if not in compiled schema
```

So even though `queryRewrite` can add member names to the query, the schema compiler (step 7) will reject any member not defined at compilation time. The only solution is to ensure members exist at compilation time — hence `asyncModule`.

### Member Expressions (SQL API Only)

The SQL API supports a special `SqlFunction` member expression type:
```javascript
{
  type: 'SqlFunction',
  cubeName: 'Events',
  alias: 'metrics_revenue',
  expr: "metrics['revenue']"
}
```

These bypass normal member validation. However, the REST API explicitly blocks them:
```javascript
// gateway.js line 883
'Expressions are not allowed in this context'
```

Since Synmetrix's frontend uses REST/GraphQL, this is not viable for the general case.

---

## 2. Recommended Architecture: `asyncModule` + JS Data Models

### 2.1 How asyncModule Works

Cube.js supports JavaScript data model files (not just YAML). These run in a VM sandbox during schema compilation. The `asyncModule()` global accepts an async callback that can:

- Fetch data from databases or APIs
- Use any JavaScript logic (loops, conditionals, async/await)
- Call `cube()` to programmatically define cubes with computed dimensions/measures

```javascript
asyncModule(async () => {
  const keys = await fetchMapKeys('cst', 'semantic_events', 'metrics');

  cube('SemanticEvents', {
    sql_table: 'cst.semantic_events',
    dimensions: {
      entity_gid: {
        sql: `${CUBE}.entity_gid`,
        type: 'string',
        primary_key: true,
        meta: { auto_generated: true }
      },
      // Dynamically generated from Map keys
      ...Object.fromEntries(
        keys.map(key => [
          `metrics_${sanitize(key)}`,
          {
            sql: `${CUBE}.metrics['${key}']`,
            type: 'number',
            meta: { auto_generated: true, map_column: 'metrics', map_key: key }
          }
        ])
      ),
    },
    measures: {
      count: { type: 'count' },
      // Numeric Map keys as sum measures
      ...Object.fromEntries(
        numericKeys.map(key => [
          `metrics_${sanitize(key)}_sum`,
          {
            sql: `${CUBE}.metrics['${key}']`,
            type: 'sum',
            meta: { auto_generated: true, map_column: 'metrics', map_key: key }
          }
        ])
      ),
    },
  });
});
```

### 2.2 Why This Works

- Dimensions generated via `asyncModule` are **real, first-class compiled members**
- Standard Cube.js query validation works — no bypassing, no special paths
- Pre-aggregations work with these dimensions
- The Meta API exposes them — frontend can discover available fields for autocomplete/dropdowns
- `meta.auto_generated` and `meta.map_column`/`meta.map_key` tags work normally
- Security context and access control apply as usual

### 2.3 Synmetrix Already Has the Plumbing

The existing Synmetrix CubeJS configuration supports this:

**`repositoryFactory`** (`/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/repositoryFactory.js`):
- Returns schema files per security context
- Currently returns YAML files from the `dataschemas` table
- Can be extended to return JS files with `asyncModule` calls

**`contextToAppId`** (`/Users/stefanbaxter/Development/synmetrix/services/cubejs/index.js`, line 40):
- Already isolates schemas per datasource (uses `dataSourceVersion` + `schemaVersion`)
- Different datasources get completely separate schema compilations

**`schemaVersion`** (`/Users/stefanbaxter/Development/synmetrix/services/cubejs/index.js`, line 43):
- Controls recompilation — when the returned value changes, Cube.js recompiles
- Can be extended to include a hash of current Map keys

**Schema compiler sandbox** (`@cubejs-backend/schema-compiler`, `DataSchemaCompiler.compileJsFile`, lines 388-446):
- Provides `cube()`, `view()`, `asyncModule()`, `require()`, `COMPILE_CONTEXT` as globals
- JS code runs in a VM sandbox during compilation
- `COMPILE_CONTEXT.securityContext` contains the same object as `req.securityContext` — includes `authToken`, `userId`, `userScope` (with `dataSource`, `dataSourceAccessList`, `role`)

### 2.4 Current repositoryFactory Implementation

The existing code that returns schema files to the Cube.js compiler:

```javascript
// /Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/repositoryFactory.js
const repositoryFactory = ({ securityContext }) => {
  return {
    dataSchemaFiles: async () => {
      const ids = securityContext?.userScope?.dataSource?.files;
      const dataSchemas = await findDataSchemasByIds({ ids });
      return dataSchemas.map(mapSchemaToFile);
    },
  };
};

// /Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/mapSchemaToFile.js
const mapSchemaToFile = (schema) => ({
  fileName: schema.name,    // e.g., "semantic_events_cube.yml"
  readOnly: true,
  content: schema.code,     // YAML or JS content
});
```

**Key insight**: `fileName` determines how Cube.js processes the file. Files ending in `.js` are compiled via `compileJsFile()` (VM sandbox with `asyncModule` support). Files ending in `.yml`/`.yaml` are parsed as YAML. The `repositoryFactory` already supports both — it just returns whatever `name` and `code` are stored in the `dataschemas` table. **No changes needed to repositoryFactory for JS file support** — just save the model with a `.js` filename.

### 2.5 CubeJS Configuration (Full Context)

```javascript
// /Users/stefanbaxter/Development/synmetrix/services/cubejs/index.js
const contextToAppId = ({ securityContext }) =>
  `CUBEJS_APP_${securityContext?.userScope?.dataSource?.dataSourceVersion}_${securityContext?.userScope?.dataSource?.schemaVersion}}`;

const schemaVersion = ({ securityContext }) =>
  securityContext?.userScope?.dataSource?.schemaVersion;
  // schemaVersion = MD5 hash of dataschema file IDs (from buildSecurityContext.js)
  // Changes when any schema file is added/updated/removed in a version

const options = {
  queryRewrite,              // Access control (line 58)
  contextToAppId,            // Schema cache key — per datasource+version (line 59)
  schemaVersion,             // Recompilation trigger (line 66)
  repositoryFactory,         // Schema file provider (line 68)
  driverFactory,             // DB driver per context (line 67)
  checkAuth,                 // JWT + security context (line 63)
  // ... other options
};
```

**Schema compilation cache**: `CompilerApi` uses an LRU cache keyed by `contextToAppId`. When `schemaVersion` changes for a given `contextToAppId`, the cache entry is invalidated and `repositoryFactory.dataSchemaFiles()` is called again to fetch fresh files.

---

## 3. Implementation Design

### 3.1 Profiling Cache

The profiler (from 004) discovers Map keys, Nested types, and LC values. For dynamic fields, this profiling output needs to be accessible at schema compilation time. Options:

**Option A — Database storage:**
Store profiling results in a new table (e.g., `profiling_cache`) keyed by `(datasource_id, table_name, partition)`. The `asyncModule` code queries this table at compile time.

**Option B — In-memory cache (Redis):**
Store profiling results in Redis with a TTL. Faster reads, but requires Redis dependency (already planned for WorkOS sessions).

**Option C — Embedded in the schema file:**
The template system generates a JS file that embeds the profiling output as a JSON constant. No external lookup needed at compile time. Requires regenerating the file on re-profile.

**Recommended: Option C for v1.** It's the simplest — the template renders a self-contained JS file. The `asyncModule` call doesn't need to fetch anything; the keys are already in the file. Re-profiling regenerates the file and bumps `schemaVersion`.

Example generated JS file:
```javascript
// Auto-generated by smart model generation
// Profiled: 2026-03-08T12:00:00Z
// Table: cst.semantic_events
// Partition: brimborg.is

const PROFILE = {
  map_columns: {
    metrics: {
      keys: ['revenue', 'clicks', 'impressions', 'conversion_rate'],
      key_type: 'String',
      value_type: 'Number'
    },
    traits: {
      keys: ['city', 'country', 'plan', 'source'],
      key_type: 'String',
      value_type: 'String'
    }
  },
  array_join_columns: ['commerce.products'],
  primary_keys: ['entity_gid'],
  lc_values: {
    event_type: ['page_view', 'identify', 'track', 'purchase'],
    traits_plan: ['free', 'pro', 'enterprise']
  }
};

cube('SemanticEvents', {
  sql_table: 'cst.semantic_events',

  dimensions: {
    entity_gid: {
      sql: `${CUBE}.entity_gid`,
      type: 'string',
      primary_key: true,
      meta: { auto_generated: true }
    },
    event_type: {
      sql: `${CUBE}.event_type`,
      type: 'string',
      meta: { auto_generated: true }
    },
    // Dynamic Map dimensions: traits
    ...Object.fromEntries(
      PROFILE.map_columns.traits.keys.map(key => [
        `traits_${key.replace(/[^a-z0-9_]/gi, '_')}`,
        {
          sql: `${CUBE}.traits['${key}']`,
          type: 'string',
          meta: { auto_generated: true, map_column: 'traits', map_key: key }
        }
      ])
    ),
  },

  measures: {
    count: { type: 'count', meta: { auto_generated: true } },
    // Dynamic Map measures: metrics (numeric values → sum)
    ...Object.fromEntries(
      PROFILE.map_columns.metrics.keys.map(key => [
        `metrics_${key.replace(/[^a-z0-9_]/gi, '_')}`,
        {
          sql: `${CUBE}.metrics['${key}']`,
          type: 'sum',
          meta: { auto_generated: true, map_column: 'metrics', map_key: key }
        }
      ])
    ),
  },
});
```

### 3.2 Schema Recompilation on Re-Profile

When the user triggers re-profiling:

1. Profiler runs, discovers current Map keys
2. Template generates updated JS file with new `PROFILE` constant
3. File is saved as a new version (via existing `createDataSchema`)
4. `schemaVersion` changes (because the file content changed → different checksum)
5. Cube.js detects the version change and recompiles
6. New dimensions become queryable immediately

No manual cache invalidation needed — the existing version/checksum system handles it.

### 3.3 Smart Merge with Dynamic Fields

The `meta` tags enable merge:

```javascript
meta: {
  auto_generated: true,    // System-managed field
  map_column: 'metrics',   // Which Map column this came from
  map_key: 'revenue'       // Which key in the Map
}
```

On re-profile:
- Fields with `meta.auto_generated: true` + `meta.map_column` → regenerated from new profiling
- Fields with `meta.auto_generated: true` without `map_column` → regular auto fields (same rules as 004)
- Fields without `auto_generated` → user-owned, never touched

If a Map key disappears from the data, the corresponding dimension is removed (because it won't be in the new PROFILE). If a new key appears, a new dimension is added.

### 3.4 Nested Column / ARRAY JOIN Integration

The same pattern works for Nested columns with a type/ID lookup:

```javascript
// For nested structure like ids.customer_id, ids.device_id
// where 'ids' is a Nested column with type_column 'id_type'
const NESTED_TYPES = {
  ids: {
    type_column: 'id_type',
    known_types: ['customer_id', 'device_id', 'session_id'],
    value_column: 'id_value'
  }
};

// Generate a dimension per known type
...Object.fromEntries(
  NESTED_TYPES.ids.known_types.map(idType => [
    `ids_${idType}`,
    {
      sql: `arrayElement(${CUBE}.ids.id_value, indexOf(${CUBE}.ids.id_type, '${idType}'))`,
      type: 'string',
      meta: { auto_generated: true, nested_column: 'ids', nested_type: idType }
    }
  ])
)
```

### 3.5 LC Values for Frontend Autocomplete

The profiling output includes low-cardinality values (columns with <200 unique values). These can be exposed via the Meta API through `meta` tags:

```javascript
event_type: {
  sql: `${CUBE}.event_type`,
  type: 'string',
  meta: {
    auto_generated: true,
    lc_values: ['page_view', 'identify', 'track', 'purchase']
  }
}
```

The frontend reads `meta.lc_values` to populate filter dropdowns and autocomplete without making additional queries.

---

## 4. What Won't Work (Explored and Rejected)

| Mechanism | Why It Fails |
|-----------|-------------|
| **`queryRewrite` alone** | Can only reference already-compiled members. Cannot inject ad-hoc SQL or create new dimensions at query time. Runs after compilation. |
| **`COMPILE_CONTEXT` in YAML** | Resolved once per `contextToAppId` at compile time. Cannot vary per query. Cannot iterate over dynamic keys in YAML syntax. |
| **`extends` / polymorphic cubes** | Static definition only. No runtime dynamism unless combined with `asyncModule`. |
| **`contextToRoles`** | Controls visibility of existing members, cannot create new ones. |
| **REST API member expressions** | Explicitly blocked: `'Expressions are not allowed in this context'` (gateway.js line 883). Only available via SQL API. |
| **SQL API member expressions** | Works for SQL protocol consumers, but Synmetrix frontend uses REST/GraphQL. Not a general solution. Only useful for direct SQL API access. |
| **Jinja templates in YAML** | Requires Cube.js Python/native extension. Not available in the JS-based Cube.js deployment Synmetrix uses. |

---

## 5. Relevant Source Files

### Cube.js Internals (in Synmetrix's node_modules)

| File | Purpose |
|------|---------|
| `node_modules/@cubejs-backend/server-core/dist/src/core/CompilerApi.js` | Schema compilation, LRU cache, `schemaVersion` handling |
| `node_modules/@cubejs-backend/schema-compiler/dist/src/compiler/DataSchemaCompiler.js` | `compileJsFile()` — VM sandbox for JS schemas, `asyncModule` support (lines 388-446) |
| `node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js` | Query processing pipeline, `queryRewrite` execution order (lines 880-911), member expression blocking (line 883) |
| `node_modules/@cubejs-backend/api-gateway/dist/src/query.js` | Joi validation schema for queries — structural regex check (line 46) |
| `node_modules/@cubejs-backend/schema-compiler/dist/src/compiler/CubeEvaluator.js` | Member resolution — resolves `CubeName.dimension_name` to SQL |

### Synmetrix Files (Must Understand for Integration)

| File | Absolute Path | Relevance |
|------|------|-----------|
| CubeJS entry | `/Users/stefanbaxter/Development/synmetrix/services/cubejs/index.js` | `contextToAppId` (line 40), `schemaVersion` (line 43), `repositoryFactory` (line 68), `queryRewrite` (line 58) |
| Repository factory | `/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/repositoryFactory.js` | Returns schema files per context — must support JS files |
| Query rewrite | `/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/queryRewrite.js` | Access control only today. May need extension for partition filtering (separate from dynamic fields). |
| Build security context | `/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/buildSecurityContext.js` | Creates context including `schemaVersion` hash |
| Data source helpers | `/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/dataSourceHelpers.js` | `createDataSchema()`, `findDataSchemas()` — stores/retrieves model files |
| Generate data schema | `/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/routes/generateDataSchema.js` | Current generation route — new smart generation runs parallel |

### Python Prototype (Reference for Profiling Logic)

| File | Absolute Path | Relevance |
|------|------|-----------|
| Profile table | `/Users/stefanbaxter/Development/cxs-inbox/libs/core/cxs/core/utils/profile_table.py` | Map key discovery, Nested type discovery, LC probe — all needed for PROFILE constant |
| Field processors | `/Users/stefanbaxter/Development/cxs-inbox/cube/utils/field_processors.py` | `MapFieldProcessor` — how Map keys become fields |
| Cube generator | `/Users/stefanbaxter/Development/cxs-inbox/cube/generate_cube_from_profile.py` | `_profile_array_join_columns()`, `build_cube_yaml()` — the generation logic to port |

---

## 6. Open Questions for Implementation

1. **JS vs YAML model files**: Should smart-generated models always be JS files (to support `asyncModule`), or should we generate YAML for simple cases and JS only when dynamic fields are needed? The `repositoryFactory` must handle both.

2. **PROFILE constant size**: For tables with many Map keys (hundreds), the embedded PROFILE could be large. Is there a practical limit on JS file size in Cube.js's schema compiler? The CompilerApi LRU cache stores compiled schemas, not source files, so file size mainly affects compilation time.

3. **User edits to JS files**: The Monaco editor in client-v2 supports JS. But editing a generated JS file is more complex than editing YAML. Should we restrict user edits to YAML-only models and keep dynamic JS models as system-managed?

4. **Hybrid approach**: Could we generate a YAML file for user-visible/editable fields AND a JS file for dynamic Map dimensions? Cube.js loads all files in the schema path, so both would be compiled. The JS file is system-managed; the YAML file is user-editable.

5. **Partition in `sql_where` vs `COMPILE_CONTEXT`**: Since we're already using JS files, the partition filter could be baked in via `sql_where: \`partition = '${COMPILE_CONTEXT.securityContext.partition}'\`` rather than needing `queryRewrite` modification.

6. **Compilation performance**: How long does schema compilation take with `asyncModule` when the PROFILE is embedded (no external fetch)? Need to benchmark with realistic Map key counts (50-500 keys).

---

## 7. Implementation Sequence (When Ready)

1. Ensure `repositoryFactory` can return `.js` files alongside `.yml` files
2. Build a JS template that generates cube definitions from an embedded PROFILE constant
3. Extend the profiling service (from 004) to output PROFILE-compatible JSON
4. Extend the template system (from 004) to render JS files for ClickHouse Map/Nested columns
5. Test schema compilation with dynamic dimensions
6. Expose `meta.lc_values` in the frontend for filter autocomplete
7. Test re-profiling flow: new profile → new JS file → version bump → recompilation → new dimensions available
8. Benchmark compilation performance with realistic key counts

---

## 8. Cube.js Documentation References

- [Dynamic data models (asyncModule)](https://cube.dev/docs/schema/advanced/dynamic-schema-creation/)
- [Data modeling with JavaScript](https://cube.dev/docs/product/data-modeling/dynamic/javascript)
- [Schema execution environment (VM sandbox globals)](https://cube.dev/docs/product/data-modeling/dynamic/schema-execution-environment)
- [Context variables (COMPILE_CONTEXT, SECURITY_CONTEXT)](https://cube.dev/docs/reference/data-model/context-variables)
- [Security context in auth](https://cube.dev/docs/product/auth/context)
- [Multitenancy (contextToAppId, schemaVersion)](https://cube.dev/docs/product/configuration/multitenancy)
- [Custom data model per tenant](https://cube.dev/docs/product/configuration/recipes/custom-data-model-per-tenant)
- [Configuration reference (all options)](https://cube.dev/docs/product/configuration/reference/config)
- [Polymorphic cubes](https://cube.dev/docs/product/data-modeling/concepts/polymorphic-cubes)
- [Code reusability / extends](https://cube.dev/docs/product/data-modeling/concepts/code-reusability-extending-cubes)
- [SQL API](https://cube.dev/docs/product/apis-integrations/core-data-apis/sql-api)
- [SQL API query format](https://cube.dev/docs/product/apis-integrations/sql-api/query-format)
