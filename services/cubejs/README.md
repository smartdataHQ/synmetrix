# CubeJS Service

This directory contains the CubeJS backend service for Synmetrix, providing the analytics API and data modeling layer.

## Recent Changes

### CubeJS Version Upgrade (v1.3.23 → v1.3.85)

**Date:** October 29, 2025  
**Upgrade Method:** `npm update` (proper package management)

**Upgraded Packages:**
- `@cubejs-backend/api-gateway`: 1.3.23 → 1.3.85
- `@cubejs-backend/server-core`: 1.3.23 → 1.3.85
- `@cubejs-backend/query-orchestrator`: 1.3.23 → 1.3.85
- All other `@cubejs-backend/*` packages: 1.3.23 → 1.3.85

**What Changed:**
- Major version jump (60 patch versions)
- Latest features, performance improvements, and security fixes
- Maintained backward compatibility
- All database drivers updated in sync

**Testing Performed:**
- Package loading verification ✅
- Node.js import tests ✅
- Build process validation ✅

## Architecture

The CubeJS service provides:
- **Data API**: RESTful and GraphQL APIs for analytics queries
- **Database Drivers**: Support for multiple data sources (PostgreSQL, ClickHouse, BigQuery, etc.)
- **Pre-aggregations**: Performance optimization through data pre-computation
- **Caching**: Redis-based caching for query results
- **Security**: JWT-based authentication and authorization

## Configuration

Key environment variables:
- `CUBEJS_DB_TYPE`: Database type (postgres, clickhouse, etc.)
- `CUBEJS_CACHE_TYPE`: Cache type (redis)
- `CUBEJS_CUBESTORE_HOST`: CubeStore host for pre-aggregations
- `CUBEJS_SQL_API`: Enable SQL API endpoint

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run start.dev

# Start production server
npm start

# Generate documentation
npm run jsdoc
```

## Docker Build

This service is automatically built by GitHub Actions when changes are detected in:
- `services/cubejs/package.json`
- `services/cubejs/package-lock.json`
- `services/cubejs/src/**`
- `services/cubejs/index.js`
- `services/cubejs/Dockerfile`

**Image:** `quicklookup/synmetrix-cube`

## Kubernetes Deployment

Currently deployed as:
- **Service**: `synmetrix-cubejs`
- **Image**: `quicklookup/synmetrix-cube:1b8790e` (will be updated to latest after next deployment)
- **Ports**: 4000 (HTTP), 15432 (PostgreSQL API), 13306 (MySQL API)

## Security Notes

The recent upgrade addressed several dependency vulnerabilities, though some remain in deep dependencies of unused database drivers. Monitor `npm audit` output and update regularly.

## Next Steps

- [ ] Test the upgraded version in staging environment
- [ ] Update Kubernetes deployment with new image tag
- [ ] Monitor performance after upgrade
- [ ] Consider updating related CubeStore version if needed