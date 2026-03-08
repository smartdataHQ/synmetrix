# Feature Specification: Update All Dependencies

**Feature Branch**: `003-update-deps`
**Created**: 2026-03-07
**Status**: Draft
**Input**: User description: "Update All Dependencies"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Upgrade Cube.js Analytics Engine (Priority: P1)

As a platform operator, I need the Cube.js analytics engine upgraded from v1.3 to the latest stable version so the platform benefits from performance improvements, bug fixes, and new database driver support.

**Why this priority**: Cube.js is the core analytics engine. Upgrading it unblocks all other dependency updates (new drivers, new features) and addresses known issues in the current version. The v1.3→v1.6 gap includes critical improvements to pre-aggregation matching, query pushdown, and data model compilation speed.

**Independent Test**: Can be fully tested by starting the platform, connecting to an existing datasource, running queries, and verifying pre-aggregations still work correctly.

**Acceptance Scenarios**:

1. **Given** a running Synmetrix instance with the upgraded Cube.js, **When** a user runs a query against an existing datasource, **Then** the query returns correct results with no regressions.
2. **Given** existing data models with pre-aggregations, **When** the platform starts with the new Cube.js version, **Then** all pre-aggregations are recognized and used where applicable.
3. **Given** the upgraded runtime environment, **When** the platform compiles data models, **Then** compilation completes faster than or equal to the previous version.

---

### User Story 2 - Add Missing Database Connectors to the UI (Priority: P2)

As a platform user, I need to see all supported databases available when creating a new datasource, including databases that have backend driver support but are currently missing from the UI (DuckDB, MySQL) and newly supported databases (Oracle, SQLite, RisingWave, SingleStore, Microsoft Fabric, Apache Pinot).

**Why this priority**: Users cannot connect to supported databases if they don't appear in the datasource creation UI. Adding missing tiles directly expands the platform's usable database coverage.

**Independent Test**: Can be fully tested by navigating to the datasource creation screen and verifying all supported databases appear as selectable options with appropriate connection forms.

**Acceptance Scenarios**:

1. **Given** a user on the datasource creation screen, **When** they browse available databases, **Then** they see tiles for all supported databases including DuckDB, MySQL, Oracle, SQLite, RisingWave, SingleStore, Microsoft Fabric, and Apache Pinot.
2. **Given** a user selects a newly added database type, **When** they fill in the connection form, **Then** the form presents fields appropriate for that database type (e.g., host/port/credentials for network databases, file path for file-based databases).
3. **Given** a user submits a valid connection for a newly added database, **When** the system processes the connection, **Then** it successfully connects and the datasource becomes available for querying.

---

### User Story 3 - Deprecate Elasticsearch Connector (Priority: P3)

As a platform operator, I need clear communication that the Elasticsearch database connector is deprecated by the upstream analytics engine, so users are informed before creating new Elasticsearch datasources.

**Why this priority**: Elasticsearch support is deprecated in the latest Cube.js version. Users should be warned to avoid investing in new Elasticsearch integrations, while existing connections continue to work.

**Independent Test**: Can be fully tested by viewing the Elasticsearch tile in the datasource creation screen and confirming a deprecation notice is visible.

**Acceptance Scenarios**:

1. **Given** a user on the datasource creation screen, **When** they view the Elasticsearch option, **Then** they see a visible deprecation warning indicating the connector may be removed in a future version.
2. **Given** an existing Elasticsearch datasource, **When** the platform starts after the upgrade, **Then** the existing connection continues to function normally.

---

### User Story 4 - Upgrade Runtime Environment (Priority: P1)

As a platform operator, I need the container runtime upgraded to the version required by the latest Cube.js so the platform runs on a supported and secure foundation.

**Why this priority**: The latest Cube.js requires a newer Node.js runtime. Running on an unsupported runtime risks incompatibility and security vulnerabilities. This is a prerequisite for the Cube.js upgrade.

**Independent Test**: Can be fully tested by building the container image and verifying all services start and pass health checks.

**Acceptance Scenarios**:

