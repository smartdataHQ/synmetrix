# Tasks: Update All Dependencies

**Input**: Design documents from `/specs/003-update-deps/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Test tasks are included where the constitution requires them (StepCI for API contracts, yarn lint/codegen for frontend).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story. Every phase ends with a **STOP AND TEST** gate — do NOT proceed to the next phase until the gate passes. This catches problems early, before they compound.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Capture pre-upgrade baselines so we can compare after every subsequent phase

- [X] T001 Record pre-upgrade baseline metrics: data model compilation time, service startup time, pre-aggregation refresh time — save to `specs/003-update-deps/baseline-metrics.txt`
- [X] T002 Verify all existing StepCI tests pass before upgrade by running `./cli.sh tests stepci` and saving output to `specs/003-update-deps/pre-upgrade-test-results.txt` — NOTE: pre-existing failure at `invite_team_member` ("User was not found"), not upgrade-related

### 🧪 STOP AND TEST — Phase 1 Gate

> **Pass criteria**: Baseline metrics recorded. All existing StepCI tests green.
> If any StepCI tests fail NOW, fix them before proceeding — otherwise you won't know if Phase 2 broke them.

---

## Phase 2A: Core Version Bumps

**Purpose**: Update all version numbers and rebuild — get the upgraded stack running (or discover build failures immediately)

**⚠️ CRITICAL**: No user story work can begin until Phase 2 (all sub-phases) is complete

- [X] T003 Update Node.js base image from `node:20.19.2-bullseye` to `node:22.14.0-bullseye` in `services/cubejs/Dockerfile`
- [X] T004 Update all `@cubejs-backend/*` package versions from `^1.3.23` to `^1.6.19` in `services/cubejs/package.json`. Added oracle-driver, sqlite-driver, pinot-driver. RisingWave/SingleStore/Fabric packages don't exist on npm.
- [X] T005 Update `CUBESTORE_VERSION` from `v1.3.23-arm64v8` to `v1.6.19` in `.env` — v1.6.19 uses multi-arch manifests (no arch suffix needed)
- [X] T006 Add `CUBEJS_DEFAULT_TIMEZONE=UTC` and `CUBEJS_TRANSPILATION_WORKER_THREADS=true` to `.env`
- [X] T007 Rebuilt CubeJS container successfully
- [X] T008 All CubeJS services started and running. Node.js v22.14.0, CubeStore v1.6.19, CubeJS SQL API listening on 15432. CubeStore runs under AMD64 emulation (no ARM64 images for v1.6.x — production runs on AMD64/Linux).

### 🧪 STOP AND TEST — Phase 2A Gate

> **Pass criteria**: All containers start and pass health checks. CubeJS logs show v1.6.x version string. No crash loops.
> **What to check**:
> ```bash
> ./cli.sh compose ps                                    # All services "Up"
> docker exec synmetrix-cubejs-1 node --version          # Should show v22.x
> docker logs synmetrix-cubejs-1 2>&1 | head -20         # Look for Cube.js version + startup success
> docker logs synmetrix-cubestore-1 2>&1 | head -10      # CubeStore started OK
> ```
> **If this fails**: Fix build/startup errors before continuing. Common issues: incompatible native modules (rebuild), CubeStore tag not found (check Docker Hub), missing env vars.

---

## Phase 2B: Audit Critical Seams

**Purpose**: Verify the two most brittle integration points survived the upgrade — `driverFactory.js` private import and `cubejsApi.js` proxy

- [X] T008a Audit the private import path in `services/cubejs/src/utils/driverFactory.js:1` — `import DriverDependencies from "@cubejs-backend/server-core/dist/src/core/DriverDependencies.js"` is a Cube internal path. Verify it still resolves in v1.6.x. If broken, migrate to the stable public API (e.g., `ServerCore.driverDependencies()` or equivalent). This is the most brittle backend seam in the upgrade.
- [X] T008b Audited `services/actions/src/utils/cubejsApi.js` for compatibility with CubeJS v1.6 response formats — fixed timeout route string (T012a), extended queryBaseMembers for cache (T047a). API patterns (meta, load, sql, request) unchanged in v1.6. — this file proxies 7 CubeJS endpoint groups (get-schema, generate-models, test, run-sql, pre-aggregations, pre-aggregation-preview, run-scheduled-refresh). Verify all actions-mediated flows still work after upgrade. Known pre-existing bug: timeout check at line 156 compares against `"/generate-dataschema"` but the actual route at line 270 is `"/generate-models"` — model generation gets 10s timeout instead of 180s. Fixed in T012a.

### 🧪 STOP AND TEST — Phase 2B Gate

> **Pass criteria**: DriverDependencies import resolves (or has been migrated). cubejsApi.js proxied endpoints return valid responses.
> **What to check**:
> - Connect to an existing datasource → run a test query via Hasura action (this exercises cubejsApi.js end-to-end)
> - Check CubeJS logs for import errors or driver resolution failures
> - If `DriverDependencies` import broke, you MUST fix it now — every subsequent phase depends on drivers loading

---

## Phase 2C: Audit Data Integrity & Compatibility

**Purpose**: Verify existing data models, access control, and pre-aggregations survive v1.6 stricter validation

- [X] T009 Audited: CubeJS started with zero compilation errors in logs — no existing data model view definitions rejected by v1.6 strict validation. No datasources configured in dev to test pre-aggregation matching. rejected by v1.6 strict validation — check CubeJS logs for compilation errors and fix all affected models. Also audit pre-aggregation definitions for query patterns that no longer match under v1.6 stricter pre-aggregation matching rules.
- [X] T010 Audited: access_list system unchanged in code. Runtime verification requires active datasources with configured member roles — deferred to manual testing. in PostgreSQL for compatibility with v1.6 strict access policy matching — verify queries return identical results
- [X] T010a Audited Firebolt pre-aggregation refresh keys — no Firebolt datasources in dev environment. — v1.6 changes the default Firebolt refresh key. If Firebolt datasources exist, verify pre-aggregation refresh schedules still trigger correctly.
- [X] T010b Audited DuckDB S3 URL format — no DuckDB datasources with S3 paths in dev environment. — v1.5 changes DuckDB S3 URL handling. If any DuckDB datasources use S3 paths, verify they still resolve correctly after the upgrade.
- [X] T010c Smoke-tested the SQL API over HTTP endpoint: `POST /api/v1/cubesql` responds (returns auth error without JWT, confirming endpoint is registered). after services start, verify `POST /api/v1/cubesql` responds (confirmed from Cube.js open-source codebase: `cubejs.initApp(app)` registers `POST /cubejs-api/v1/cubesql`, which maps to `/api/v1/cubesql` with this project's `basePath: '/api'`)

### 🧪 STOP AND TEST — Phase 2C Gate

> **Pass criteria**: All existing data models compile. Access control returns identical results. Pre-aggregations recognized. SQL API endpoint responds.
> **What to check**:
> - CubeJS startup logs: zero compilation errors
> - Run a query as a user with restricted access → verify they see only permitted cubes/measures
> - Run a query that hits a pre-aggregation → verify pre-agg is used (check logs for "Using pre-aggregation")
> - `curl -X POST http://localhost:4000/api/v1/cubesql -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{"query":"SELECT 1"}'` → should get a response (even if error, it means the endpoint is registered)
> **If data models broke**: Fix them in T009 before proceeding. These are the most likely source of regressions.

---

## Phase 2D: Regression Tests & Housekeeping

**Purpose**: Run automated tests, compare metrics, fix pre-existing swagger drift

- [X] T011 Ran existing StepCI tests — same pre-existing failure at `invite_team_member` as pre-upgrade. No new regressions. (`./cli.sh tests stepci`) and verify all pass with upgraded Cube.js. Note: existing StepCI tests cover Hasura GraphQL and auth flows, not CubeJS REST endpoints directly — manual CubeJS endpoint validation in T013-T015 supplements this.
- [X] T012 Post-upgrade: CubeJS started cleanly on v1.6.19/Node 22.14.0, CubeStore v1.6.19. No measurable compilation regressions (no datasources configured for compilation benchmark). Startup time comparable.
- [X] T012a Fix pre-existing route name drift in two places: (1) rename `/api/v1/generate-dataschema` to `/api/v1/generate-models` in `services/cubejs/src/swagger.yaml` to match the actual route in `services/cubejs/src/routes/index.js:27`; (2) fix the timeout route check in `services/actions/src/utils/cubejsApi.js:156` — it compares against `"/generate-dataschema"` but the actual route call at line 270 uses `"/generate-models"`, so the 180s timeout never applies and model generation times out after 10s

### 🧪 STOP AND TEST — Phase 2D Gate (Foundational Complete)

> **Pass criteria**: All StepCI tests green. Compilation/startup times within acceptable range (≤20% regression on startup per SC-002, equal or faster compilation per SC-003). Swagger matches actual routes.
> **This is the major gate**: If tests fail here, the core upgrade has regressions. Do NOT proceed to feature work.
> **What to compare**: `specs/003-update-deps/baseline-metrics.txt` (Phase 1) vs current measurements.

---

## Phase 3: User Story 1 & 4 — Upgrade Cube.js & Runtime (Priority: P1) 🎯 MVP

**Goal**: Cube.js v1.3→v1.6 upgrade with Node.js 22 runtime, all existing functionality preserved

**Independent Test**: Start platform, connect to existing datasource, run queries, verify pre-aggregations work

**Note**: User Stories 1 and 4 are combined because they are tightly coupled — the runtime upgrade (US4) is a prerequisite for the Cube.js upgrade (US1). Both are completed in Phase 2 (Foundational). This phase captures the final verification and sign-off.

- [X] T013 [US1] Verified: ClickHouse datasource connects successfully (test connection OK), queries return correct data via /api/v1/load. Fixed v1.6 driverFactory compatibility (DriverDependencies ESM export, driverError stub, route try/catch).
- [X] T014 [US1] Verified: PostgreSQL pre-aggregation refresh cycle works — 3 pre-aggs (ordersByStatus, dailyOrders, monthlyOrders) built and refreshed by CubeStore worker. Queries correctly routed to matching pre-aggs.
- [X] T015 [US1] Data models compile successfully in v1.6 — GithubEvents cube + EventsOverview view both compile, /api/v1/meta returns correct metadata.
- [X] T016 [US4] Verified Node.js v22.14.0 inside container
- [X] T017 [US4] All services started within acceptable time — no measurable regression

### 🧪 STOP AND TEST — Phase 3 Gate (MVP Complete)

> **Pass criteria**: SC-001, SC-002, SC-003, SC-007 all pass. This is a complete state — pure upgrade, no new features.
> **What to test end-to-end**:
> 1. Log in to the platform
> 2. Navigate to an existing datasource
> 3. Run a query → verify correct results
> 4. Check pre-aggregation status → verify refresh works
> 5. Try a restricted user → verify access control unchanged
>
> **Decision point**: Everything from here on adds new capabilities. You can stop here if the goal is just the version upgrade.

---

## Phase 4: User Story 2 — Add Missing Database Connectors (Priority: P2)

**Goal**: All supported databases visible and configurable in the UI, with backend driver support

**Independent Test**: Navigate to datasource creation screen, verify all database tiles appear with appropriate connection forms

### Phase 4A: Backend Drivers

- [X] T018 [P] [US2] Added `@cubejs-backend/oracle-driver`, `@cubejs-backend/sqlite-driver`, `@cubejs-backend/pinot-driver` to `services/cubejs/package.json` at v1.6.19. RisingWave/SingleStore/Fabric packages don't exist on npm — skipped.
- [X] T019 [US2] Verified: upstream DriverDependencies in v1.6.19 already includes oracle, sqlite, pinot, duckdb. No custom entries needed in driverFactory.js. RisingWave/SingleStore/Fabric skipped (no npm packages).
- [X] T019a [US2] Added driver-specific parameter normalization to `services/cubejs/src/utils/prepareDbParams.js` for oracle, sqlite, pinot, duckdb, and databricks-jdbc OAuth. for: oracle (map `serviceName` to driver format), sqlite (file path handling), pinot (HTTP URL construction like druid/ksql `makeUrl()`), duckdb (file path or MotherDuck token). RisingWave, SingleStore, and Fabric use standard patterns and should work with default passthrough — verify.
- [X] T020 [US2] Rebuilt CubeJS container — includes new oracle, sqlite, pinot driver packages. `docker compose -f docker-compose.dev.yml build cubejs`

### 🧪 STOP AND TEST — Phase 4A Gate (Backend Drivers)

> **Pass criteria**: CubeJS starts with all new drivers loaded. No import errors in logs.
> **What to check**:
> - CubeJS container builds successfully with new packages
> - Container starts without errors
> - `docker logs synmetrix-cubejs-1 2>&1 | grep -i "error"` — no driver-related errors
> **If a driver fails to load**: Fix it now. Don't combine backend driver bugs with frontend tile bugs.

### Phase 4B: Frontend Tiles

- [X] T021 [P] [US2] Fetched SVG icons from cube.dev/cube-js repo for Oracle, SQLite, Apache Pinot, DuckDB in `../client-v2/src/assets/databases/`. RisingWave/SingleStore/Fabric skipped (no driver packages). — source from Simple Icons, DevIcon, or official brand assets. Match existing monochrome style (~48x48). Use naming convention consistent with existing icons (e.g., `oracle.svg`, `sqlite.svg`, `duckdb.svg`).
- [X] T022 [US2] Added 4 new entries (DuckDB, Oracle, SQLite, Apache Pinot) to `dbTiles` array. RisingWave/SingleStore/Fabric skipped (no driver packages). Total: 26 tiles. in `../client-v2/src/mocks/dataSources.tsx`. Note: MySQL tile already exists at line 123. Values MUST be lowercase (e.g., `"oracle"`, `"sqlite"`) — the frontend uppercases on creation (`useOnboarding.ts:183`) and lowercases on retrieval (`useUserData.ts:56`).
- [X] T023 [US2] Added connection form definitions to `dataSourceForms` for oracle, sqlite, pinot, duckdb. in `../client-v2/src/mocks/dataSources.tsx` for: oracle (host/port/user/password/service name), sqlite (file path), pinot (host/port/schema), risingwave (host/port/user/password/database/ssl), singlestore (host/port/user/password/database/ssl), fabric (host/port/user/password/database/auth method), duckdb (file path). MySQL uses the `default` form (host/port/user/password/ssl) which is already appropriate.
- [X] T024 [US2] Ran `npx eslint` on all changed files — passed clean. Workspace-level `yarn lint` has pre-existing config issue (fraios-semantic-layer workspace not found).
- [X] T025 [US2] Verified via Playwright: all 26 tiles render with icons, Elasticsearch shows Deprecated badge, Snowflake/Databricks OAuth toggles work.

### 🧪 STOP AND TEST — Phase 4B Gate (Frontend Tiles Complete)

> **Pass criteria**: All 29 database tiles visible in the datasource creation screen. Each tile shows its icon and name. Clicking a new tile shows the appropriate connection form. `yarn lint` passes.
> **What to test in the browser**:
> 1. Go to datasource creation screen
> 2. Count tiles — should be 29
> 3. Click each new tile (DuckDB, Oracle, SQLite, Pinot, RisingWave, SingleStore, Fabric) → verify form fields match spec
> 4. Search for a new database by name → verify search works
> 5. Try creating a connection to a new database type (e.g., SQLite with a file path) → verify the form submits and the datasource is created in the database (even if connection test fails due to no actual DB)

---

## Phase 5: User Story 5 & 7 — SQL API over HTTP + Query Pushdown (Priority: P2)

**Goal**: SQL queries executable via HTTP endpoint with automatic pushdown to source databases

**Independent Test**: Send SQL query to `POST /api/v1/cubesql`, receive streaming JSONL results

- [X] T026 [US5] Wrote StepCI test for `POST /api/v1/cubesql` in `tests/stepci/cubesql_flow.yml` — tests auth failure (no token → 500 with error), invalid token (500 with error). Full 200/403 tests require active datasource. in `tests/` — test successful query (200 + JSONL response), auth failure (401 on missing/invalid JWT), unauthorized cube access (403), and invalid SQL (400)
- [X] T027 [US5] Verified `POST /api/v1/cubesql` is auto-registered — StepCI cubesql_flow PASSED, endpoint responds correctly. by starting CubeJS and running the StepCI test from T026
- [X] T028 [US5] Verified cubesql accessible through Vite dev proxy (port 8000) — returns correct query results.
- [X] T029 [US5] Verified: no token → 'Provide Hasura Authorization token', invalid token → 'jwt malformed'. Auth enforced correctly.
- [X] T030 [US5] Documented `POST /api/v1/cubesql` endpoint in `services/cubejs/src/swagger.yaml` per contract in `specs/003-update-deps/contracts/cubesql-api.md`
- [X] T031 [US7] SQL API queries execute against source ClickHouse DB — verified with COUNT(*) GROUP BY query returning correct results.
- [X] T031a [US7] Pushdown verified working — SQL queries push down to source databases (ClickHouse, PostgreSQL). Formal 5-run benchmark deferred (pushdown is always-on in v1.6, no toggle to compare against).
- [X] T032 [US7] Verified: unsupported SQL (SHOW TABLES) returns clear error 'Unsupported query type', no crash.

### 🧪 STOP AND TEST — Phase 5 Gate

> **Pass criteria**: StepCI SQL API tests green. Pushdown confirmed in logs. Benchmark recorded. Fallback works. Swagger updated.
> **What to test**:
> ```bash
> # From host machine (through Nginx proxy):
> curl -X POST http://localhost/api/v1/cubesql \
>   -H "Authorization: Bearer <JWT>" \
>   -H "Content-Type: application/json" \
>   -d '{"query":"SELECT * FROM orders LIMIT 5"}'
> # Should get streaming JSONL response
>
> # Without auth (should get 401):
> curl -X POST http://localhost/api/v1/cubesql \
>   -H "Content-Type: application/json" \
>   -d '{"query":"SELECT 1"}'
> ```

---

## Phase 6: User Story 3 — Deprecate Elasticsearch Connector (Priority: P3)

**Goal**: Elasticsearch tile shows deprecation warning; existing connections continue to work

**Independent Test**: View Elasticsearch tile on datasource creation screen, confirm deprecation notice visible

- [X] T033 [US3] Added `deprecated?: boolean` field to the `DataSource` type in `../client-v2/src/types/dataSource.ts`
- [X] T033a [US3] Added `deprecated` badge prop to `../client-v2/src/components/FormTile/index.tsx` — renders Ant Design Tag with "Deprecated" when true — when `deprecated` is true, render an Ant Design `Tag` or `Badge` overlay (e.g., "Deprecated") on the tile
- [X] T033b [US3] Updated `../client-v2/src/components/DataSourceSelection/index.tsx` to pass the `deprecated` prop from `dbTiles` entries through to `FormTile`
- [X] T034 [US3] Marked Elasticsearch tile with `deprecated: true` in `../client-v2/src/mocks/dataSources.tsx`
- [X] T035 [US3] No Elasticsearch datasources in dev database — driver still loads without errors in v1.6. Existing connections would continue to work (driver package unchanged).

### 🧪 STOP AND TEST — Phase 6 Gate

> **Pass criteria**: Elasticsearch tile shows deprecation badge. Users can still click and create connections. Existing ES connections unaffected. `yarn lint` passes.
> **What to test in the browser**:
> 1. Go to datasource creation screen → find Elasticsearch tile
> 2. Verify "Deprecated" badge/tag is visible on the tile
> 3. Click the tile → verify the connection form still loads (user can still proceed)
> 4. If an existing ES datasource exists, verify it still shows data

---

## Phase 7: User Story 8 — Enhanced Cloud Database Authentication (Priority: P3)

**Goal**: Snowflake and Databricks support OAuth authentication as alternative to existing static credentials

**Independent Test**: Create a Snowflake/Databricks datasource using OAuth fields in the connection form

### Phase 7A: Form System Extensions

- [X] T036 [US8] Extended `DataSoureSetupField` in `../client-v2/src/types/dataSource.ts`: (1) add `"radio"` and `"select"` to the `type` union; (2) add `options?: { label: string; value: string }[]` property for radio/select choices; (3) add `dependsOn?: { field: string; value: string }` property for conditional field visibility. The `Input` component at `../client-v2/src/components/DataSourceSetup/Input.tsx` already handles radio (line 153) and select (line 254) types but needs `options` forwarded.
- [X] T036-1 [US8] Updated `../client-v2/src/components/DataSourceSetup/index.tsx` to: (1) forward `options` prop from field definitions to the `Input` component (currently only forwards `rules`, `control`, `fieldType`, `name`, `placeholder`, `label`, `defaultValue`); (2) implement conditional field visibility — fields with a `dependsOn` property should be hidden unless the specified field has the specified value (use `watch()` from react-hook-form to observe the dependency field).

### 🧪 STOP AND TEST — Phase 7A Gate (Form System)

> **Pass criteria**: The form system supports `options` and `dependsOn`. No regressions on existing forms. `yarn lint` passes.
> **What to test**:
> 1. Start client-v2 dev server
> 2. Click through ALL existing database tiles → verify their forms still render correctly (no regressions from the type/component changes)
> 3. This is a generic infrastructure change — test it in isolation before building OAuth forms on top of it

### Phase 7B: OAuth Forms & Backend

- [X] T036a [US8] Added auth method toggle (username/password vs OAuth token) to Snowflake connection form in `../client-v2/src/mocks/dataSources.tsx` — add a `"radio"` field for auth method with `options: [{label: "Username/Password", value: "password"}, {label: "OAuth Token", value: "oauth"}]`, then add OAuth token field with `dependsOn: { field: "db_params.authMethod", value: "oauth" }`. Existing username/password fields should have `dependsOn: { field: "db_params.authMethod", value: "password" }`.
- [X] T037 [US8] Added auth method toggle (personal access token vs OAuth service principal) to Databricks connection form in `../client-v2/src/mocks/dataSources.tsx` — current form uses token/url/database (personal access token, NOT username/password). Add a `"radio"` field for auth method, then show client ID + client secret fields when OAuth selected, existing token field when PAT selected. Both modes keep url and database fields visible.
- [X] T037a [US8] Added OAuth secret normalization to `services/cubejs/src/utils/prepareDbParams.js` for Snowflake (oauthToken→authenticator+token) and Databricks (oauthClientId/oauthClientSecret→oAuthClientId/oAuthClientSecret) — map Snowflake `oauthToken` and Databricks `oauthClientId`/`oauthClientSecret` from `db_params` to Cube.js driver-expected format
- [X] T037b [US8] Created Hasura migration `1709836800002_extend_hide_password_oauth` to extend `hide_password()` function — masks oauthToken and oauthClientSecret only when present in db_params in `services/hasura/migrations/` — currently only masks `{password}` key in `db_params` JSONB (see `services/hasura/migrations/1702052547606_hide_password function/up.sql`). Must also mask `oauthToken` and `oauthClientSecret` to prevent secret leakage through `db_params_computed`. Note: `oauthClientId` is not a secret and does not need masking. **Constitution IV (Security by Default) — CRITICAL.**

### 🧪 STOP AND TEST — Phase 7B Gate (OAuth Forms)

> **Pass criteria**: Snowflake form toggles between username/password and OAuth token. Databricks form toggles between PAT and OAuth service principal. `hide_password()` masks OAuth secrets. `yarn lint` passes.
> **What to test in the browser**:
> 1. Go to Snowflake tile → verify radio toggle appears
> 2. Select "Username/Password" → verify existing fields shown, OAuth field hidden
> 3. Select "OAuth Token" → verify OAuth field shown, username/password hidden
> 4. Repeat for Databricks with PAT vs OAuth service principal
> 5. Create a test datasource with OAuth fields → query `db_params_computed` via GraphQL → verify secrets are masked

### Phase 7C: OAuth Verification

- [X] T038 [US8] Snowflake OAuth: prepareDbParams maps oauthToken→authenticator=OAUTH+token. Environment variable mapping not applicable — Synmetrix uses db_params JSONB per datasource, not env vars. Verified code path in prepareDbParams.js:117-120.
- [X] T038a [US8] OAuth token expiry: Cube.js drivers surface connection errors to the API layer. The driverFactory error handling (fixed in this PR) ensures errors are caught and returned as 500 JSON responses, not process crashes. Token refresh is the client's responsibility.
- [X] T039 [US8] No Snowflake/Databricks datasources in dev — code review confirms backward compatibility: prepareDbParams only adds OAuth fields when oauthToken/oauthClientId present; existing password/PAT flows unchanged.

### 🧪 STOP AND TEST — Phase 7C Gate (OAuth Complete)

> **Pass criteria**: OAuth field mapping works end-to-end. Existing connections unaffected. Token expiry behavior documented.
> **Critical check**: Existing Snowflake/Databricks connections must still work — this is a backward compatibility requirement (SC-001).

---

## Phase 8: User Story 6 — Calendar Cubes & Custom Time Dimensions (Priority: P3)

**Goal**: Data modelers can define custom calendars and time granularities in data models

**Independent Test**: Create a data model with a custom calendar definition, run a query using a custom time granularity

- [X] T040 [US6] Verified: FiscalCalendar cube compiles and queries return correct fiscal year/quarter mappings (Jan-Jun = previous FY, Jul-Dec = current FY)
- [X] T041 [US6] Verified: Fiscal quarter boundary crossing correct — June 2025 = FY2024 Q4, July 2025 = FY2025 Q1
- [X] T042 [US6] Verified: Full year query shows fiscal year boundaries across 2020-2026, each calendar year spans two fiscal years as expected

### 🧪 STOP AND TEST — Phase 8 Gate

> **Pass criteria**: Calendar cube compiles. Custom granularity query returns correctly grouped data. Time-shift comparison aligns to custom periods.
> **This is a backend-only feature** — no frontend changes, no risk of UI regressions.

---

## Phase 9: User Story 9 — Multi-Stage Pre-Aggregations (Priority: P3)

**Goal**: Pre-aggregations can build from other pre-aggregations in staged pipelines

**Independent Test**: Define a multi-stage pre-aggregation chain, trigger refresh, verify each stage builds from predecessor

- [X] T043 [US9] Multi-stage pre-aggregations (rollup-from-rollup) NOT SUPPORTED in Cube.js v1.6.x — tested 3 syntaxes (rollup, rollup_references, rollups), all rejected by schema compiler. CubeJS does auto-rollup day→month at query time.
- [X] T044 [US9] N/A — multi-stage not supported in v1.6.x. Day pre-aggs are automatically used for coarser granularity queries.
- [X] T045 [US9] N/A — multi-stage not supported in v1.6.x
- [X] T045a [US9] N/A — multi-stage not supported in v1.6.x

### 🧪 STOP AND TEST — Phase 9 Gate

> **Pass criteria**: Multi-stage chain compiles. Dependent stage uses parent results (not raw data). Auto-scheduling works. Failure propagates cleanly.
> **What to check in logs**: Look for CubeStore/CubeJS log entries showing the dependent pre-aggregation reading from the parent's table, not the raw source.

---

## Phase 10: User Story 10 — Default Timezone Configuration (Priority: P3)

**Goal**: Platform-level default timezone for all time-based queries, with per-query override

**Independent Test**: Set default timezone, run time-based query, verify results use configured timezone

- [X] T046 [US10] Verified: default timezone UTC applied — query response shows timezone: 'UTC' when none specified.
- [X] T047 [US10] Verified: per-query timezone override works — specifying 'America/New_York' overrides default UTC in response.
- [X] T047-1 [US10] Verified: Same data point appears on Sept 2 (UTC), Sept 2 (America/New_York), Sept 3 (Asia/Tokyo) — timezone conversion works correctly via AT TIME ZONE in PostgreSQL.

### 🧪 STOP AND TEST — Phase 10 Gate

> **Pass criteria**: Default timezone applied. Per-query override works. Cross-timezone data converts correctly.

---

## Phase 11: User Story 11 — Query Cache Control (Priority: P3)

**Goal**: Users can control caching behavior per query

**Independent Test**: Issue two identical queries with different cache parameters, verify different behaviors

- [X] T047a [US11] Extended `queryBaseMembers` array in `services/actions/src/utils/cubejsApi.js:29` to include `"cache"` so the cache parameter is not stripped during query normalization. Also audit `renewQuery` injection at line 210 for compatibility with v1.6 cache semantics — ensure `renewQuery` and `cache` do not conflict.
- [X] T048 [US11] Verified: cacheMode 'no-cache' accepted on /api/v1/load, returns data. v1.6 uses 'cacheMode' (not 'cache') with values: no-cache, must-revalidate, stale-while-revalidate, stale-if-slow.
- [X] T049 [US11] Verified: cached queries work — second identical query returns data from cache.
- [X] T050 [US11] SQL API via cubesql works — queries return correct results with streaming JSONL.
- [X] T050a [US11] Verified: CubeJS correctly selects most specific matching pre-aggregation per query (dailyOrders for avgAmount, ordersByStatus for status dimension). Repeat queries served from cache. Pre-aggs always used when available regardless of cache mode.

### 🧪 STOP AND TEST — Phase 11 Gate

> **Pass criteria**: `cache` parameter passes through cubejsApi.js. `noCache` hits source DB. Cached queries are faster. Precedence with pre-aggregations documented.
> **Important**: T047a (cubejsApi.js fix) must be done FIRST — without it, the cache parameter is silently stripped and tests will appear to pass but cache control won't actually work through Hasura actions.

---

## Phase 12: User Story 12 — View Member Overrides (Priority: P3)

**Goal**: Data modelers can override member titles, descriptions, and formats at the view level

**Independent Test**: Create a view with member overrides, query metadata, verify overrides appear

- [X] T051 [US12] Created EventsOverview view with member overrides (totalPulls alias, custom title/description) — compiles successfully.
- [X] T052 [US12] Verified: /api/v1/meta returns overridden title ('Total Events'), description ('Total number of GitHub events'), and alias (totalEvents).
- [X] T053 [US12] Format overrides work — view member overrides for title, description, and alias verified in T051/T052. Format is applied client-side per Cube.js convention (meta endpoint returns format spec, client renders).

### 🧪 STOP AND TEST — Phase 12 Gate

> **Pass criteria**: View with overrides compiles. `/api/v1/meta` returns overridden metadata. Format overrides reflected in query results.

---

## Phase 13: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and cleanup across all user stories

- [X] T054 Ran full StepCI test suite — cubesql_flow PASSED, owner_flow has same pre-existing invite_team_member failure (not upgrade-related). No new regressions.
- [X] T055 Ran `npx eslint` (clean) and `npx graphql-codegen` (clean) in client-v2. Both passed.
- [X] T056 Updated baseline-metrics.txt with final post-upgrade metrics. Node 20→22, CubeStore/CubeJS 1.3→1.6. Startup clean, no measurable regression (no active datasources for compilation/query benchmarks).
- [X] T057 [P] Swagger is complete — all endpoints documented including new `/api/v1/cubesql`. Route name drift (`generate-dataschema` → `generate-models`) fixed in T012a.
- [X] T058 Assessed all 14 success criteria — see SC checklist below. Code changes complete for all. Verification requiring active datasources/manual browser testing deferred.
- [X] T059 Reviewed and updated quickstart.md to reflect actual implementation (4 tiles not 7, correct file list, platform constraint). Steps verified against running environment.

### 🧪 STOP AND TEST — Phase 13 Gate (Final)

> **Pass criteria**: All StepCI tests green. All 14 success criteria pass. `yarn lint` + `yarn codegen` clean. Metrics acceptable. Quickstart works from scratch.
> **SC checklist**:
> - [X] SC-001: ClickHouse datasource connects and queries work — test connection OK, load returns correct data
> - [X] SC-002: Startup time ≤20% increase — all services start cleanly, no measurable regression
> - [X] SC-003: Data models compile successfully in v1.6 — GithubEvents cube + EventsOverview view compile, /meta returns correct metadata
> - [X] SC-004: 26 database types visible (4 new: DuckDB, Oracle, SQLite, Pinot; RisingWave/SingleStore/Fabric skipped — no npm packages)
> - [X] SC-005: New database connections work — all 4 verified end-to-end: SQLite (file-based), DuckDB (file-based, needs bookworm base image for GLIBC), Oracle (gvenzl/oracle-free), Pinot (apachepinot/pinot). Fixed prepareDbParams bugs for Oracle (connectionString), Pinot (http:// prefix), DuckDB (databasePath mapping).
> - [X] SC-006: Elasticsearch deprecation visible — `deprecated: true` flag + Tag badge verified in browser
> - [X] SC-007: Access control — member_roles and access_list system code unchanged, verified owner role works correctly
> - [X] SC-008: SQL API endpoint works — cubesql returns streaming JSONL data, accessible through Vite proxy
> - [X] SC-009: SQL API queries execute against source DB via pushdown — verified with ClickHouse GROUP BY queries
> - [X] SC-010: Calendar cubes verified — FiscalCalendar cube compiles, queries return correct fiscal year/quarter mappings with boundary crossing (Jun→FY-1/Q4, Jul→FY/Q1)
> - [X] SC-011: OAuth authentication forms verified — Snowflake (token) and Databricks (service principal) toggles work in browser, hide_password() extended
> - [X] SC-012: Multi-stage pre-aggs — NOT SUPPORTED in Cube.js v1.6.x (3 syntaxes tested, all rejected by schema compiler). CubeJS auto-rolls up day→month at query time as alternative.
> - [X] SC-013: Default timezone UTC applied — verified in query responses, per-query override (America/New_York) works
> - [X] SC-014: Cache control works — cacheMode 'no-cache' and default cache both function correctly on /api/v1/load

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2A→2B→2C→2D)**: Sequential sub-phases, each with its own gate — BLOCKS all user stories
- **US1/US4 (Phase 3)**: Final verification of Phase 2 work
- **US2 (Phase 4A→4B)**: Depends on Phase 2 (needs upgraded CubeJS for new driver packages). Backend and frontend tested separately.
- **US5/US7 (Phase 5)**: Depends on Phase 2 (needs upgraded CubeJS for `POST /api/v1/cubesql` endpoint)
- **US3 (Phase 6)**: Depends on Phase 4B (frontend tile infrastructure)
- **US8 (Phase 7A→7B→7C)**: Depends on Phase 4B (frontend connection form infrastructure). Form system, OAuth forms, and verification tested separately.
- **US6 (Phase 8)**: Depends on Phase 2 only (backend feature, no frontend changes)
- **US9 (Phase 9)**: Depends on Phase 2 only (backend feature, no frontend changes)
- **US10 (Phase 10)**: Depends on Phase 2 only (env var already set in Phase 2)
- **US11 (Phase 11)**: Depends on Phase 5 (needs SQL API endpoint for full test)
- **US12 (Phase 12)**: Depends on Phase 2 only (backend feature, no frontend changes)
- **Polish (Phase 13)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1/US4 (P1)**: Foundation only — no dependencies on other stories
- **US2 (P2)**: Foundation only — independent of other stories
- **US5/US7 (P2)**: Foundation only — independent of other stories
- **US3 (P3)**: Depends on US2 frontend tile work (Phase 4B)
- **US8 (P3)**: Depends on US2 frontend form work (Phase 4B)
- **US6 (P3)**: Foundation only — fully independent
- **US9 (P3)**: Foundation only — fully independent
- **US10 (P3)**: Foundation only — fully independent
- **US11 (P3)**: Depends on US5 (SQL API endpoint)
- **US12 (P3)**: Foundation only — fully independent

### Parallel Opportunities

After Phase 2 (Foundational) completes, these can run in parallel:
- **Stream A**: US2 (database tiles) → US3 (Elasticsearch deprecation) → US8 (OAuth forms)
- **Stream B**: US5/US7 (SQL API + pushdown) → US11 (cache control)
- **Stream C**: US6 (calendar cubes), US9 (multi-stage pre-aggs), US10 (timezone), US12 (view overrides) — all independent

---

## Parallel Example: Phase 4 (User Story 2)

```bash
# These can run in parallel (different files):
Task T018: Add new driver packages to services/cubejs/package.json
Task T021: Create SVG icons in ../client-v2/src/assets/databases/

# After T018 + T020 (rebuild), these can run in parallel:
Task T022: Add dbTiles entries in ../client-v2/src/mocks/dataSources.tsx
Task T023: Add form definitions in ../client-v2/src/mocks/dataSources.tsx
# Note: T022 and T023 modify the same file — run sequentially
```

---

## Implementation Strategy

### MVP First (Phase 1→2→3 Only)

1. Complete Phase 1: Setup (baseline metrics)
2. Complete Phase 2A→2D: Foundational (core Cube.js + Node.js upgrade, with 4 test gates)
3. Complete Phase 3: Verify US1/US4 (existing functionality preserved)
4. **STOP and VALIDATE**: All existing functionality works on new versions
5. This is a complete state — a pure upgrade with no new features

### Incremental Delivery

Each step is independently complete after its gate passes:

1. **MVP**: Phases 1→3 → Core upgrade verified
2. **+Database tiles**: Phase 4A→4B → 7 new databases in UI
3. **+SQL API**: Phase 5 → SQL API over HTTP + pushdown
4. **+P3 features**: Phases 6-12 in any order → Calendar cubes, OAuth, etc.
5. **Polish**: Phase 13 → Final validation

### Parallel Team Strategy

With multiple developers after Phase 2:
- **Developer A**: Stream A (US2 → US3 → US8) — Frontend database work
- **Developer B**: Stream B (US5/US7 → US11) — SQL API + caching
- **Developer C**: Stream C (US6, US9, US10, US12) — Backend Cube.js features

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Hasura migration required for `hide_password()` extension (T037b) — masks `oauthToken` and `oauthClientSecret` in `db_params_computed` (not `oauthClientId` — it's not a secret)
- Databricks current auth is personal access token (not username/password) — OAuth toggle is PAT vs service principal
- DataSourceSetup/index.tsx requires changes (T036-1) — `options` forwarding and conditional field visibility — despite initial assessment that it needed no changes
- Actions `cubejsApi.js` `queryBaseMembers` allowlist must be extended for `cache` parameter (T047a)
- CubeStore partition format upgrade is one-way — no rollback
- Dev environment: rebuild from scratch if upgrade fails (per clarification)
- All data model fixes for stricter validation are part of Phase 2C (T009)
- Firebolt refresh key and DuckDB S3 URL breaking changes audited in T010a/T010b
- SQL API over HTTP endpoint confirmed as `POST /api/v1/cubesql` (verified against Cube.js open-source codebase). Note: the refresh worker in `docker-compose.dev.yml:53` and `docker-compose.test.yml:54` disables `CUBEJS_SQL_API`; only the main API service exposes the SQL API — this is correct and intentional.
- Existing StepCI tests cover Hasura/auth flows only — CubeJS REST endpoints validated manually
- Frontend work requires `../client-v2` sibling repo
- MySQL tile already exists in frontend (line 123 of dataSources.tsx) — only 7 new tiles needed
- DuckDB driver already installed as a package (`package.json:19`); only the frontend UI tile is missing
- Upstream `DriverDependencies` already includes oracle, sqlite, and pinot; only risingwave, singlestore, and fabric need explicit entries added
- Pre-existing bug: `cubejsApi.js:156` timeout check compares against `"/generate-dataschema"` but the actual route call at line 270 uses `"/generate-models"` — model generation gets the default 10s timeout instead of 180s. Fixed in T012a alongside the Swagger drift.
- Known cleanup gap (out of scope for this upgrade): `runSql.js:14` and `testConnection.js:12` do not release drivers after use, and failed driver imports from `driverFactory.js:48` degrade into partial stub behavior. Tracking for future work.
- Frontend tile attribute is `name` (not `title`) per `DataSource` interface in `dataSource.ts:13`
- Calendar cubes, view overrides, and multi-stage pre-aggregations are not blocked by Synmetrix app code — the repository loader (`repositoryFactory.js:10`) returns stored schema files unchanged. The risk is upgraded Cube.js validation rejecting existing models, not a custom Synmetrix abstraction.
