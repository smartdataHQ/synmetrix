# Research: Dynamic Model Creation

**Branch**: `004-dynamic-model-creation` | **Date**: 2026-03-08

## Decision 1: Where Profiling Code Lives

**Decision**: CubeJS service (`services/cubejs/src/utils/smart-generation/`)

**Rationale**: CubeJS already has driver access via `driverFactory`, the existing `runSql.js` route demonstrates raw SQL execution (`driver.query()`), and the existing `generateDataSchema.js` route handles the full generate-merge-save cycle. Putting profiling in CubeJS follows the established pattern where CubeJS owns all driver-level operations and schema persistence (via Hasura GraphQL). Actions RPC handlers remain thin proxies.

**Alternatives considered**:
- Actions service: Rejected — no direct driver access. Would require either duplicating driver infrastructure or adding a new HTTP call to CubeJS anyway.
- New dedicated service: Rejected — violates Constitution V (Simplicity/YAGNI). Adding a 7th service for one feature is unjustified.

## Decision 2: Template Engine for YAML Generation

**Decision**: No template engine. Build cube objects as plain JavaScript, then serialize with the `yaml` package (`yaml@^2.3.4`, already in CubeJS dependencies).

**Rationale**: The output is structured data (cubes with dimensions/measures). Building it as a JS object and calling `yaml.stringify()` is simpler, type-safe, and easier to test than string-based templating. It avoids a new dependency and aligns with Constitution V (Simplicity).

**Alternatives considered**:
- Handlebars/Nunjucks/EJS: Rejected — adds dependency, harder to test, string interpolation is error-prone for YAML indentation.
- Template literals: Considered but less robust than object → YAML serialization for handling edge cases (special characters in Map keys, nested structures).

## Decision 3: ClickHouse Client for Profiling

**Decision**: Use the existing CubeJS ClickHouse driver's `driver.query(sql)` method. No new dependency.

**Rationale**: The `@cubejs-backend/clickhouse-driver` already wraps `@clickhouse/client@^1.7.0`. Its `query()` method returns parsed JSON results. The `driverFactory` creates a driver instance per security context, maintaining multi-tenancy isolation. The existing `runSql.js` route proves this pattern works for arbitrary SQL.

**Alternatives considered**:
- Direct `@clickhouse/client` usage: Rejected — would bypass CubeJS's driver lifecycle, connection pooling, and security context isolation.
- `clickhouse` npm package: Rejected — the official client is already available transitively.

## Decision 4: YAML Parsing for Smart Merge

**Decision**: Use `yaml` package (`yaml@^2.3.4`) in CubeJS service for both parsing existing models and serializing new ones.

**Rationale**: The `yaml` package supports round-trip parsing (preserves comments, formatting) and provides a DOM API for targeted modifications. This is critical for the field-level merge — we need to parse existing YAML, identify fields by their `meta.auto_generated` tag, modify/add/remove specific fields, and serialize back without destroying formatting.

**Alternatives considered**:
- `js-yaml` (in Actions): Available but Actions isn't where merge happens. Also, `js-yaml` doesn't support round-trip or comment preservation.

## Decision 5: Partition Threading Through Security Context

**Decision**: Thread partition from `teams.settings` through the existing security context chain: `findUser()` → `defineUserScope()` → `buildSecurityContext()`. Partition filtering at runtime is handled by using `sql` with a WHERE clause in the generated model (see Decision 8), NOT by `queryRewrite()`.

**Rationale**: This follows the existing pattern exactly. The security context already carries datasource-level config. Adding team-level settings (partition, internal tables list) requires:
1. Migration to add `settings` JSONB column to `teams` table
2. Extend `findUser()` GraphQL query to include `team.settings`
3. Extend `defineUserScope()` to extract and pass partition + internal tables
4. Extend `buildSecurityContext()` to include partition in the context hash (for cache isolation)

The partition and internal tables values flow through the security context so profiling routes can access them. Runtime query filtering is NOT done in `queryRewrite()` (see Decision 8 for why).

## Decision 6: Two-Step Flow Architecture

**Decision**: Two separate CubeJS routes + two Hasura actions.

**Rationale**: The two-step UX (profile → review → generate) requires two API calls:
- Step 1: `POST /api/v1/profile-table` — runs profiling, returns ProfiledTable JSON to frontend for preview
- Step 2: `POST /api/v1/smart-generate` — re-profiles, generates YAML, merges, saves version

Re-profiling in step 2 is acceptable because profiling takes seconds (batched SQL queries) and ensures the generation uses fresh data. This avoids server-side caching of ephemeral profile results.

**Alternatives considered**:
- Cache profile results server-side with TTL: Adds complexity (Redis key management, expiry, invalidation). Violates YAGNI.
- Pass profile results from frontend in step 2: Security risk — client could tamper with profiling data.

## Decision 7: New File Organization

**Decision**: New profiling and generation modules in `services/cubejs/src/utils/smart-generation/`.

