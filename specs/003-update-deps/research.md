# Research: Update All Dependencies

**Feature**: 003-update-deps | **Date**: 2026-03-07

## R-001: Cube.js Upgrade Path v1.3.x → v1.6.x

**Decision**: Upgrade directly from v1.3.x (mixed state: package.json declares `^1.3.23`, yarn.lock resolves to 1.3.85/1.3.86) to the latest stable v1.6.x release. No intermediate stops at v1.4 or v1.5.

**Rationale**: Cube.js releases are backward-compatible within minor versions. The breaking changes are well-documented across v1.5 and v1.6 release notes, and the spec already accounts for all of them. A direct jump avoids double-testing.

**Alternatives considered**:
- Step-wise upgrade (v1.3→v1.4→v1.5→v1.6): More cautious but triples the testing effort with no additional safety. Rejected.
- Stay on v1.4 LTS: Misses query pushdown GA, multi-stage pre-aggregations, CubeStore upgrade, and default timezone. Rejected.

## R-002: Node.js Version for Dockerfile

**Decision**: Use `node:22-bullseye` as the base image. Pin to a specific patch version (e.g., `node:22.14.0-bullseye`) once confirmed stable with Cube.js v1.6.

**Rationale**: Cube.js v1.5+ requires Node.js 22. The Dockerfile currently uses Debian Bullseye and includes build tools (python3, gcc, g++, cmake, Java). Staying on Bullseye avoids revalidating all system-level dependencies.

**Alternatives considered**:
- Node.js 22 on Bookworm (Debian 12): Would require revalidating all APT packages and Java installation. No benefit. Rejected.
- Node.js 20 with compatibility flags: Not supported by Cube.js v1.5+. Rejected.

## R-003: CubeStore Version Compatibility

**Decision**: Update `CUBESTORE_VERSION` in `.env` to match the Cube.js v1.6.x release (e.g., `v1.6.19`). Check for arm64 tag availability.

**Rationale**: CubeStore version must match the Cube.js version for compatibility. Current value is `v1.3.23-arm64v8`. The v1.6 upgrade includes a one-way partition format change (DataFusion 4.0→46.0). Old partitions are readable but new partitions use the new format.

**Alternatives considered**:
- Keep CubeStore at v1.3.23: Incompatible with Cube.js v1.6. Rejected.
- Clear `.cubestore` volume before upgrade: Unnecessary — old partitions are readable. Pre-aggregations will rebuild on next refresh cycle.

## R-004: New Database Driver System Dependencies

**Decision**: Most new drivers are pure JavaScript/Node.js and require no additional system libraries. Oracle is the exception.

**Rationale**: Research of npm packages:
- `@cubejs-backend/oracle-driver`: Uses `oracledb` npm package which includes pre-built binaries for most platforms since v6.0. No Oracle Instant Client needed for "Thin" mode.
- `@cubejs-backend/sqlite-driver`: Uses `better-sqlite3` which requires only build tools (already in Dockerfile).
- `@cubejs-backend/pinot-driver`: Pure HTTP client. No system deps.
- `@cubejs-backend/risingwave-driver`: Uses PostgreSQL wire protocol (same as postgres-driver). No additional deps.
- `@cubejs-backend/singlestore-driver`: Uses MySQL wire protocol. No additional deps.
- `@cubejs-backend/fabric-driver`: Uses MSSQL/TDS protocol. No additional deps.

**Alternatives considered**:
- Oracle Instant Client "Thick" mode: Only needed for advanced features (LDAP, Kerberos). Thin mode is sufficient. Rejected.

## R-005: SQL API over HTTP Endpoint Routing

**Decision**: No proxy configuration changes needed. `POST /api/v1/cubesql` is auto-registered by `cubejs.initApp(app)` and already covered by existing proxy rules.