1. **Given** the updated container image, **When** all services start, **Then** every service passes its health check within the expected timeframe.
2. **Given** the updated runtime, **When** existing functionality is exercised (queries, model compilation, authentication), **Then** all features work identically to the previous runtime version.

---

### User Story 5 - Enable SQL API over HTTP (Priority: P2)

As a platform user, I need to execute SQL queries against the analytics engine via a standard HTTP endpoint with streaming responses, so I can integrate with tools and workflows that use SQL rather than the proprietary query format.

**Why this priority**: The SQL API over HTTP is a major new capability that opens the platform to a broader range of integrations (BI tools, notebooks, CLI tools) without requiring specialized client libraries.

**Independent Test**: Can be fully tested by sending a SQL query to the new HTTP endpoint and receiving streamed results.

**Acceptance Scenarios**:

1. **Given** a user with valid credentials, **When** they send a SQL query to the SQL API over HTTP endpoint, **Then** they receive correctly formatted query results via a streaming response.
2. **Given** a complex SQL query joining multiple cubes, **When** submitted via the HTTP endpoint, **Then** the query is pushed down to the source database where possible and results are returned efficiently.
3. **Given** the frontend application, **When** a developer integrates with the SQL API over HTTP endpoint, **Then** the endpoint is accessible through the existing proxy configuration.

---

### User Story 6 - Support Calendar Cubes and Custom Time Dimensions (Priority: P3)

As a data modeler, I need to define custom calendar definitions within data models so I can support fiscal calendars, retail calendars (4-4-5), and custom time-shift calculations without manual workarounds.

**Why this priority**: Calendar cubes enable industry-specific time analysis (fiscal year comparisons, retail week calculations) that previously required complex custom SQL. This expands the platform's usefulness for enterprise users with non-standard calendars.

**Independent Test**: Can be fully tested by creating a data model with a custom calendar definition, running a query using a custom time granularity, and verifying correct results.

**Acceptance Scenarios**:

1. **Given** a data modeler creating a new data model, **When** they define a custom calendar with non-standard periods (e.g., fiscal quarters, 4-4-5 weeks), **Then** the platform accepts and compiles the model without errors.
2. **Given** a data model with a custom calendar, **When** a user queries using a custom time granularity, **Then** the results correctly group data according to the custom calendar periods.
3. **Given** a data model with time-shift calculations, **When** a user queries year-over-year comparisons using a fiscal calendar, **Then** the comparisons align to the correct fiscal periods.

---

### User Story 7 - Enable Query Pushdown for SQL API (Priority: P2)

As a platform operator, I need SQL API queries to be pushed down directly to source databases where possible, so query performance improves and the analytics engine avoids unnecessary intermediate processing.

**Why this priority**: Query pushdown (now generally available) significantly improves performance for SQL API queries by executing them directly on the source database rather than pulling data through the analytics engine. This reduces latency and resource consumption.

**Independent Test**: Can be fully tested by running a SQL API query and verifying it executes against the source database rather than being processed intermediately.

**Acceptance Scenarios**:

1. **Given** a SQL query submitted through the SQL API, **When** the query can be fully satisfied by a single source database, **Then** the query is pushed down to that database and results are returned directly.
2. **Given** a query that cannot be pushed down (e.g., cross-database joins), **When** submitted through the SQL API, **Then** the query falls back to standard processing with no errors.

---

### User Story 8 - Support Enhanced Authentication for Cloud Databases (Priority: P3)

As a platform user connecting to cloud-hosted databases, I need to authenticate using modern OAuth-based methods (Snowflake OAuth tokens, Databricks service principal OAuth) instead of only static credentials (username/password for Snowflake, personal access token for Databricks), so I can follow my organization's security policies.

**Why this priority**: Enterprise users increasingly require OAuth-based authentication for cloud databases. Supporting these methods removes a blocker for organizations with strict security policies that prohibit long-lived passwords.

**Independent Test**: Can be fully tested by creating a datasource connection to Snowflake or Databricks using OAuth credentials and verifying the connection succeeds.

