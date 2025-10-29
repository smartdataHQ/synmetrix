# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Synmetrix (formerly MLCraft) is an open source data engineering platform and semantic layer built as a monorepo. The platform leverages Cube.js for flexible data modeling and provides a complete framework for modeling, integrating, transforming, aggregating, and distributing metrics data at scale.

## Architecture

The monorepo consists of several key services:

- **CLI (`cli/`)**: TypeScript-based CLI tool built with oclif for managing Docker Compose/Swarm operations and development workflows
- **Actions Service (`services/actions/`)**: Node.js microservice handling background tasks like reports, alerts, data processing, and integrations
- **CubeJS Service (`services/cubejs/`)**: Cube.js backend service for data modeling and analytics API
- **Client (`services/client/`)**: Frontend application (Docker-based with Nginx)
- **Hasura (`services/hasura/`)**: GraphQL API layer with database migrations and metadata

## Development Commands

### CLI Development
```bash
# Navigate to CLI directory
cd cli/

# Install dependencies
yarn install

# Build CLI
yarn build

# Run tests
yarn test
yarn tests  # Alternative test command

# Lint code
yarn lint

# Use the CLI through root script
./cli.sh <command>
```

### Service Development

**Actions Service:**
```bash
cd services/actions/
# No build scripts - uses Node.js directly
npm start
```

**CubeJS Service:**
```bash
cd services/cubejs/
# Development with nodemon
npm run start.dev
# Production
npm start
```

### Docker Operations

The project uses a custom CLI wrapper (`./cli.sh`) for all Docker operations:

```bash
# Docker Compose operations
./cli.sh compose up [service]     # Start services
./cli.sh compose stop [service]   # Stop services  
./cli.sh compose restart [service] # Restart services
./cli.sh compose logs [service]    # View logs
./cli.sh compose ps               # List containers
./cli.sh compose destroy [service] # Remove containers

# Docker Swarm operations
./cli.sh swarm up <stack>
./cli.sh swarm destroy <stack>
./cli.sh swarm logs <service>

# Execute commands in containers
./cli.sh docker ex <container> <command>

# Hasura CLI operations
./cli.sh hasura cli <command>

# Integration tests
./cli.sh tests stepci
```

### Environment Configurations

The project supports multiple environments through Docker Compose files:
- `docker-compose.dev.yml` (development)
- `docker-compose.stage.yml` (staging)
- `docker-compose.test.yml` (testing)
- `docker-compose.stack.yml` (production swarm)

Use the `-e` flag to specify environment: `./cli.sh compose up -e stage`

## Database Migrations

Hasura manages the database schema through migrations located in `services/hasura/migrations/`. Use the Hasura CLI wrapper:

```bash
./cli.sh hasura cli "migrate status"
./cli.sh hasura cli "migrate apply"
```

## Testing

- CLI tests: `cd cli && yarn test`
- Integration tests: `./cli.sh tests stepci`
- Test data available in `tests/data/`

## Release Process

**Current State:** The project uses manual Docker image building and deployment. The current focus is automating the building and releasing of this repository.

**Note:** The `.github/` directory contains CI/CD workflows from the upstream Synmetrix project, not our automation pipelines.

**Deployment:** Kubernetes deployment configurations are managed in `../cxs/data/synmetrix/` using Kustomize with:

- **Base configuration**: `base/kustomization.yaml` defines the core deployment
- **Staging overlay**: `overlays/staging/` - deploys to `synmetrix.contextsuite.dev`  
- **Production overlay**: `overlays/production/` - deploys to `dbx.contextsuite.com`
- **Image tags**: Currently managed manually in base kustomization:
  - `quicklookup/synmetrix-actions`: tag `7270f8d`
  - `quicklookup/synmetrix-cube`: tag `1b8790e`  
  - `quicklookup/synmetrix-client`: tag `latest`

**Services deployed**:
- Actions service (Node.js backend)
- CubeJS service (analytics API)
- CubeStore (storage engine) 
- Hasura (GraphQL API)
- Client (frontend)
- MinIO, Redis integration with existing cluster services

**Manual Release Steps:** See `RELEASING.md` for current manual process of building and pushing Docker images to registries and updating Kubernetes deployments.

## Key Dependencies

- **CLI**: oclif, TypeScript, zx (for shell operations)
- **Actions**: Express, AWS SDK, CubeJS client, various data processing libraries
- **CubeJS**: Cube.js backend with multiple database drivers
- **Infrastructure**: Docker, Docker Compose, Docker Swarm, Kubernetes

## Development Notes

- The CLI uses `./bin/run.js` as entry point but is wrapped by the root `./cli.sh` script
- Services are containerized and orchestrated via Docker Compose
- Database migrations are version-controlled through Hasura
- The platform supports multiple data sources (PostgreSQL, ClickHouse, BigQuery, etc.)
- Pre-aggregations and caching are handled by Cube Store for performance