# Quickstart: Synmetrix Development Environment

## Prerequisites

Install these before running setup:

- **Docker** (with Docker Compose v2) — [docker.com](https://docker.com)
- **Node.js** (v18+) — [nodejs.org](https://nodejs.org)
- **Yarn** (v1) — `npm install -g yarn`
- **Bun** — [bun.sh](https://bun.sh)

You also need access to a PostgreSQL database. Ask your team lead
for connection details.

## Directory Layout

Clone both repositories as siblings:

```
Development/
├── synmetrix/          # This repository (backend)
└── client-v2/          # Frontend repository
```

Optionally clone the cxs2 blueprint as a reference:

```
Development/
├── synmetrix/
├── client-v2/
└── cxs2/               # Read-only architectural reference
```

## First-Time Setup

```bash
cd synmetrix
./cli.sh dev setup
```

This single command will:
1. Check that Docker, Node.js, Yarn, and Bun are installed
2. Create `.env` and `.dev.env` from example templates (if missing)
3. Verify your PostgreSQL database is reachable
4. Create the Docker network
5. Clean up any stale containers
6. Start all backend services (Redis, Hasura, Actions, CubeJS, etc.)
7. Apply database migrations
8. Install client-v2 frontend dependencies
9. Start the client-v2 Vite dev server

After setup completes, open your browser to `http://localhost:8000`.

**If setup fails**, the error message tells you exactly what to fix.
Common issues:
- Missing prerequisite → install it and re-run
- Postgres unreachable → check VPN, verify `.dev.env` settings
- Port conflict → stop the conflicting process

## Daily Usage

```bash
# Start everything
./cli.sh dev start

# Check what's running
./cli.sh dev status

# View logs (all services)
./cli.sh dev logs

# View logs (specific service)
./cli.sh dev logs cubejs

# Stop everything
./cli.sh dev stop
```

## Existing Commands Still Work

All previous `cli.sh` commands continue to work as before:

```bash
./cli.sh compose up              # Start Docker services only
./cli.sh compose restart cubejs  # Restart a single service
./cli.sh compose logs actions    # View service logs
./cli.sh compose ps              # List containers
./cli.sh hasura cli "migrate status"  # Check migrations
./cli.sh tests stepci            # Run integration tests
```

## Editing Code

**Backend services** (Actions, CubeJS): Edit files under
`services/actions/src/` or `services/cubejs/src/`. Changes are
detected automatically via nodemon — the service restarts within
seconds.

**Frontend** (client-v2): Edit files under `../client-v2/src/`.
Vite HMR reflects changes in the browser within seconds.

## Working Across Both Codebases

When you change a Hasura action or migration:

1. Apply the migration:
   ```bash
   ./cli.sh hasura cli "migrate apply"
   ```
2. Regenerate frontend GraphQL types:
   ```bash
   cd ../client-v2 && yarn codegen
   ```
3. Verify end-to-end in the browser at `http://localhost:8000`

## Environment Configuration

- `.env` — Base configuration (shared across environments)
- `.dev.env` — Development overrides (Postgres, secrets)
- `.env.example` — Template for `.env` (checked into git)
- `.dev.env.example` — Template for `.dev.env` (checked into git)

**Never commit `.env` or `.dev.env`** — they contain secrets and
are gitignored.

## Ports Reference

| Port  | Service              |
|-------|----------------------|
| 3030  | CubeStore            |
| 4000  | CubeJS API           |
| 6379  | Redis                |
| 8000  | client-v2 (Vite dev) |
| 8025  | Mailhog (web UI)     |
| 8080  | Hasura GraphQL       |
| 8081  | Hasura+ (auth)       |
| 9000  | Minio (S3 API)       |
| 9001  | Minio (console)      |
| 9695  | Hasura CLI console   |
| 13306 | CubeJS MySQL API     |
| 15432 | CubeJS Postgres API  |