**Verified against source**: The Cube.js open-source codebase ([cube-js/cube](https://github.com/cube-js/cube)) registers `POST /cubejs-api/v1/cubesql` for SQL API over HTTP queries. With this project's `basePath: '/api'` (set in `index.js:L55`), this maps to `POST /api/v1/cubesql`. This is a *separate* endpoint from the existing `GET /api/v1/sql` (which translates Cube queries to SQL for debugging — not data retrieval).

**Rationale**:
- Nginx: `location /api/v1` proxies to `http://synmetrix-cubejs:4000` (already catches `/api/v1/cubesql`)
- Vite dev proxy: `/api/v1` → `http://localhost:4000` (already catches the new endpoint)
- Authentication: Inherits the same JWT verification from `checkAuth.js` via Cube.js middleware

**Alternatives considered**:
- Separate proxy rule for `/api/v1/cubesql`: Unnecessary duplication. Rejected.
- Custom route handler: Cube.js built-in handler is sufficient and maintained upstream. Rejected.

## R-006: Frontend Database Icon Strategy

**Decision**: Source SVG icons from official brand assets or open-source icon sets (Simple Icons, DevIcon). Create minimal monochrome SVGs consistent with existing database icons in `client-v2/src/assets/databases/`.

**Rationale**: The existing icons follow a consistent style (monochrome, ~48x48). New icons should match. Most database vendors provide brand guidelines or logos that can be adapted.

**Alternatives considered**:
- Use generic database icon for all new tiles: Poor UX — users identify databases by logo. Rejected.
- Use Ant Design icons: No database-specific icons available. Rejected.

## R-007: DriverDependencies Extension Pattern

**Decision**: Extend the `DriverDependencies` object imported from `@cubejs-backend/server-core` by adding entries for new drivers directly in `driverFactory.js`.

**Rationale**: The current `driverFactory.js` already imports and extends `DriverDependencies`. Adding new entries follows the established pattern. Some entries (oracle, sqlite, pinot, mysqlauroraserverless) are already in the upstream `DriverDependencies` but their npm packages aren't installed — installing the packages is sufficient for those. RisingWave, SingleStore, and Fabric may need explicit entries if not present in v1.6's `DriverDependencies`.

**Alternatives considered**:
- Fork `DriverDependencies` entirely: Over-engineering. The extension pattern works. Rejected.
- Auto-discover installed drivers: Fragile and non-deterministic. Explicit is better. Rejected.

## R-008: Elasticsearch Deprecation UI Pattern

**Decision**: Add a visual deprecation badge (e.g., "Deprecated" tag) to the Elasticsearch tile in `dataSources.tsx`. The tile remains functional — users can still create connections but are warned.

**Rationale**: The Elasticsearch driver still works in v1.6 but is deprecated. Blocking creation would break existing workflows. A visible warning allows informed decisions.

**Alternatives considered**:
- Remove Elasticsearch tile entirely: Too aggressive — existing users may rely on it. Rejected.
- Move to bottom of list: Insufficient warning — users might not notice. Rejected.

## R-009: Access Policy Audit Strategy

**Decision**: After upgrading Cube.js, run existing StepCI tests and manually test with known member roles to verify access control behavior. Fix any failing access patterns.

**Rationale**: Cube.js v1.6 strict access policy matching means policies now combine only those matching ALL members in a query. This could cause queries to return no data if some members aren't covered by a policy. The audit must verify that existing `member_roles.access_list` configurations produce identical results post-upgrade.

**Alternatives considered**:
- Pre-upgrade static analysis of access lists: Requires deep knowledge of Cube.js internals to predict behavior changes. Testing is more reliable. Rejected.
- Disable strict matching: Not supported in v1.6. Rejected.

## R-010: Snowflake/Databricks OAuth Connection Form Design

**Decision**: Add an "Authentication Method" toggle (dropdown or radio) to the Snowflake and Databricks connection forms. When OAuth is selected, show OAuth-specific fields (token for Snowflake, client ID + secret for Databricks). When username/password is selected, show existing fields.

**Rationale**: OAuth is an alternative to username/password, not a replacement. The connection form must support both methods. The toggle pattern keeps the form clean and avoids confusion.

**Alternatives considered**:
- Show all fields at once: Cluttered and confusing — users don't need both auth methods simultaneously. Rejected.
- OAuth only: Breaking change for existing users using username/password. Rejected.

## R-011: prepareDbParams.js Driver Normalization

**Decision**: Add driver-specific normalization entries to `services/cubejs/src/utils/prepareDbParams.js` for new drivers (Oracle, SQLite, Pinot, DuckDB) and OAuth modes (Snowflake, Databricks).

**Rationale**: `prepareDbParams.js` transforms `db_params` from the database into the format expected by Cube.js drivers. Existing patterns handle BigQuery (JSON credential parsing), MSSQL (boolean coercion), ClickHouse (protocol prefix), Athena (region extraction), Elasticsearch (URL construction), Snowflake (account normalization), Druid/KSQL (URL construction via `makeUrl()`), and Firebolt (engine name). New drivers that accept non-standard parameters need similar normalization. RisingWave, SingleStore, and Fabric use standard PostgreSQL/MySQL/MSSQL wire protocols and should work with default passthrough.

**Alternatives considered**:
- Skip normalization for new drivers: Risky — Oracle `serviceName` and Pinot HTTP URL construction won't work with raw `db_params`. Rejected.
- Normalize in frontend only: Violates separation of concerns — backend must handle what the driver expects. Rejected.

## R-012: hide_password() OAuth Secret Masking

**Decision**: Create a Hasura migration to extend the `hide_password()` SQL function to mask OAuth secrets (`oauthToken`, `oauthClientSecret`) in addition to `password`. Note: `oauthClientId` is not a secret (it identifies the application, not a credential) and does not need masking.

**Rationale**: The current `hide_password()` function (migration `1702052547606`) only masks the `{password}` key in `db_params` JSONB via `jsonb_set()`. OAuth secrets stored in `db_params` would be visible through the `db_params_computed` computed field, violating Constitution IV (Security by Default). The function must iterate over all sensitive keys (`password`, `oauthToken`, `oauthClientSecret`).

**Verified against source**: `services/hasura/migrations/1702052547606_hide_password function/up.sql` — single `jsonb_set(datasources_row.db_params, '{password}', '""')` call.

**Alternatives considered**:
- Mask in application layer: Would require changes to every query path that reads `db_params`. The SQL function approach is simpler and catches all access. Rejected.
- Store OAuth secrets separately: Over-engineering for this scope — secrets are part of `db_params` by design. Rejected.