**Acceptance Scenarios**:

1. **Given** a user creating a Snowflake datasource, **When** they choose OAuth token authentication, **Then** the connection form presents the appropriate OAuth token field and the connection succeeds with a valid token.
2. **Given** a user creating a Databricks datasource, **When** they choose service principal OAuth, **Then** the connection form presents client ID and client secret fields and the connection succeeds with valid credentials. (Note: existing Databricks auth uses a personal access token, not username/password.)
3. **Given** existing Snowflake connections using username/password and existing Databricks connections using personal access token, **When** the platform is upgraded, **Then** those connections continue to work without changes.

---

### User Story 9 - Support Multi-Stage Pre-Aggregations (Priority: P3)

As a data modeler, I need to define pre-aggregations that build upon other pre-aggregations in stages, so I can create efficient aggregation pipelines for complex analytical workloads without reprocessing raw data at each level.

**Why this priority**: Multi-stage pre-aggregations reduce data processing time and cost by allowing incremental aggregation chains. This is particularly valuable for large datasets where reprocessing from raw data is expensive.

**Independent Test**: Can be fully tested by defining a multi-stage pre-aggregation chain, triggering a refresh, and verifying each stage builds correctly from its predecessor.

**Acceptance Scenarios**:

1. **Given** a data model with a pre-aggregation defined to build from another pre-aggregation, **When** the refresh worker processes them, **Then** the dependent pre-aggregation uses the parent's results rather than querying raw data.
2. **Given** a multi-stage chain where the parent pre-aggregation is refreshed, **When** the refresh completes, **Then** dependent stages are automatically scheduled for refresh.

---

### User Story 10 - Support Default Timezone Configuration (Priority: P3)

As a platform operator, I need to configure a default timezone for the analytics engine so all time-based queries use a consistent timezone unless explicitly overridden, reducing timezone-related data discrepancies.

**Why this priority**: Without a configurable default timezone, time-based queries may produce inconsistent results depending on server locale. A platform-level default ensures consistency across all users and queries.

**Independent Test**: Can be fully tested by setting the default timezone configuration, running a time-based query, and verifying results align with the configured timezone.

**Acceptance Scenarios**:

1. **Given** a platform operator who sets a default timezone, **When** a user runs a time-based query without specifying a timezone, **Then** the results use the configured default timezone.
2. **Given** a default timezone is configured, **When** a user explicitly specifies a different timezone in their query, **Then** the query uses the user-specified timezone, overriding the default.

---

### User Story 11 - Support Query Cache Control (Priority: P3)

As a platform user, I need to control caching behavior per query so I can choose between fast cached responses for dashboards and fresh uncached responses for ad-hoc analysis.

**Why this priority**: The cache parameter on query endpoints gives users explicit control over data freshness versus response speed, which is important for different use cases (real-time monitoring vs. historical dashboards).

**Independent Test**: Can be fully tested by issuing two identical queries — one requesting cached results and one requesting fresh results — and verifying different cache behaviors.

**Acceptance Scenarios**:

1. **Given** a user running a dashboard query, **When** they request cached results, **Then** the system returns previously computed results immediately without hitting the source database.
2. **Given** a user running an ad-hoc query, **When** they request fresh (uncached) results, **Then** the system bypasses the cache and queries the source database directly.

---

### User Story 12 - Support View Member Overrides (Priority: P3)

As a data modeler, I need to customize the display title, description, metadata, and format of individual members when they are exposed through views, so that the same underlying measure or dimension can be presented differently in different contexts without duplicating the model definition.

**Why this priority**: View member overrides reduce model duplication and allow context-specific presentation. A single "revenue" measure can appear as "Total Revenue" in a finance view and "Sales Revenue" in a sales view.

**Independent Test**: Can be fully tested by creating a view with member overrides, querying the view's metadata, and verifying the overridden titles and descriptions appear correctly.

**Acceptance Scenarios**:

