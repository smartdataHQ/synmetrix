# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Synmetrix (formerly MLCraft) is an open source data engineering platform and semantic layer built as a monorepo. It leverages Cube.js for flexible data modeling and provides a framework for modeling, integrating, transforming, aggregating, and distributing metrics data at scale.

The frontend lives at `../client-v2`. **Both projects are developed from this repository** — changes to client-v2 are part of this workflow. See "Frontend Integration" below for how the two connect and "Development Setup" for running both together.

## Architecture

### Services

| Service | Directory | Port | Runtime | Purpose |
|---------|-----------|------|---------|---------|
| Actions | `services/actions/` | 3000 | Node.js/Express | RPC microservice for background tasks (alerts, reports, schema generation, queries) |
| CubeJS | `services/cubejs/` | 4000 | Node.js/Cube.js | Analytics API, data modeling, SQL API (MySQL 13306, PG 15432) |
| Hasura | `services/hasura/` | 8080 | Hasura v2 | GraphQL API layer, database migrations, row-level security |
| Hasura+ | (via docker) | 8081 | hasura-backend-plus | Authentication service (JWT, registration, login) |
| Client | `services/client/` | 80 | Nginx | Serves pre-built frontend, proxies API requests |
| CubeStore | (via docker) | 3030 | CubeStore | Columnar cache for pre-aggregations |

### Request Flow

```
Browser → Nginx (client) → Hasura (GraphQL) → PostgreSQL (data)
                         → Hasura Actions → Actions service (RPC) → CubeJS API
Browser → CubeJS (direct) → checkAuth (JWT) → defineUserScope → driverFactory → Database
```

**Actions RPC pattern:** Hasura GraphQL actions (`services/hasura/metadata/actions.yaml`) proxy to `POST http://actions:3000/rpc/{method}`. The actions service dynamically imports handler modules from `services/actions/src/rpc/`. Each RPC handler receives `(session_variables, input, headers)`.

**CubeJS auth flow:** `checkAuth.js` verifies JWT → extracts `x-hasura-user-id` → looks up user's datasources and team memberships → `defineUserScope.js` resolves the selected datasource/branch/version and access list → `buildSecurityContext.js` creates a content-hashed context used for cache isolation and schema versioning.

### Data Model Versioning

Datasources have **branches** (default branch has `status: "active"`). Each branch has immutable **versions** containing **dataschemas** (Cube.js model files in YAML/JS). The security context includes content hashes of schema files, ensuring CubeStore cache isolation between versions. This is the core multi-tenancy mechanism.

### Access Control

- **Hasura permissions:** Row-level security defined in `services/hasura/metadata/tables.yaml`
- **Member roles:** Users belong to teams via `members` table; each member has `member_roles` with an `access_list` config
- **Access list structure:** `access_list.config.datasources[datasourceId].cubes` defines per-cube dimension/measure access
- **CubeJS enforcement:** `defineUserScope.js` reads the access list and passes it through the security context

## Development Commands

### Docker Development (primary workflow)
```bash
./cli.sh compose up              # Start all services (dev environment)
./cli.sh compose up -e stage     # Start with staging config
./cli.sh compose stop            # Stop services
./cli.sh compose restart [svc]   # Restart specific service
./cli.sh compose logs [svc]      # View logs
./cli.sh compose ps              # List containers
./cli.sh compose destroy [svc]   # Remove containers
./cli.sh docker ex <container> <cmd>  # Exec into container
```

### CLI Tool (`cli/`)
```bash
cd cli && yarn install && yarn build
yarn test                        # Run CLI tests
yarn lint                        # Lint CLI code
```

### CubeJS Service (`services/cubejs/`)
```bash
npm run start.dev                # Dev mode with nodemon
npm start                        # Production mode
```

### Hasura Migrations (`services/hasura/`)
```bash
./cli.sh hasura cli "migrate status"
./cli.sh hasura cli "migrate apply"
```

### Integration Tests
```bash
./cli.sh tests stepci            # Run StepCI workflow tests (tests/)
```

## Environment Configuration

