# Quickstart: Dynamic Model Creation

**Branch**: `004-dynamic-model-creation`

## Prerequisites

- Docker Desktop with Tailscale/host networking enabled (for dev ClickHouse access)
- Both repos checked out: `synmetrix/` and `../client-v2/`
- Services running: `./cli.sh compose up`
- Client-v2 running: `cd ../client-v2 && yarn dev`
- **dev-clickhouse datasource configured** (see below)

### Dev ClickHouse Setup

All integration tests and manual verification run against `dev-clickhouse` on Tailscale (`100.87.250.36`). The target table is `cst.semantic_events`.

1. Ensure Tailscale is connected and `dev-clickhouse` is reachable:
   ```bash
   ping 100.87.250.36
   ```

2. Create a ClickHouse datasource in Synmetrix pointing to `dev-clickhouse`:
   - **Host**: `100.87.250.36`
   - **Port**: `8123` (HTTP)
   - **Database**: `cst`
   - **User/Password**: Use the dev credentials from your environment

3. Verify connectivity by running a test query in the Synmetrix UI or via the CubeJS SQL API.

4. The test table `cst.semantic_events` contains Map columns, Array columns, scalar columns, and partitioned data — it exercises all profiling code paths (Map key discovery, Array detection, LC enumeration, primary key detection, partition scoping).

**Note**: Docker containers access `dev-clickhouse` via Tailscale networking. Ensure Docker Desktop has host/Tailscale networking enabled (see MEMORY.md).

## Development Sequence

### 1. Hasura Migration

```bash
# Create migration for teams.settings column
cd services/hasura
# Add migration files (up.sql + down.sql) — see contracts/hasura-actions.md
./cli.sh hasura cli "migrate apply"
```

### 2. Hasura Metadata

Update these files:
- `services/hasura/metadata/actions.graphql` — add new types
- `services/hasura/metadata/actions.yaml` — add new action handlers
- `services/hasura/metadata/tables.yaml` — add `settings` to teams permissions

### 3. CubeJS Smart Generation Modules

New files in `services/cubejs/src/utils/smart-generation/`:
- `profiler.js` — ClickHouse table profiling
- `typeParser.js` — ClickHouse type string parser
- `fieldProcessors.js` — Column type → dimension/measure classification
- `cubeBuilder.js` — Build cube objects from profiled data
- `yamlGenerator.js` — Serialize cubes to YAML with meta tags
- `merger.js` — Field-level smart merge
- `primaryKeyDetector.js` — Primary key detection
- `progressEmitter.js` — SSE progress event helper (dual-mode: stream or no-op)

### 4. CubeJS Routes

New routes:
- `services/cubejs/src/routes/profileTable.js` — `POST /api/v1/profile-table`
- `services/cubejs/src/routes/smartGenerate.js` — `POST /api/v1/smart-generate`

Register in `services/cubejs/index.js`.

### 5. CubeJS Security Context Changes

Modify:
- `services/cubejs/src/utils/dataSourceHelpers.js` — extend `findUser` query to include team.settings
- `services/cubejs/src/utils/defineUserScope.js` — extract partition + internal tables
- `services/cubejs/src/utils/buildSecurityContext.js` — include partition in context hash

**Note**: `queryRewrite.js` is NOT modified. Partition filtering is embedded in the generated YAML `sql` property (Decision 8).

### 6. Actions RPC Handlers

New files:
- `services/actions/src/rpc/profileTable.js` — proxy to CubeJS profile-table
- `services/actions/src/rpc/smartGenSchemas.js` — proxy to CubeJS smart-generate
- `services/actions/src/rpc/updateTeamSettings.js` — team settings CRUD

Extend `services/actions/src/utils/cubejsApi.js` with new methods:
- `profileTable(params)` — calls `/api/v1/profile-table`
- `smartGenerate(params)` — calls `/api/v1/smart-generate`

### 7. Frontend Changes

GraphQL:
- `client-v2/src/graphql/gql/datasources.gql` — add ProfileTable + SmartGenDataSchemas
- `client-v2/src/graphql/gql/teams.gql` — add TeamSettings query/mutation (new file)
- Run `yarn codegen`

Hooks:
- `client-v2/src/hooks/useSources.ts` — add smart generation methods
- `client-v2/src/hooks/useTeamSettings.ts` — new hook (team settings CRUD)

Components:
- `client-v2/src/components/DataModelGeneration/` — add Smart Generate option + profiling preview
- `client-v2/src/components/ModelsSidebar/` — add Re-profile button
- `client-v2/src/pages/Models/` — orchestrate two-step flow

## Testing

### Unit Tests (TDD)

Write tests first for each module:
- Type parser: ClickHouse type strings → parsed types
- Field processors: ProfiledColumns → CubeFields
- Cube builder: ProfiledTable → cube JS objects
- YAML generator: cube objects → valid YAML with meta tags
- Merger: existing YAML + new fields → merged YAML (preserving user fields)

### Integration Tests (StepCI)

Add to `tests/` workflow:
- Profile table action (happy path + non-ClickHouse datasource error)
- Smart generate action (happy path + re-profile merge)
- Team settings update (owner vs member permissions)

### Manual Verification

All manual tests use the `dev-clickhouse` datasource and `cst.semantic_events` table.

1. Start services, verify `dev-clickhouse` datasource is connected
2. Generate standard model for `cst.semantic_events`
3. Generate smart model for same table — verify replacement
4. Add custom fields to smart model
5. Re-profile — verify custom fields preserved
6. Configure team partition — verify profiling is scoped
7. Query the model — verify partition filtering at runtime

## Key File Reference

| File | Purpose |
|------|---------|
| `specs/004-dynamic-model-creation/spec.md` | Feature specification |
| `specs/004-dynamic-model-creation/research.md` | Technology decisions |
| `specs/004-dynamic-model-creation/data-model.md` | Entity definitions |
| `specs/004-dynamic-model-creation/contracts/` | API contracts |
| `docs/plans/004-smart-model-generation.md` | Original research document |
| `docs/plans/004a-dynamic-field-resolution.md` | Deferred asyncModule research |
