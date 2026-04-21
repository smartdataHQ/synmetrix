# Implementation Plan: Model Management API

**Branch**: `011-model-mgmt-api` | **Date**: 2026-04-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-model-mgmt-api/spec.md`

## Summary

Five server-side capabilities that let an authenticated agent own the full semantic-model lifecycle without operator assistance: contextual validation of a draft against a branch's deployed cubes, asynchronous invalidation of the compiler cache scoped to a branch's dataschemas, deletion of a dataschema with blocking-reference detection, single-cube compiled-metadata lookup, and structured diff plus rollback between versions on the same branch. All endpoints ship on the existing CubeJS Express router; no new service containers or runtimes are introduced. New handler files land inside **existing** services only — `services/cubejs/src/routes/` (six routes) and `services/actions/src/rpc/` (two audit RPC handlers). Persistence for deletion uses a new Hasura `delete_permissions` block on the existing `dataschemas` table; rollback reuses `insert_versions_one`. Durable audit records for delete + rollback are persisted to a new `audit_logs` table added by this feature; refresh is cache-only and emits a non-durable structured log line only.

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 22.x (already current in cubejs service after 003-update-deps)
**Primary Dependencies**: `@cubejs-backend/schema-compiler` ^1.6.19 (existing; `prepareCompiler` powers validation), `@cubejs-backend/server-core` ^1.6.19 (existing; exposes `cubejs.compilerCache` LRU-cache), `@cubejs-backend/api-gateway` ^1.6.19 (existing; `getCompilerApi` + `filterVisibleItemsInMeta`), `jose` (existing; FraiOS/WorkOS JWT verification), Express 4.x (existing router). No new dependencies.
**Storage**: PostgreSQL via Hasura (existing `dataschemas`, `versions`, `branches` tables — one new Hasura delete-permission migration on `dataschemas`). In-memory LRU compiler cache inside the cubejs process (existing). No new tables.
**Testing**: StepCI workflow tests under `tests/stepci/workflows/model-management/` for end-to-end API contract coverage; Vitest unit tests co-located under `services/cubejs/src/routes/__tests__/` and `services/cubejs/src/utils/__tests__/`. Hasura migration tested via `./cli.sh hasura cli "migrate apply"` in a clean environment per constitution.
**Target Platform**: Linux container (existing cubejs service image `quicklookup/synmetrix-cube`), deployed by Kustomize overlay in the `cxs` repo.
**Project Type**: Web service (single backend service).
**Performance Goals**: Refresh endpoint responds in under 500 ms p95 (eviction is in-process LRU deletion). Contextual validation completes in under 10 s p95 for a branch of up to 50 cubes (bounded by `prepareCompiler` cold-compile time on one core). Diff endpoint responds in under 2 s p95 for versions of up to 50 cubes. Single-cube metadata inherits aggregate-meta latency; SC-005 targets payload reduction rather than wall-clock.
**Constraints**: Compiler-cache invalidation must not clear pre-aggregation cache or user-scope caches (FR-004, Clarification Q1). Rollback must clone only dataschemas (FR-013a, Clarification Q3). Deletion must detect all seven cross-cube reference kinds enumerated in FR-008. Persistent mutating operations (delete, rollback) must emit a durable audit record (FR-016) using the existing Hasura event-trigger pattern already established on `versions.generate_dataschemas_docs`. Refresh is cache-only (FR-004) and emits a non-durable structured log line instead.
**Scale/Scope**: Tens of datasources per tenant, ≤50 cubes per branch, ≤1000 dataschemas across history per datasource; agent call volume is low dozens per minute per tenant.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Service Isolation — PASS

- All endpoints live in the existing `services/cubejs` process and router; no cross-service coupling is introduced.
- The single cross-service contract change is a new Hasura delete permission on `dataschemas`. That is a Hasura-local schema change, not a new service dependency.
- Deletion and rollback both use existing Hasura mutations (`delete_dataschemas_by_pk`, `insert_versions_one`) called via the in-process `fetchGraphQL` helper; no new RPC handler, no new Actions-service endpoint.

### II. Multi-Tenancy First — PASS

- Every endpoint flows through `checkAuth.js` (or an equivalent direct-verify path for routes that do not need a datasource header, exactly mirroring `metaAll.js` and `discover.js`).
- Deletion and rollback invoke `defineUserScope` for the target branch and refuse if the caller's team partition does not include the datasource (same pattern as `resolvePartitionTeamIds`).
- Refresh derives its branch-scoped `schemaVersion` from the caller's resolved scope and only deletes cache entries whose appId matches that `schemaVersion`.
- The compiler-cache invalidation primitive does not touch `buildSecurityContext`; it operates one level above (the LRU cache of compiled APIs keyed by the existing `CUBEJS_APP_{dataSourceVersion}_{schemaVersion}` appId).

### III. Test-Driven Development — PASS

- Every route gets a StepCI workflow in `tests/stepci/workflows/model-management/` before the implementation file compiles. Unit tests co-located under `src/routes/__tests__/` for the validate, refresh, delete, meta-single, diff, and rollback handlers are written before their handlers.
- The Hasura delete-permission migration is verified by a StepCI test that attempts (and expects rejection of) a delete of a dataschema attached to a non-active-branch version.
- The cache-invalidation helper has unit tests that populate a fake LRU cache with known appIds and verify only the branch-scoped entries are removed.

### IV. Security by Default — PASS

- Authentication: every endpoint requires a valid FraiOS, WorkOS, or Hasura HS256 token; unauthenticated requests return 403 before any side effect.
- Authorisation: delete and rollback require owner or admin role on the target datasource's team (enforced by Hasura permissions already present on `dataschemas` and `versions`, plus a new `dataschemas.delete_permissions` block mirroring the existing insert/update policies).
- Visibility filtering: single-cube metadata reuses `apiGateway.filterVisibleItemsInMeta` exactly as `metaAll.js:71` already does.
- Audit: every mutating operation emits an event captured by Hasura's existing event-trigger infrastructure; no new secret, no new log sink.
- No new secret material is introduced. No new outbound network dependency.

### V. Simplicity / YAGNI — PASS

- No new dependency. No new service. No new database table. No new cache store.
- All new logic composes existing primitives: `prepareCompiler` for validation, `cubejs.compilerCache.delete(appId)` for refresh, `findDataSchemasByIds` plus `diffModels` for diff, `findDataSchemas` plus `createDataSchema` for rollback.
- Validation request body intentionally mirrors the existing `POST /api/v1/validate` plus two new fields (`branchId`, `mode`). No new data-shape vocabulary.
- Deletion is a single Hasura mutation wrapped with a cross-reference scan implemented by iterating the already-parsed cubes in memory; no dependency-graph cache.

No constitutional violations. Complexity Tracking table is intentionally empty.

## Project Structure

### Documentation (this feature)

```text
specs/011-model-mgmt-api/
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
├── contracts/                 # Phase 1 output
│   ├── validate-in-branch.yaml
│   ├── refresh-compiler.yaml
│   ├── delete-dataschema.yaml
│   ├── meta-single-cube.yaml
│   ├── version-diff.yaml
│   └── version-rollback.yaml
└── checklists/
    └── requirements.md        # Already created by /speckit.specify