Environment files load in layers: `.env` (base) + `.{env}.env` (override). Key variables:

- `JWT_KEY`, `JWT_ALGORITHM` — Shared JWT secret between Hasura+, Actions, and CubeJS
- `HASURA_ENDPOINT` — Internal Hasura URL (used by Actions service for GraphQL queries)
- `CUBEJS_SECRET` — CubeJS API secret
- `CUBEJS_CUBESTORE_HOST/PORT` — CubeStore connection for pre-aggregation cache
- `ACTIONS_URL` — Internal Actions service URL (used in Hasura action definitions)

Docker Compose files per environment: `docker-compose.dev.yml`, `docker-compose.stage.yml`, `docker-compose.test.yml`, `docker-compose.stack.yml` (Swarm production).

## Key File Locations

- `services/actions/src/rpc/` — 25 RPC handlers (one file per action), includes `auditDataschemaDelete`, `auditVersionRollback`, `auditLogsRetention`
- `services/cubejs/src/utils/driverFactory.js` — Database driver creation (25+ drivers)
- `services/cubejs/src/utils/checkAuth.js` — JWT verification and security context setup
- `services/cubejs/src/utils/defineUserScope.js` — Branch/version/access resolution
- `services/cubejs/src/utils/buildSecurityContext.js` — Content-hashed context for cache isolation
- `services/cubejs/src/utils/compilerCacheInvalidator.js` — Branch-scoped compiler-cache eviction (011-model-mgmt-api)
- `services/cubejs/src/utils/referenceScanner.js` — Seven-kind cross-cube reference detector (FR-008)
- `services/cubejs/src/utils/directVerifyAuth.js` — Shared direct-verify helper for branch-scoped routes
- `services/cubejs/src/utils/metaForBranch.js` — Helper that returns raw visibility-filtered metaConfig
- `services/cubejs/src/utils/auditWriter.js` — Best-effort audit-log writer with retry
- `services/cubejs/src/utils/errorCodes.js` — Canonical Model Management API error codes (FR-017)
- `services/cubejs/src/utils/requireOwnerOrAdmin.js` — Owner/admin team-role check
- `services/cubejs/src/utils/mapHasuraErrorCode.js` — Hasura extensions.code → stable error code
- `services/cubejs/src/utils/versionDiff.js` — Per-cube diff adapter over smart-generation/diffModels
- `services/cubejs/src/routes/` — 13 REST API endpoints, now including:
  - `validateInBranch.js` (POST /api/v1/validate-in-branch, US1)
  - `refreshCompiler.js` (POST /api/v1/internal/refresh-compiler, US2)
  - `deleteDataschema.js` (DELETE /api/v1/dataschema/:id, US3)
  - `metaSingleCube.js` (GET /api/v1/meta/cube/:cubeName, US4)
  - `versionDiff.js` + `versionRollback.js` (POST /api/v1/version/{diff,rollback}, US5)
- `services/cubejs/src/routes/reconcileTeam.js` — POST /api/v1/internal/reconcile-team: per-team default-models worker (013 — probe→generate→merge→validate→publish, system-user only)
- `services/cubejs/src/utils/queryPreprocessor.js` — pre-gateway middleware for default-model queries (013 FR-015; mounted before `cubejs.initApp`)
- `services/cubejs/src/utils/defaultModelRules.js` — fixed R1/R2/R3 rule set (canonical translation + scope injection + dynamic map-key slot rewrite, 013 FR-016 / 014 FR-001)
- `services/cubejs/src/utils/defaultModelMeta.js` — datasource-first, tenancy-cross-checked derived-model member-map + slot registry resolution (013/014)
- `services/cubejs/src/routes/dynamicMeta.js` — POST /api/v1/meta/dynamic: filter-scoped map/JSON property discovery, cube-meta-shaped, TTL-cached (014 FR-005)
- `services/cubejs/src/utils/dynamicPropertyProbe.js` — map/JSON probe SQL builders + member shaping + probe cache (014)
- `services/cubejs/src/utils/smart-generation/templateMerger.js` — template-provenance three-class merge (013 FR-011/FR-012)
- `services/actions/src/rpc/{reconcileDefaultModels,reconcileTeamDefaultModels,getDefaultModelsReport}.js` — default-models orchestrator/single-team/report RPCs (013; cron-secret or portal-admin gated)
- `services/actions/src/utils/defaultModels/` — config, cohorts, drift, runReporter, shared helpers (013)
- `services/hasura/migrations/1783381844000_create_reconciliation_runs/` — reconciliation_runs table (013; admin-only, no `user`-role permissions)
- `services/hasura/metadata/actions.yaml` — GraphQL action definitions (maps to Actions RPC)
- `services/hasura/metadata/tables.yaml` — Table definitions, relationships, and permissions
- `services/hasura/metadata/cron_triggers.yaml` — Cron triggers (now includes `audit_logs_retention_90d` and `reconcile_default_models` — */15, cron-secret header)
- `services/hasura/migrations/` — 97+ SQL migration directories
- `scripts/lint-error-codes.mjs` — Fails CI when FR-017 error-code enum drifts across contracts
- `tests/workflows/model-management/` — StepCI workflows + SC-003 fixtures for all six endpoints

