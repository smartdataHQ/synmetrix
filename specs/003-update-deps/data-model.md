# Data Model: Update All Dependencies

**Feature**: 003-update-deps | **Date**: 2026-03-07

## Overview

This upgrade does not introduce new database tables or modify the existing PostgreSQL schema. The data model changes are limited to:
1. Frontend configuration data (in-code, not database)
2. Environment configuration
3. Package dependency declarations

One Hasura migration is required: extending the `hide_password()` function to mask OAuth secrets (`oauthToken`, `oauthClientSecret`) in `db_params_computed`. Note: `oauthClientId` is not a secret and does not need masking.

## Entity: Database Driver Configuration

**Location**: `services/cubejs/src/utils/driverFactory.js` + `services/cubejs/package.json`

Each driver is defined by:

| Attribute | Description | Example |
|-----------|-------------|---------|
| `type` | String identifier used in datasource config | `"risingwave"` |
| `packageName` | npm package that provides the driver | `"@cubejs-backend/risingwave-driver"` |
| `version` | Pinned version matching Cube.js release | `"1.6.19"` |
| `specialHandling` | Whether `driverFactory.js` needs a custom import pattern | `false` (most drivers use generic pattern) |

### New Drivers to Add

| Type | Package | Wire Protocol | System Deps |
|------|---------|---------------|-------------|
| `oracle` | `@cubejs-backend/oracle-driver` | Oracle Net (Thin mode) | None |
| `sqlite` | `@cubejs-backend/sqlite-driver` | File-based | Build tools (already present) |
| `pinot` | `@cubejs-backend/pinot-driver` | HTTP | None |
| `risingwave` | `@cubejs-backend/risingwave-driver` | PostgreSQL | None |
| `singlestore` | `@cubejs-backend/singlestore-driver` | MySQL | None |
| `fabric` | `@cubejs-backend/fabric-driver` | TDS (MSSQL) | None |

## Entity: Database Tile (Frontend)

**Location**: `../client-v2/src/mocks/dataSources.tsx`

Each tile in the `dbTiles` array:

| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | string | Lowercase driver identifier — uppercased on creation (`useOnboarding.ts:183`), lowercased on retrieval (`useUserData.ts:56`) |
| `name` | string | Human-readable display name (note: the `DataSource` interface in `dataSource.ts:13` uses `name`, not `title`) |
| `icon` | ReactNode | SVG icon component |
| `deprecated` | boolean (new) | If `true`, show deprecation badge |

**Value lifecycle**: `dbTiles[].value` (lowercase, e.g. `"oracle"`) → uppercased to `db_type` on datasource creation (`useOnboarding.ts:183`) → stored as uppercase in PostgreSQL → lowercased on retrieval (`useUserData.ts:56`) to match back against tiles.

### New Tiles to Add

| Value | Title | Needs Icon | Deprecated |
|-------|-------|------------|------------|
| `duckdb` | DuckDB | Yes | No |
| `oracle` | Oracle | Yes | No |
| `sqlite` | SQLite | Yes | No |
| `pinot` | Apache Pinot | Yes | No |
| `risingwave` | RisingWave | Yes | No |
| `singlestore` | SingleStore | Yes | No |
| `fabric` | Microsoft Fabric | Yes | No |

### Existing Tiles (no changes needed)

| Value | Title | Notes |
|-------|-------|-------|
| `mysql` | MySQL | Tile and icon (`my-sql.svg`) already exist at `dataSources.tsx:L123`. Uses `default` form. |

### Modified Tiles

| Value | Change |
|-------|--------|
| `elasticsearch` | Add `deprecated: true` flag + visual badge |

## Entity: Connection Form (Frontend)

**Location**: `../client-v2/src/mocks/dataSources.tsx` (`dataSourceForms` object)

Each form definition maps a driver type to an array of `DataSoureSetupField` descriptors.

### Field Model Changes (Required)