```

### Source Code (repository root)

Single backend service. Additions follow the existing `routes/` + `utils/` split and mirror the layout of `010-dynamic-models-ii`.

```text
services/cubejs/src/
├── routes/
│   ├── validateInBranch.js       # NEW — FR-001..FR-003
│   ├── refreshCompiler.js        # NEW — FR-004, FR-004a, FR-005
│   ├── deleteDataschema.js       # NEW — FR-006, FR-007, FR-008
│   ├── metaSingleCube.js         # NEW — FR-009, FR-010
│   ├── versionDiff.js            # NEW — FR-011, FR-012
│   ├── versionRollback.js        # NEW — FR-013, FR-013a, FR-014
│   ├── index.js                  # MODIFIED — register 6 new routes
│   └── __tests__/
│       ├── validateInBranch.test.js
│       ├── refreshCompiler.test.js
│       ├── deleteDataschema.test.js
│       ├── metaSingleCube.test.js
│       ├── versionDiff.test.js
│       └── versionRollback.test.js
└── utils/
    ├── compilerCacheInvalidator.js   # NEW — invalidateCompilerForBranch()
    ├── referenceScanner.js           # NEW — scanCrossCubeReferences() (FR-008)
    ├── dataSourceHelpers.js          # MODIFIED — add findVersionDataschemas(), deleteDataschema(), rollbackVersion()
    └── __tests__/
        ├── compilerCacheInvalidator.test.js
        └── referenceScanner.test.js

services/hasura/migrations/
└── 1713600000000_dataschemas_delete_permission/
    ├── up.sql
    └── down.sql

tests/stepci/workflows/model-management/
├── validate-in-branch.yml
├── refresh-compiler.yml
├── delete-dataschema.yml
├── meta-single-cube.yml
├── version-diff.yml
└── version-rollback.yml
```

**Structure Decision**: Additive layout mirroring `010-dynamic-models-ii`. All new server code lives inside `services/cubejs/src/`. One Hasura migration. StepCI workflows grouped under a new `tests/stepci/workflows/model-management/` folder. No client-v2 changes are in scope; the frontend continues to use the existing catalog/meta endpoints and is unaffected by the additions.

## Complexity Tracking

No violations. Table intentionally omitted.