## Release Process

Automated via GitHub Actions (`.github/workflows/build-containers.yml`):
- Triggers on push/PR when service files change
- Builds and pushes to Docker Hub (`quicklookup/synmetrix-*`)
- Tags: `{short-sha}`, `{branch}-{short-sha}`, `{branch}`, `latest` (main only)

Deployment: Update `newTag` in Kustomize overlays in the `cxs` repo (`data/synmetrix/overlays/{staging,production}/kustomization.yaml`).

## Frontend Integration (`../client-v2`)

The frontend is a **React 18 + Vite + TypeScript** app using **Ant Design** for UI and **URQL** as the GraphQL client. It lives in a separate repo but is tightly coupled to this backend.

### Tech Stack
- **UI**: Ant Design 5 + LESS + CSS Modules + WindiCSS
- **State**: Zustand (3 stores: AuthTokensStore, CurrentUserStore, DataSourceStore)
- **GraphQL**: URQL with `authExchange` (JWT), `retryExchange`, and `subscriptionExchange` (WebSocket)
- **Code editor**: Monaco Editor (for Cube.js data model YAML/JS editing)
- **Codegen**: GraphQL CodeGen generates TypeScript types + URQL hooks from Hasura schema → `src/graphql/generated.ts`

### Frontend → Backend Communication

All frontend requests route through **4 proxy paths** (Vite dev server or Nginx in production):

| Frontend Path | Backend Target | Service |
|---|---|---|
| `/v1/graphql` | `http://hasura:8080/v1/graphql` | Hasura GraphQL (queries, mutations, subscriptions) |
| `/v1/ws` | `ws://hasura:8080/v1/graphql` | Hasura WebSocket (live subscriptions) |
| `/auth/*` | `http://hasura_plus:8081/auth/*` | hasura-backend-plus (login, register, token refresh) |
| `/api/v1/*` | `http://cubejs:4000/api/v1/*` | CubeJS REST API (run-sql, test, get-schema, generate-models) |

### Auth Flow (Frontend Perspective)

1. User signs in via `POST /auth/login` → receives `jwt_token` + `refresh_token`
2. Tokens stored in Zustand `AuthTokensStore` (persisted to localStorage)
3. JWT decoded to extract `x-hasura-user-id` and `x-hasura-role` claims (under `hasura` namespace)
4. URQL `authExchange` attaches `Authorization: Bearer {token}` and `x-hasura-role` headers to all GraphQL requests
5. On token expiry, `authExchange.willAuthError` triggers → calls `GET /auth/token/refresh?refresh_token={token}`

### GraphQL Actions Bridge

When the frontend calls a Hasura mutation like `gen_dataschemas` or `run_query`, Hasura forwards it as an **Action** to the Actions service (`POST http://actions:3000/rpc/{method}`). The frontend never calls the Actions service directly — Hasura is always the intermediary for GraphQL operations. The frontend only calls CubeJS directly for REST endpoints (`/api/v1/*`).

