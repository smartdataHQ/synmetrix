# Implementation Plan: Update All Dependencies

**Branch**: `003-update-deps` | **Date**: 2026-03-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-update-deps/spec.md`

## Summary

Upgrade Cube.js from v1.3.x (mixed lockfile state: 1.3.85/1.3.86) to v1.6.x across all backend services, upgrade Node.js from 20 to 22, add 6 new database drivers (Oracle, SQLite, Pinot, RisingWave, SingleStore, Fabric), add 7 missing frontend database tiles (DuckDB + 6 new), enable new Cube.js features (SQL API over HTTP, query pushdown, calendar cubes, multi-stage pre-aggregations, OAuth auth, default timezone, cache control, view member overrides), deprecate the Elasticsearch connector in the UI, and extend Hasura secret masking for OAuth fields.

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 20.19.2 → 22.x (upgrade required)
**Primary Dependencies**: Cube.js v1.3.x → v1.6.x (open-source edition, [cube-js/cube](https://github.com/cube-js/cube)), Express 4.18.2, ioredis 5.3.2, React 18 + Vite 4 + Ant Design 5 (frontend)
**Storage**: PostgreSQL (via Hasura), CubeStore v1.3.x → v1.6.x (one-way partition format upgrade)
**Testing**: StepCI workflow tests (`tests/`), Vitest (frontend), manual integration testing
**Target Platform**: Docker (Linux containers on macOS development, Linux production)
**Project Type**: Web service (microservices monorepo) + React SPA frontend
**Performance Goals**: Data model compilation equal to or faster than baseline; SQL API pushdown queries 30%+ faster than non-pushdown; startup time increase ≤20%
**Constraints**: No rollback plan (dev environment — rebuild from scratch if needed); CubeStore partition format upgrade is one-way; must maintain backward compatibility with all existing datasource connections
**Scale/Scope**: 6 backend services, 1 frontend app, ~30 database driver packages, 22→29 frontend database tiles (MySQL tile already exists; 7 new tiles)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Service Isolation — PASS
- CubeJS upgrade is self-contained within `services/cubejs/`. No simultaneous deployment of other services required unless shared contracts change.
- Actions service does not import `@cubejs-backend/*` npm packages, but `cubejsApi.js` proxies 7 CubeJS REST endpoint groups and normalizes queries via a `queryBaseMembers` allowlist. Response format changes in v1.6 could regress actions-mediated flows (meta, test, generate-models, run-sql, pre-aggregations). The `queryBaseMembers` allowlist strips unknown query properties — new parameters like `cache` must be added. Must audit post-upgrade.
- Frontend proxy configuration (`/api/v1`) already routes to CubeJS; new endpoints are auto-registered.
- Shared contract change: new `POST /api/v1/cubesql` endpoint is additive (no breaking change to existing contracts).

### II. Multi-Tenancy First — PASS (with audit required)
- Content-hashed security contexts (`buildSecurityContext.js`) remain unchanged.
- Cube.js v1.6 stricter access policy matching may affect existing `member_roles.access_list` — audit required (FR-006, FR-007).
- `defineUserScope.js` flow is preserved; no bypass introduced.

### III. Test-Driven Development — PASS
- StepCI tests validate existing API contracts post-upgrade.
- New SQL API over HTTP endpoint requires new StepCI test coverage.
- Frontend changes require `yarn codegen` and `yarn lint` validation.
- Pre-aggregation behavior changes require integration test verification.

### IV. Security by Default — PASS (with masking migration required)
- JWT validation flow (`checkAuth.js`) unchanged.
- SQL API over HTTP endpoint inherits same JWT auth via `cubejs.initApp(app)`.
- OAuth fields for Snowflake/Databricks are additive (existing username/password auth preserved).
- **ACTION REQUIRED**: Hasura `hide_password()` function only masks `{password}` in `db_params`. OAuth secrets (`oauthToken`, `oauthClientSecret`) stored in `db_params` will leak through `db_params_computed` unless the masking function is extended. Hasura migration required (FR-023a).

### V. Simplicity / YAGNI — PASS
- All changes are driven by concrete current needs (upstream upgrade, user-requested databases).
- New features (calendar cubes, multi-stage pre-aggs, view overrides) are Cube.js built-in — no custom abstractions added.
- Configuration enablement only (environment variables, not custom code).

## Project Structure

### Documentation (this feature)

```text
specs/003-update-deps/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0: resolved unknowns
├── data-model.md        # Phase 1: entity/data changes
├── quickstart.md        # Phase 1: developer setup guide
├── contracts/           # Phase 1: API contract changes
│   └── cubesql-api.md   # New SQL API over HTTP contract
└── tasks.md             # Phase 2: implementation tasks (via /speckit.tasks)
```

### Source Code (repository root)

```text
services/cubejs/
├── Dockerfile                          # Node.js 20→22 base image upgrade
├── package.json                        # All @cubejs-backend/* → v1.6.x + 6 new drivers
├── src/
│   ├── utils/
│   │   ├── driverFactory.js            # Audit DriverDependencies import path; add new driver entries
│   │   ├── prepareDbParams.js          # Add driver-specific normalization for Oracle, SQLite, Pinot, DuckDB, OAuth modes
│   │   ├── checkAuth.js                # No changes (audit only)
│   │   ├── defineUserScope.js          # No changes (audit only)
│   │   └── buildSecurityContext.js     # No changes (audit only)
│   ├── routes/
│   │   └── index.js                    # No changes (SQL API over HTTP auto-registered by cubejs.initApp)
│   └── swagger.yaml                    # Fix route drift (/generate-dataschema → /generate-models); add /cubesql

services/actions/
├── src/utils/
│   └── cubejsApi.js                    # Audit for CubeJS v1.6 response formats; extend queryBaseMembers for cache; fix timeout route string (line 156: "/generate-dataschema" → "/generate-models")

services/hasura/
├── migrations/
│   └── NNNN_extend_hide_password/      # New migration: mask OAuth secrets in db_params_computed

.env                                    # CUBESTORE_VERSION, CUBEJS_DEFAULT_TIMEZONE,
                                        # CUBEJS_TRANSPILATION_WORKER_THREADS

docker-compose.dev.yml                  # CubeStore version update (via .env)

../client-v2/
├── src/
│   ├── types/
│   │   └── dataSource.ts              # Extend DataSoureSetupField.type to include "radio"/"select"; add `options` and `dependsOn` props; add deprecated to DataSource
│   ├── components/
│   │   ├── FormTile/index.tsx          # Add deprecated badge prop and visual overlay
│   │   ├── DataSourceSelection/        # Render deprecation badge on tiles
│   │   └── DataSourceSetup/
│   │       └── index.tsx               # Forward `options` prop to Input; add conditional field visibility (dependsOn)
│   ├── mocks/
│   │   └── dataSources.tsx             # Add 7 new dbTiles + forms, deprecation flag (MySQL tile already exists)
│   └── assets/
│       └── databases/                  # Add 7 new SVG icons
```

**Structure Decision**: This is a dependency upgrade across the existing monorepo + sibling frontend. No new services, directories, or architectural changes. All modifications target existing files in their current locations.

## Complexity Tracking

Constitution IV requires a Hasura migration to mask OAuth secrets (tracked in complexity below). All other changes follow existing patterns with no new abstractions.

| Decision | Complexity Added | Simpler Alternative Rejected |
|----------|-----------------|------------------------------|
| Extend `hide_password()` to mask OAuth secrets | Hasura migration + function rewrite | Leave secrets exposed — violates Constitution IV |
| Extend `DataSoureSetupField` for OAuth toggles | Type union + `options` prop + `dependsOn` conditional rendering + DataSourceSetup forwarding | Keep flat form — blocks OAuth toggle UX; show all fields unconditionally — confusing for users |
| Pre-existing: Swagger documents `/generate-dataschema` but route is `/generate-models` | Fix drift before adding `/cubesql` | Leave drift — compounds technical debt |