1. **Given** a data model view that overrides a member's title, **When** a user queries the view's metadata, **Then** the overridden title is returned instead of the original.
2. **Given** a data model view that overrides a member's format, **When** a user queries data through that view, **Then** the result formatting reflects the view-level override.

---

### Edge Cases

- What happens when an existing pre-aggregation uses a query pattern that no longer matches under stricter matching rules?
- How does the system handle data model view definitions with ambiguous join paths that the new version rejects?
- What happens when a user attempts to connect to Elasticsearch after the deprecation warning is shown — can they still proceed?
- How does the platform behave if the Cube Store partition format is upgraded and a rollback is attempted?
- What happens when a newly added database driver fails to load due to missing system-level dependencies (e.g., Oracle client libraries)?
- What happens when a SQL API query is sent to the HTTP endpoint but the query references cubes the user does not have access to?
- How does the system handle OAuth token expiry mid-query for Snowflake or Databricks connections?
- What happens when a multi-stage pre-aggregation's parent stage fails during refresh — does the dependent stage retry or fail gracefully?
- What happens when a user specifies both a cache control parameter and the query hits a pre-aggregation — which takes precedence?
- How does the default timezone interact with datasources whose source data is stored in a different timezone?
- How does the Firebolt default refresh key change in v1.6 affect existing Firebolt pre-aggregation schedules?
- How does the DuckDB S3 URL format change in v1.5 affect existing DuckDB datasources using S3 paths?

## Requirements *(mandatory)*

### Functional Requirements

#### Core Upgrade

- **FR-001**: System MUST upgrade Cube.js from v1.3.x to the latest stable v1.6.x release across all backend services (analytics API, refresh worker).
- **FR-002**: System MUST upgrade the container runtime from Node.js 20 to Node.js 22 as required by the latest Cube.js.
- **FR-003**: System MUST update all related npm dependencies to compatible versions (peer dependencies, transitive dependencies).
- **FR-004**: System MUST maintain backward compatibility with all existing datasource connections and configurations.
- **FR-005**: System MUST ensure existing pre-aggregations continue to function after the upgrade, documenting any query patterns that require adjustment.
- **FR-006**: System MUST validate that the access control system (access lists, member roles) continues to enforce permissions correctly under the new version's stricter policy matching.
- **FR-007**: System MUST audit and fix all existing data model definitions that break due to stricter validation, including ambiguous join paths and access policy matching changes. All fixes are part of this upgrade work.

#### New Database Connectors

- **FR-008**: System MUST install backend drivers for Oracle, SQLite, Apache Pinot, RisingWave, SingleStore, and Microsoft Fabric.
- **FR-009**: System MUST update the driver dependencies configuration to include entries for all newly added drivers. The current import from `@cubejs-backend/server-core/dist/src/core/DriverDependencies.js` is a private internal path that may break in v1.6.x — must be audited and migrated to a stable API if the path changes.
- **FR-009a**: System MUST add driver-specific parameter normalization to `services/cubejs/src/utils/prepareDbParams.js` for new drivers that don't use standard host/port/user/password patterns (Oracle service name, SQLite/DuckDB file path, Pinot HTTP URL) and for OAuth auth modes (Snowflake `oauthToken`, Databricks `oauthClientId`/`oauthClientSecret`).
- **FR-010**: System MUST add database selection tiles to the frontend UI for DuckDB, Oracle, SQLite, RisingWave, SingleStore, Microsoft Fabric, and Apache Pinot. (MySQL tile already exists.)
- **FR-011**: System MUST provide appropriate connection forms for each newly added database type with fields matching that database's connection requirements. Three changes are required to support OAuth auth-method toggles: (1) the `DataSoureSetupField.type` union in `types/dataSource.ts` must be extended to include `"radio"` and `"select"` (already supported by `Input` component); (2) the `DataSoureSetupField` interface must be extended with an `options` property for radio/select choices since the current interface has no way to pass options; (3) `DataSourceSetup/index.tsx` must be updated to forward the `options` prop to the `Input` component (currently only forwards `rules`, `control`, `fieldType`, `name`, `placeholder`, `label`, `defaultValue`) and to support conditional field visibility based on the selected auth method (e.g., a `dependsOn` property on `DataSoureSetupField`).
- **FR-012**: System MUST display a deprecation warning on the Elasticsearch database tile in the frontend UI. This requires adding a `deprecated` property to the tile type (`DataSource` in `types/dataSource.ts`), a visual badge to `FormTile` component, and rendering logic in `DataSourceSelection`.