### Frontend Dev Commands (`../client-v2`)
```bash
bun install                      # Install dependencies (uses Bun)
yarn dev                         # Dev server on port 8000 (proxies to local backend)
yarn build                       # Production build
yarn lint                        # ESLint + TypeScript check
yarn codegen                     # Regenerate GraphQL types from Hasura schema
yarn storybook                   # Component showcase on port 6007
yarn test                        # Run Vitest tests
```

### Shared Contracts

Changes to these backend files require corresponding frontend updates:
- **Hasura actions** (`services/hasura/metadata/actions.yaml`, `actions.graphql`) → frontend `.gql` files in `src/graphql/gql/` must match, then run `yarn codegen`
- **Hasura migrations** (new tables/columns) → update `src/graphql/schemas/hasura.json` (introspection dump), update `.gql` queries, run `yarn codegen`
- **JWT claims structure** → `AuthTokensStore.ts` decodes JWT expecting `hasura` namespace with `x-hasura-user-id` and `x-hasura-role`
- **CubeJS REST routes** (`services/cubejs/src/routes/`) → frontend calls these directly via `/api/v1/*`

## Blueprint Application: FraiOS (`../cxs2`)

The FraiOS app (currently `cxs2`) is the **master UI blueprint**. Both this Synmetrix backend and the `client-v2` frontend will be adapted to adopt patterns from this system. When making architectural decisions, refer to cxs2 as the target pattern.

### Tech Stack
- **Next.js 16.1** (React 19, App Router, Turbopack)
- **Convex** — Real-time database (replaces traditional DB + API layer)
- **WorkOS** — Authentication, Authorization (FGA), and Vault
- **TanStack Query 5** + **Zustand 5** — Client state management
- **Ant Design 5** + **Tailwind CSS 4** — UI

### WorkOS: Authentication

WorkOS AuthKit handles all auth. The flow:
1. User logs in via WorkOS AuthKit → JWT in cookies
2. Session stored in **Redis** with sliding TTL (`src/lib/auth/session.ts`)
3. Convex verifies JWT via JWKS endpoint (`convex/auth.config.ts`)
4. Frontend fetches Convex access token from `/api/v1/auth/token`
5. `ConvexProvider` (`src/components/providers/ConvexProvider.tsx`) manages token lifecycle
6. Client-side: `useSession()` hook via TanStack Query with auto-redirect on auth failure

**Session object** includes `userId`, `organizationId`, `user`, `organization`, `availableOrganizations`, plus `can()`/`cannot()` methods for inline permission checks.

### WorkOS: Fine-Grained Authorization (FGA)

FGA provides resource-level permission checking (`src/lib/auth/authorization.ts`):
- `check(membershipId, permissionSlug, resourceType?, resourceId?)` — Single permission check (cached in Redis, 5min TTL)
- `checkMany(requests)` — Batch checks (50 per batch)
- `assignRole(membershipId, roleSlug, resource?)` / `removeRole()` — Role management
- `createResource()` / `deleteResource()` — Register resources in the FGA model
- Roles assigned to **organization memberships**, not users directly
- In Convex: FGA checks must happen in **actions** (not queries/mutations) since they call external API (`convex/lib/fga.ts`)

### WorkOS: Vault

Secure credential storage for solution integrations (`src/lib/services/vault.ts`):
- `vault.store(orgId, solutionLinkId, credentials)` → returns `vaultId`
- `vault.get(vaultId)` → decrypted credentials
- `vault.update(vaultId, partialCreds)` — Merge semantics (null=delete key, undefined=keep, value=overwrite)
- Optimistic locking with `versionCheck` and auto-retry (max 3)
- Named vaults: `solution_link:{orgId}:{solutionLinkId}`

### Convex Patterns

**Schema** (`convex/schema.ts`): Tables include `users`, `organizations`, `organizationMemberships`, `teams`, `services`, `serviceComponents`, `components`, `solutionLinks`, `dashboards`, `apiKeys`, `themes`, etc.

