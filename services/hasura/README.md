# Hasura Migrations

This directory contains the Hasura migrations, metadata, and seeds for Synmetrix, along with a Dockerfile for building a migration runner image.

## Directory Structure

```
services/hasura/
├── Dockerfile          # Migration runner image
├── config.yaml         # Hasura CLI configuration
├── metadata/           # Hasura metadata (permissions, relationships, actions)
├── migrations/         # SQL migrations
└── seeds/              # Seed data
```

## Docker Image

The Dockerfile builds a lightweight Alpine-based image containing:
- `hasura-cli` binary for running migrations
- All migrations, metadata, seeds, and config

### Build

```bash
# Build with default version (v2.48.0)
docker build -t synmetrix-hasura-migrations services/hasura/

# Build with specific Hasura version
docker build --build-arg HASURA_VERSION=v2.48.0 -t synmetrix-hasura-migrations services/hasura/
```

### Build Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `HASURA_VERSION` | `v2.48.0` | Hasura CLI version to install |

### CI/CD

This image is automatically built and pushed by GitHub Actions when changes are made to `services/hasura/**`:

- **Image**: `quicklookup/synmetrix-hasura-migrations`
- **Tags**: `latest`, `<commit-sha>`, `<branch>-<commit-sha>`

## Usage

### Apply Migrations

```bash
docker run --rm \
  -e HASURA_GRAPHQL_ENDPOINT=http://hasura:8080 \
  -e HASURA_GRAPHQL_ADMIN_SECRET=your-admin-secret \
  quicklookup/synmetrix-hasura-migrations \
  hasura-cli migrate apply --database-name default
```

### Apply Metadata

```bash
docker run --rm \
  -e HASURA_GRAPHQL_ENDPOINT=http://hasura:8080 \
  -e HASURA_GRAPHQL_ADMIN_SECRET=your-admin-secret \
  quicklookup/synmetrix-hasura-migrations \
  hasura-cli metadata apply
```

### Apply Seeds

```bash
docker run --rm \
  -e HASURA_GRAPHQL_ENDPOINT=http://hasura:8080 \
  -e HASURA_GRAPHQL_ADMIN_SECRET=your-admin-secret \
  quicklookup/synmetrix-hasura-migrations \
  hasura-cli seed apply --database-name default
```

### Full Migration (Migrations + Metadata)

```bash
docker run --rm \
  -e HASURA_GRAPHQL_ENDPOINT=http://hasura:8080 \
  -e HASURA_GRAPHQL_ADMIN_SECRET=your-admin-secret \
  quicklookup/synmetrix-hasura-migrations \
  sh -c "hasura-cli migrate apply --database-name default && hasura-cli metadata apply"
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HASURA_GRAPHQL_ENDPOINT` | Yes | Hasura GraphQL endpoint URL (overrides `config.yaml`) |
| `HASURA_GRAPHQL_ADMIN_SECRET` | Yes | Hasura admin secret for authentication |

## Configuration

The `config.yaml` file configures the Hasura CLI behavior:

```yaml
version: 2
endpoint: http://localhost:8080
metadata_directory: metadata
seeds_directory: seeds
actions:
  kind: synchronous
  handler_webhook_baseurl: http://localhost:3000
```

### Config Options

| Option | Value | Description |
|--------|-------|-------------|
| `version` | `2` | Hasura CLI config version |
| `endpoint` | `http://localhost:8080` | Default Hasura endpoint (override with `HASURA_GRAPHQL_ENDPOINT` env var) |
| `metadata_directory` | `metadata` | Directory containing Hasura metadata files |
| `seeds_directory` | `seeds` | Directory containing seed SQL files |
| `actions.kind` | `synchronous` | Actions execution mode |
| `actions.handler_webhook_baseurl` | `http://localhost:3000` | Base URL for action handlers (points to Actions service) |

### Overriding Configuration

The endpoint in `config.yaml` is for local development. In production, override it using the environment variable:

```bash
docker run --rm \
  -e HASURA_GRAPHQL_ENDPOINT=https://hasura.production.example.com \
  -e HASURA_GRAPHQL_ADMIN_SECRET=your-secret \
  quicklookup/synmetrix-hasura-migrations \
  hasura-cli migrate apply --database-name default
```

Or use the `--endpoint` flag:

```bash
hasura-cli migrate apply --endpoint https://hasura.production.example.com --database-name default
```

## Prerequisites

Before applying metadata, ensure the database source named `default` is configured in Hasura. The metadata references tables in the `auth` and `public` schemas which must exist.

### Database Source Configuration

The "source default does not exist" error occurs when Hasura doesn't have a database connection configured. Configure it using one of these methods:

**Option 1: Environment Variables (Recommended for Production)**

Set these on the `hasura/graphql-engine` container:

```bash
HASURA_GRAPHQL_DATABASE_URL=postgres://user:password@host:5432/database
```

This automatically creates a source named `default`.

**Option 2: Hasura API**

Add the database source via the Hasura metadata API:

```bash
curl -X POST http://hasura:8080/v1/metadata \
  -H "X-Hasura-Admin-Secret: your-admin-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "pg_add_source",
    "args": {
      "name": "default",
      "configuration": {
        "connection_info": {
          "database_url": "postgres://user:password@host:5432/database"
        }
      }
    }
  }'
```

**Option 3: Hasura Console**

1. Open Hasura Console at `http://localhost:8080/console`
2. Go to Data → Manage → Connect Database
3. Add a PostgreSQL database with name `default`

### Migration Order

Once the database source is configured:

1. Apply migrations first (creates tables): `hasura-cli migrate apply --database-name default`
2. Apply metadata second (configures relationships, permissions): `hasura-cli metadata apply`
3. Apply seeds optionally: `hasura-cli seed apply --database-name default`

## Development

For local development, use the `hasura_cli` service in `docker-compose.dev.yml` which provides an interactive console:

```bash
./cli.sh compose up hasura_cli
```

This mounts the migrations and metadata directories for live editing.

## Related Images

| Image | Purpose |
|-------|---------|
| `quicklookup/synmetrix-hasura-migrations` | Migration runner (this image) |
| `quicklookup/synmetrix-hasura` | Development console with CLI |
| `hasura/graphql-engine` | Hasura GraphQL engine server |