#### SQL API over HTTP

- **FR-013**: System MUST expose the SQL API over HTTP endpoint (`POST /api/v1/cubesql`) for executing SQL queries with streaming JSONL responses.
- **FR-014**: System MUST route the SQL API over HTTP endpoint through the existing proxy configuration with full exposure to both frontend and external tools (BI tools, notebooks, CLI clients).
- **FR-015**: System MUST enforce the same authentication and access control on the SQL API over HTTP endpoint as on existing query endpoints.

#### Query Pushdown

- **FR-016**: System MUST enable SQL API query pushdown so eligible queries execute directly on the source database.
- **FR-017**: System MUST fall back gracefully to standard query processing when a query cannot be pushed down.

#### Calendar Cubes

- **FR-018**: System MUST support custom calendar definitions in data models, including fiscal calendars and retail calendars (e.g., 4-4-5).
- **FR-019**: System MUST support custom time dimension granularities derived from calendar cube definitions.
- **FR-020**: System MUST support time-shift calculations using custom calendar periods.

#### Enhanced Cloud Database Authentication

- **FR-021**: System MUST support Snowflake OAuth token authentication as an alternative to username/password.
- **FR-022**: System MUST support Databricks service principal OAuth authentication as an alternative to personal access token.
- **FR-023**: System MUST present appropriate authentication fields in the frontend connection forms when OAuth authentication is selected for Snowflake or Databricks.
- **FR-023a**: System MUST extend the Hasura `hide_password` computed field function to also mask OAuth secrets (`oauthToken`, `oauthClientSecret`) stored in `db_params`, so they are not leaked via `db_params_computed` in GraphQL responses. Note: `oauthClientId` is not a secret and does not need masking. (Security by Default — Constitution IV.)

#### Multi-Stage Pre-Aggregations

- **FR-024**: System MUST support defining pre-aggregations that build from other pre-aggregations in a staged pipeline.
- **FR-025**: System MUST automatically schedule dependent pre-aggregation stages for refresh when a parent stage completes.

#### Default Timezone

- **FR-026**: System MUST support a platform-level default timezone configuration for all time-based queries.
- **FR-027**: System MUST allow per-query timezone overrides that take precedence over the default.

#### Query Cache Control

- **FR-028**: System MUST support a cache control parameter on query endpoints allowing users to request cached or fresh results. Note: the Actions service wrapper (`cubejsApi.js`) hardcodes a `queryBaseMembers` allowlist that strips unknown query properties — the `cache` parameter must be added to this allowlist, and the existing `renewQuery` injection logic must be audited for compatibility with v1.6 cache semantics.
- **FR-029**: System MUST respect cache control parameters when pre-aggregations are available, with clear precedence rules.

#### View Member Overrides

- **FR-030**: System MUST support overriding member title, description, metadata, and format at the view level.
- **FR-031**: System MUST return overridden metadata when view metadata is queried through the API.

### Key Entities

- **Database Driver**: A connector module enabling the analytics engine to communicate with a specific database type. Each driver has a name, npm package, required connection parameters, and compatibility status.
- **Database Tile**: A UI element representing a selectable database type during datasource creation. Each tile has an icon, display name, and associated connection form definition.
- **Connection Form**: A set of input fields specific to a database type (e.g., host, port, username, password, database name, file path, authentication token) presented when a user creates a datasource.
- **Calendar Cube**: A data model construct that defines custom time periods, granularities, and calendar logic (fiscal years, retail weeks) used to group and compare time-based data.
- **Pre-Aggregation Stage**: A level in a multi-stage pre-aggregation pipeline where each stage builds upon the results of its parent stage rather than querying raw data.