The `DataSoureSetupField` interface in `types/dataSource.ts` must be extended:

| Attribute | Type | Status | Description |
|-----------|------|--------|-------------|
| `name` | string | Existing | Nested path like `"db_params.host"` |
| `label` | string | Existing | i18n key for label |
| `type` | `"text" \| "checkbox" \| "password" \| "file" \| "number" \| "radio" \| "select"` | **Extended** | Add `"radio"` and `"select"` |
| `rules` | object | Existing | Validation rules |
| `value` | string | Existing | Default value |
| `placeholder` | string | Existing | i18n key for placeholder |
| `options` | `{label: string, value: string}[]` | **New** | Choices for radio/select fields |
| `dependsOn` | `{field: string, value: string}` | **New** | Conditional visibility — field is only shown when the specified field has the specified value |

`DataSourceSetup/index.tsx` must also be updated to forward `options` to the `Input` component and implement `dependsOn` conditional rendering using react-hook-form `watch()`.

### New Form Definitions

| Driver Type | Form Fields | Notes |
|-------------|-------------|-------|
| `oracle` | host, port (1521), user, password, service name | Uses EZConnect syntax |
| `sqlite` | database file path | Single field |
| `risingwave` | host, port (4566), user, password, database, ssl | PostgreSQL-compatible |
| `singlestore` | host, port (3306), user, password, database, ssl | MySQL-compatible |
| `fabric` | host, port, user, password, database, authentication method | TDS/MSSQL-compatible |
| `pinot` | host, port (8099), schema | HTTP controller URL |
| `duckdb` | database file path | Single field (or MotherDuck token) |

### Modified Form Definitions

| Driver Type | Change |
|-------------|--------|
| `snowflake` | Add auth method radio: username/password (existing) or OAuth token (new field). Fields use `dependsOn` for conditional visibility. |
| `databricks-jdbc` | Add auth method radio: personal access token (existing — token/url/database) or OAuth service principal (client ID + client secret). Note: existing auth is PAT, not username/password. |

### OAuth Field Name Mappings

| Driver | Form Field | `db_params` Key | Cube.js Env Var Equivalent |
|--------|-----------|-----------------|---------------------------|
| `snowflake` | OAuth Token | `db_params.oauthToken` | `CUBEJS_DB_SNOWFLAKE_OAUTH_TOKEN` |
| `databricks-jdbc` | Client ID | `db_params.oauthClientId` | `CUBEJS_DB_DATABRICKS_OAUTH_CLIENT_ID` |
| `databricks-jdbc` | Client Secret | `db_params.oauthClientSecret` | `CUBEJS_DB_DATABRICKS_OAUTH_CLIENT_SECRET` |

Note: Exact Cube.js environment variable names should be verified against v1.6 driver documentation during implementation.

## Entity: Environment Configuration

**Location**: `.env`

### New Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CUBESTORE_VERSION` | `v1.6.19` (update from `v1.3.23-arm64v8`) | CubeStore Docker image tag |
| `CUBEJS_DEFAULT_TIMEZONE` | `UTC` | Default timezone for time-based queries |
| `CUBEJS_TRANSPILATION_WORKER_THREADS` | `true` | Explicit opt-in to v1.5 default behavior |

## State Transitions

No new state transitions. Existing datasource lifecycle (create → configure → test → active) is unchanged.

## Relationships

```text
Database Driver (backend) 1:1 Database Tile (frontend)
Database Tile (frontend) 1:1 Connection Form (frontend)
Driver Type (string) = shared key across all three entities
```

The driver identifier string (e.g., `"risingwave"`) is the canonical key that must match exactly between `DriverDependencies` key (backend), `dbTiles[].value` (frontend), and `dataSourceForms` key (frontend). Note: the backend uses `type` in `DriverDependencies` while the frontend uses `value` in `dbTiles` — the values must be identical lowercase strings.