**Function wrappers** (`convex/lib/functions.ts`): `zQuery`, `zMutation`, `zAction` — Zod-validated wrappers with trigger support, auto UUID generation on insert, immutability enforcement on `id` field.

**Auth helpers** (`convex/lib/auth.ts`): `getCurrentUser()`, `getActiveOrganizationMembership()`, `verifyOrganizationAccess()`, `requireAuth()`, `requireOrgAuth()`.

**Key convention**: All Convex inserts get an auto-generated `id` (UUID v4). Relations use Convex ID references. Timestamps as Unix ms.

### What Synmetrix Will Adopt from FraiOS

These are the target patterns for adapting Synmetrix and client-v2:
- **WorkOS AuthKit** replacing hasura-backend-plus for authentication
- **WorkOS FGA** replacing Hasura row-level security and the `member_roles.access_list` system
- **WorkOS Vault** for secure credential storage (datasource connection strings, API keys)
- **Convex** as the real-time data layer (potential replacement for Hasura GraphQL + PostgreSQL)
- **TanStack Query** for frontend data fetching (replacing or augmenting URQL)
- **Next.js App Router** patterns (replacing Vite + @vitjs/vit routing in client-v2)
- **Redis-backed sessions** with sliding TTL (replacing localStorage JWT tokens)
- **Centralized query key factory** pattern (`src/lib/query-keys.ts`)

### Key cxs2 File Locations
- `src/lib/auth/session.ts` — Session management (Redis + WorkOS)
- `src/lib/auth/authorization.ts` — FGA client with caching
- `src/lib/services/vault.ts` — WorkOS Vault integration
- `convex/schema.ts` — Database schema
- `convex/lib/functions.ts` — Zod-wrapped query/mutation/action helpers
- `convex/lib/auth.ts` — Auth guards and user resolution
- `convex/lib/fga.ts` — FGA permission checks (action-only)
- `src/components/providers/ConvexProvider.tsx` — Custom Convex auth provider
- `src/lib/query-keys.ts` — TanStack Query key factory
- `src/contexts/team-context.tsx` — Team selection and permissions

## Key Dependencies

- **CubeJS**: Analytics engine with SQL API, pre-aggregations, multi-database support
- **Hasura v2**: GraphQL engine with migrations, actions, event triggers, row-level security
- **hasura-backend-plus**: Auth service (JWT, email/password, magic links) — *to be replaced by WorkOS*
- **CubeStore**: Columnar storage for pre-aggregation caching
- **CLI**: oclif + zx for Docker orchestration commands