## Clarifications

### Session 2026-03-07

- Q: What rollback strategy is needed if the upgrade fails or causes regressions? → A: No rollback plan; this is a development environment — rebuild from scratch if needed.
- Q: How should existing data models that break due to stricter validation be handled? → A: Fix all breaking models during the upgrade as part of this work.
- Q: What is the exposure scope for the SQL API over HTTP endpoint? → A: Full exposure — route through proxy so both frontend and external tools can use it.

## Assumptions

- Synmetrix uses the **open-source edition** of Cube.js (`@cubejs-backend/*` packages from npm / [cube-js/cube](https://github.com/cube-js/cube) on GitHub), **not** Cube Cloud or any enterprise/closed-source variant. We have full access to the source code for verifying behavior, endpoint registration, driver internals, and breaking changes. All features referenced in this spec are available in the open-source edition.
- The Cube Store partition format upgrade is acceptable since this is a development environment. No rollback plan is required; if the upgrade fails, the environment can be rebuilt from scratch. Production upgrade will be planned separately.
- Aurora Serverless MySQL driver is excluded from new additions as it is a niche AWS-specific variant; standard MySQL support covers the common use case.
- MotherDuck support is excluded as a separate tile and will be documented as a DuckDB configuration option.
- The Vue 2 client library deprecation does not affect this project since the frontend uses React.
- Database icons (SVGs) for newly added databases will need to be sourced or created as part of this work.
- The Tesseract engine is in preview status and will be enabled as an opt-in experimental feature rather than the default query engine.
- SQL API over HTTP will use the same JWT-based authentication already in place for existing API endpoints.
- Calendar cube support, multi-stage pre-aggregations, view member overrides, and query cache control are analytics engine features that primarily require configuration enablement and documentation rather than custom code; the platform must not block their use.
- OAuth authentication fields for Snowflake and Databricks will be added as optional alternatives alongside existing username/password fields in the connection forms.
- The Actions service (`services/actions/src/utils/cubejsApi.js`) proxies 7 CubeJS endpoint groups (get-schema, generate-models, test, run-sql, pre-aggregations, pre-aggregation-preview, run-scheduled-refresh) and is part of the affected upgrade surface. It also normalizes queries via a `queryBaseMembers` allowlist and injects `renewQuery` — new query parameters like `cache` will be stripped unless the allowlist is extended. Changes to CubeJS response formats can regress actions-mediated flows (connection tests, schema generation, SQL execution, pre-aggregation previews) without touching the React app.
- Frontend UI changes in `../client-v2` are developed and tested locally via `yarn dev`. Production release packaging is out of scope for this feature work.
- The datasource `db_type` column stores uppercase values (e.g., `"POSTGRES"`). The frontend uppercases on creation (`useOnboarding.ts:183`) and lowercases on retrieval (`useUserData.ts:56`) to match `dbTiles[].value`. New driver `value` strings must be lowercase in `dataSources.tsx`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All existing datasource connections continue to work without reconfiguration after the upgrade.
- **SC-002**: All platform services pass their health checks after the upgrade with no increase in startup time beyond 20%.
- **SC-003**: Data model compilation time is equal to or faster than the pre-upgrade baseline.
- **SC-004**: Users can see and select all supported database types (29 options) when creating a new datasource.
- **SC-005**: Users can successfully create a connection to each newly added database type when valid credentials are provided.
- **SC-006**: The Elasticsearch tile clearly communicates its deprecated status before users begin configuration.
- **SC-007**: All existing user permissions and access controls produce identical authorization outcomes after the upgrade.
- **SC-008**: Users can execute SQL queries via the SQL API HTTP endpoint and receive streaming results with time-to-first-byte within 10% overhead of equivalent queries through existing endpoints.
- **SC-009**: SQL API queries that qualify for pushdown execute at least 30% faster than equivalent non-pushdown queries, measured as average response time over 5 identical runs of a single-datasource `SELECT COUNT(*) ... GROUP BY` query with pushdown enabled vs disabled.
- **SC-010**: Data modelers can define and query custom calendar-based time dimensions with correct period grouping.
- **SC-011**: Users can authenticate to Snowflake and Databricks using OAuth credentials through the platform UI.
- **SC-012**: Multi-stage pre-aggregation refreshes complete without reprocessing raw data at dependent stages.
- **SC-013**: Time-based queries default to the platform-configured timezone when no explicit timezone is specified.
- **SC-014**: Users can control cache behavior per query, with cached queries responding at least 50% faster than uncached equivalents.

## References

### Cube.js Release Notes & Changelogs

- **Cube Core v1.4 LTS** — https://cube.dev/blog/cube-core-v1-4-new-lts-release
  - First LTS release, foundation for v1.5+ features
- **Cube Core v1.5** — https://cube.dev/blog/cube-core-v1-5-performance-calendar-cubes-sql-api-over-http
  - Calendar cubes, SQL API over HTTP, cache parameter, view member overrides, 2-3x compilation speedup, DuckDB v1.4.1, Snowflake OAuth, Databricks OAuth, Tesseract engine preview
  - Breaking: stricter pre-aggregation matching, Node.js 22 required, DuckDB S3 URL changes, `CUBEJS_TRANSPILATION_WORKER_THREADS` defaults to `true`
- **Cube Core v1.6** — https://cube.dev/blog/cube-core-v1-6-cube-store-upgrade-multi-stage-pre-aggregations
  - Cube Store upgrade (DataFusion 4.0→46.0, DECIMAL(38), CTEs), multi-stage pre-aggregations, query pushdown GA, `CUBEJS_DEFAULT_TIMEZONE`, `lastRefreshTime` in `/cubesql`, lazy-loading vendor SDKs
  - Breaking: Cube Store partition format (one-way upgrade), strict join path validation in views, strict access policy matching, Elasticsearch driver deprecated, Firebolt default refresh key changed
- **GitHub Releases** — https://github.com/cube-js/cube/releases
  - Full release-by-release changelog for all v1.3.x through v1.6.x versions

### Cube.js Documentation

- **Supported Data Sources** — https://cube.dev/docs/product/configuration/data-sources
  - Full list of supported database drivers and their configuration options
- **RisingWave Driver** — https://cube.dev/docs/product/configuration/data-sources/risingwave
- **SingleStore Driver** — https://cube.dev/docs/product/configuration/data-sources/singlestore
- **Calendar Cubes** — https://cube.dev/docs/product/data-modeling/concepts/calendar-cubes
- **SQL API over HTTP** — https://cube.dev/docs/product/apis-integrations/sql-api
- **Query Pushdown** — https://cube.dev/docs/product/apis-integrations/sql-api/query-pushdown
- **Pre-Aggregations** — https://cube.dev/docs/product/caching/using-pre-aggregations
- **View Member Overrides** — https://cube.dev/docs/product/data-modeling/concepts/views

### Driver Packages (npm)

- **Oracle** — https://www.npmjs.com/package/@cubejs-backend/oracle-driver
- **SQLite** — https://www.npmjs.com/package/@cubejs-backend/sqlite-driver
- **Apache Pinot** — https://www.npmjs.com/package/@cubejs-backend/pinot-driver
- **RisingWave** — https://www.npmjs.com/package/@cubejs-backend/risingwave-driver
- **SingleStore** — https://www.npmjs.com/package/@cubejs-backend/singlestore-driver
- **Microsoft Fabric** — https://www.npmjs.com/package/@cubejs-backend/fabric-driver

### Migration & Breaking Changes

- **v1.5 Migration Guide** — https://cube.dev/docs/product/deployment/upgrading/v1-5
  - Pre-aggregation matching changes, Node.js 22 requirement, DuckDB S3 changes
- **v1.6 Migration Guide** — https://cube.dev/docs/product/deployment/upgrading/v1-6
  - Cube Store partition format, strict view join paths, strict access policies, Elasticsearch deprecation
