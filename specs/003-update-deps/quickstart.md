# Quickstart: Update All Dependencies

**Feature**: 003-update-deps | **Date**: 2026-03-07

## Prerequisites

- Docker Desktop with Tailscale/host networking enabled
- Git on branch `003-update-deps`
- Access to `../client-v2` sibling repository

## Development Setup

### 1. Backend (Synmetrix services)

```bash
# From repo root
git checkout 003-update-deps

# Rebuild CubeJS container (picks up new Dockerfile + dependencies)
./cli.sh compose stop cubejs cubejs_refresh_worker cubestore
docker compose -f docker-compose.dev.yml build cubejs
./cli.sh compose up
```

**Note**: CubeStore will auto-upgrade its partition format on first start with the new version. This is a one-way upgrade — the `.cubestore` volume cannot be used with older CubeStore versions after this.

### 2. Frontend (client-v2)

```bash
cd ../client-v2
yarn install    # Install any new dependencies
yarn dev        # Start dev server on port 8000
```

### 3. Verify the upgrade

```bash
# Check CubeJS is running with new version
curl -s http://localhost:4000/readyz

# Test SQL API over HTTP (requires valid JWT)
curl -X POST http://localhost:4000/api/v1/cubesql \
  -H "Authorization: Bearer <your-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT 1"}'

# Check frontend datasource tiles
open http://localhost:8000
# Navigate to datasource creation → verify new database tiles appear
```

## Key Files to Modify

| File | What to Change |
|------|----------------|
| `services/cubejs/package.json` | Bump all `@cubejs-backend/*` to v1.6.19, add oracle/sqlite/pinot drivers |
| `services/cubejs/Dockerfile` | Change `node:20.19.2-bullseye` → `node:22.14.0-bullseye` |
| `services/cubejs/src/utils/prepareDbParams.js` | Add param normalization for oracle, sqlite, pinot, duckdb, databricks-jdbc OAuth |
| `.env` | Update `CUBESTORE_VERSION=v1.6.19`, add `CUBEJS_DEFAULT_TIMEZONE=UTC`, `CUBEJS_TRANSPILATION_WORKER_THREADS=true` |
| `docker-compose.dev.yml` | Add `platform: linux/amd64` to cubestore (no ARM64 images for v1.6.x) |
| `../client-v2/src/mocks/dataSources.tsx` | Add 4 new dbTiles (DuckDB, Oracle, SQLite, Pinot), OAuth forms for Snowflake/Databricks, Elasticsearch deprecated |
| `../client-v2/src/assets/databases/` | Add 4 new SVG database icons (oracle, sqlite, duckdb, pinot) |
| `../client-v2/src/types/dataSource.ts` | Add `deprecated`, `options`, `dependsOn` to types |
| `../client-v2/src/components/FormTile/index.tsx` | Add deprecated badge rendering |
| `../client-v2/src/components/DataSourceSetup/index.tsx` | Add `watch()` for conditional fields, forward `options` |
| `services/actions/src/utils/cubejsApi.js` | Fix generate-models timeout route, add `cache` to queryBaseMembers |
| `services/cubejs/src/swagger.yaml` | Fix route drift, add `/api/v1/cubesql` docs |
| `services/hasura/migrations/1709836800002_extend_hide_password_oauth/` | Mask OAuth secrets in db_params_computed |

## Testing Checklist

- [ ] All Docker services start and pass health checks
- [ ] Existing datasource connections work without reconfiguration
- [ ] Pre-aggregation refresh completes successfully
- [ ] New database tiles visible in frontend datasource creation
- [ ] SQL API over HTTP endpoint responds to queries
- [ ] Elasticsearch tile shows deprecation warning
- [ ] `yarn codegen` succeeds in client-v2 (if GraphQL schema changed)
- [ ] `yarn lint` passes in client-v2
- [ ] StepCI tests pass: `./cli.sh tests stepci`

## Troubleshooting

**CubeJS won't start after upgrade**: Check for Node.js version mismatch. Run `docker exec synmetrix-cubejs-1 node --version` — should be v22.x.

**Pre-aggregations not working**: CubeStore partition format may need a full rebuild. Clear `.cubestore` volume and restart: `rm -rf .cubestore && ./cli.sh compose up`.

**Data model compilation errors**: v1.6 has stricter join path validation. Check CubeJS logs for specific errors about ambiguous paths, then fix the referenced data model files.

**Access control changes**: v1.6 strict policy matching may cause queries to return empty results if member roles don't cover all queried members. Check `defineUserScope.js` logs and audit `member_roles.access_list` in the database.