## Active Technologies
- TypeScript (ES2022, Node16 modules) — matches + oclif (CLI framework), zx (shell execution) (001-dev-environment)
- PID file at `.dev-client-v2.pid` for client-v2 process (001-dev-environment)
- JavaScript (ES modules), Node.js 18 + `@workos-inc/node` ^8.4.0, `ioredis` (existing), `express` ^4.17.1 (existing), `jsonwebtoken` (existing), `jose` (existing) (002-workos-auth)
- PostgreSQL (existing, via Hasura), Redis (new, for sessions) (002-workos-auth)
- JavaScript (ES modules), Node.js 20.19.2 → 22.x (upgrade required) + Cube.js v1.3.23 → v1.6.x, Express 4.18.2, ioredis 5.3.2, React 18 + Vite 4 + Ant Design 5 (frontend) (003-update-deps)
- PostgreSQL (via Hasura), CubeStore v1.3.23 → v1.6.x (one-way partition format upgrade) (003-update-deps)
- JavaScript (ES modules), Node.js 18+ + Cube.js v1.6.x (CubeJS service), Express 4.x (both services), `yaml@^2.3.4` (CubeJS — YAML parse/generate), `js-yaml@^4.1.0` (Actions), `@cubejs-backend/clickhouse-driver` (wraps `@clickhouse/client@^1.7.0`) (004-dynamic-model-creation)
- PostgreSQL via Hasura (versions, dataschemas, team settings), ClickHouse (profiling target — read-only) (004-dynamic-model-creation)
- JavaScript (ES modules), Node.js 18+ + Cube.js v1.6.x (CubeJS), Express 4.x (Actions), Hasura v2 (GraphQL), React 18 + Vite + Ant Design 5 (client-v2), URQL (GraphQL client), Zustand (state) (005-simple-access-controls)
- PostgreSQL (via Hasura), Redis (sessions), CubeStore (query cache) (005-simple-access-controls)
- TypeScript (client-v2, React 18 + Vite 4), JavaScript ES modules (CubeJS service, Node.js 18+) + Monaco Editor (existing), `yaml` ^2.3.4 (existing in CubeJS, add to client-v2), `@cubejs-backend/schema-compiler` ^1.6.19 (existing in CubeJS), Ant Design 5 (existing in client-v2), URQL (existing GraphQL client) (006-model-authoring)
- N/A (schema spec is static; cube registry is in-memory from FetchMeta) (006-model-authoring)
- JavaScript (ES modules), Node.js 22 + `jose` ^6.x (new for CubeJS), `@workos-inc/node` (existing in Actions, NOT added to CubeJS — use direct fetch), `jsonwebtoken` (existing in CubeJS, kept for HS256 path) (007-workos-jwt-query)
- PostgreSQL via Hasura GraphQL (existing), In-memory Map caches (existing + new) (007-workos-jwt-query)
- JavaScript (ES modules), Node.js 22 + `jose` v6.2.1 (JWKS + JWT signing), `http-proxy-middleware` v3.0.0 (HTTP/WS proxy, direct dependency), Express 4.18.2 (008-hasura-proxy)
- In-memory Map caches only (no DB changes) (008-hasura-proxy)
- JavaScript (ES modules), Node.js 22+ + Express 4.18.2 (CubeJS routes), `@cubejs-backend/clickhouse-driver` (wraps `@clickhouse/client` ^1.12.0), `smartdataHQ/toolkit` (jsonstat-toolkit fork, zero deps), React 18 + Vite + Ant Design 5 (client-v2) (009-query-output)
- N/A — no database schema changes. Query results are transient. (009-query-output)
- JavaScript (ES modules), Node.js 22+ + Cube.js v1.6.x (CubeJS service), Express 4.18.2, `openai` npm v6.x (NEW), React 18 + Vite + Ant Design 5 (client-v2), URQL (GraphQL client) (010-dynamic-models-ii)
- PostgreSQL via Hasura (versions, dataschemas), ClickHouse (profiling target — read-only) (010-dynamic-models-ii)
- JavaScript (ES modules), Node.js 22.x (already current in cubejs service after 003-update-deps) + `@cubejs-backend/schema-compiler` ^1.6.19 (existing; `prepareCompiler` powers validation), `@cubejs-backend/server-core` ^1.6.19 (existing; exposes `cubejs.compilerCache` LRU-cache), `@cubejs-backend/api-gateway` ^1.6.19 (existing; `getCompilerApi` + `filterVisibleItemsInMeta`), `jose` (existing; FraiOS/WorkOS JWT verification), Express 4.x (existing router). No new dependencies. (011-model-mgmt-api)
- PostgreSQL via Hasura (existing `dataschemas`, `versions`, `branches` tables — one new Hasura delete-permission migration on `dataschemas`). In-memory LRU compiler cache inside the cubejs process (existing). No new tables. (011-model-mgmt-api)
- JavaScript (ES modules), Node.js 22.x (CubeJS service), Node.js 18+ (Actions service) + Cube.js v1.6.x (`@cubejs-backend/server-core`, `schema-compiler`, `api-gateway` — all existing), Express 4.18.2 (existing), `yaml` ^2.3.4 (existing), Hasura v2 (existing). **No new npm dependencies.** (013-mature-default-models)
- PostgreSQL via Hasura — existing `datasources`, `branches`, `versions`, `dataschemas`, `teams.settings`, `query_rewrite_rules`; ONE new table `reconciliation_runs` + one new `team.settings` key. ClickHouse: probe target, read-only. (013-mature-default-models)

## Recent Changes
- 001-dev-environment: Added TypeScript (ES2022, Node16 modules) — matches + oclif (CLI framework), zx (shell execution)