```
services/cubejs/src/utils/smart-generation/
├── profiler.js          — ClickHouse table profiling (port of profile_table.py)
├── typeParser.js         — ClickHouse type string parser
├── fieldProcessors.js    — Column → dimension/measure classification
├── cubeBuilder.js        — Build cube JS objects from profiled data
├── yamlGenerator.js      — Serialize cube objects to YAML with meta tags
├── merger.js             — Field-level smart merge (auto_generated logic)
└── primaryKeyDetector.js — Primary key auto-detection from ClickHouse schema
```

**Rationale**: Modular by responsibility, mirrors the Python prototype's separation. Each module is independently testable. All live in CubeJS where driver access exists.

**Prototype fidelity**: The profiler (`profile_table.py`), type classification, field processing, and cube generation (`generate_cube_from_profile.py`) are **proven working code**. The JavaScript implementation MUST be a faithful port — same SQL patterns (DESCRIBE TABLE, batched SELECT with `uniqExact`, `groupUniqArrayArray(mapKeys())`, etc.), same field classification logic (Map values→measures for numeric, dimensions for string), same output shape. New functionality (merge, SSE, provenance, auto_generated tagging) is additive. The prototype's file-level replacement (`upload_cubes_to_synmetrix.py`) is NOT ported — it is replaced by the new smart merger with field-level granularity.

## Decision 8: Partition Filtering via `sql` with WHERE Clause (Not queryRewrite)

**Decision**: Embed partition filtering in the generated YAML model's `sql` property (using `sql` with a WHERE clause instead of `sql_table`), not in `queryRewrite()`. Note: `sql_where` is NOT a valid Cube.dev property — use `sql` with embedded WHERE instead.

**Rationale**: The existing `queryRewrite.js` has an early return for owner/admin roles (line 26-28) that bypasses all checks. If partition filtering lived in queryRewrite, owners and admins would bypass partition isolation entirely — a critical security/correctness gap. By using `sql: "SELECT * FROM {schema}.{table} WHERE partition = '{value}'"` instead of `sql_table`, the filter is part of the model's SQL definition and applies to all queries regardless of role. This also avoids the brittle `internalTables.includes(cubeName)` matching problem for flattened ARRAY JOIN cubes (whose names differ from the source table). Cube.dev docs confirm `sql` accepts arbitrary valid SQL including WHERE clauses.

**Generated output example** (partitioned internal table):
```yaml
cubes:
  - name: semantic_events
    sql: "SELECT * FROM cst.semantic_events WHERE partition = 'brimborg.is'"
```

**Generated output example** (non-partitioned or non-internal table):
```yaml
cubes:
  - name: semantic_events
    sql_table: cst.semantic_events
```

**Alternatives considered**:
- `sql_where` property: Rejected — does not exist in Cube.dev. Not a valid YAML model property.
- queryRewrite injection: Rejected — owner/admin bypass at line 26-28 would skip partition filtering. Also requires runtime cube-name-to-table matching which breaks for flattened cubes.
- Separate pre-queryRewrite stage: Considered — would work but adds a new stage to the pipeline. Embedding in `sql` is simpler and self-contained (Constitution V).

## Decision 9: Smart-Generated Filename Convention

**Decision**: Smart-generated model files use the convention `{table_name}.yml` (e.g., `semantic_events.yml`). If a schema prefix is needed to avoid collisions across databases, use `{schema}_{table_name}.yml`.

**Rationale**: The filename must be predictable so the merger can locate existing models for re-profile. Using the table name directly matches how users think about their models. The `.yml` extension is consistent with YAML-only output (FR-018). The existing `generateDataSchema.js` creates files named after tables, so this follows the established convention.

**Alternatives considered**:
- UUID-based filenames: Rejected — not human-readable, breaks the user's mental model.
- Hash-based filenames: Rejected — same issue, and makes re-profile lookup harder.

## Decision 10: Branch Scoping — Always Pass branchId to CubeJS Client

**Decision**: New Actions RPC handlers (`profileTable.js`, `smartGenSchemas.js`) MUST pass `branchId` into the `cubejsApi()` constructor, not just in the POST body.

**Rationale**: There is a pre-existing branch-scoping mismatch in the current codebase. `cubejsApi.js:127` accepts `branchId` and sets the `x-hasura-branch-id` header at line 141-143, which CubeJS uses in `checkAuth.js:28` → `defineUserScope.js:44` to resolve the selected branch and its current version. However, the existing `genSchemas.js:16` does NOT pass `branchId` to the constructor — it only sends it in the POST body. This means CubeJS's security context resolves against the **default branch** while the save path writes to the requested branch.

For smart generation, correct branch scoping is critical because:
- `profile_table` must read existing schemas from the user's selected branch (for context)
- `smart_generate` must merge against the current model in that branch
- The new version must be written to that same branch
- Cache isolation (security context hash) must reflect the correct branch's schemas

The fix: always construct the CubeJS API client with `branchId`:
```javascript
cubejsApi({ dataSourceId, branchId, userId, authToken })
```

**Note**: This is a pre-existing bug in `genSchemas.js` (current standard generation). We fix it for the new handlers; fixing the existing handler is outside scope but should be done separately.

**Alternatives considered**:
- Fix `genSchemas.js` in this feature: Considered — but risks regression in existing generation flow. Better as a separate fix.
