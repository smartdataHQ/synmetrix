# CLI Command Contracts: Dev Topic

All commands inherit BaseCommand flags: `-e/--env` (default: "dev"),
`-n/--networkName` (default: "synmetrix_default"), `--shell`.

## BaseCommand Bootstrap Override

`BaseCommand.init()` hard-fails if `.env` or `.{env}.env` files are
missing (throws `Error("Env file ... is not exists")`). This is
correct for all existing commands but incompatible with `dev setup`,
which must create those files before loading them.

**Pattern**: `dev setup` overrides `init()` to perform env file
creation before calling `super.init()`. This keeps BaseCommand
unchanged while giving setup a custom bootstrap path:

```typescript
protected async init(): Promise<void> {
  // Parse flags manually (cannot call super.init yet)
  const { flags } = await this.parse(DevSetup);
  // Steps 1-2: prerequisites + env file creation
  await ensureEnvFiles(PROJECT_DIR);
  // Now safe to load env files
  await super.init();
}
```

`dev stop` and `dev status` also override `init()` to skip env
validation entirely — these commands only need to read a PID file
and query Docker, so they should work even when env files are
missing or misconfigured. They extend `Command` directly or override
`init()` with a no-op env load.

## `dev setup`

**Purpose**: First-time environment bootstrapping + idempotent
re-run.

**Invocation**: `./cli.sh dev setup [-e env]`

**Execution sequence**:
1. Validate prerequisites (Docker, Docker Compose, Node.js, Yarn,
   Bun)
2. Check env files exist; copy from `.env.example` /
   `.dev.env.example` if missing (never overwrite)
3. Load environment (via overridden `init()` that calls
   `super.init()` after step 2)
4. Validate Postgres connectivity (TCP probe to POSTGRES_HOST)
   - FAIL FAST if unreachable
5. Create Docker network if missing (`docker network create
   --attachable {networkName}`)
6. Clean up stale containers (remove only stopped/exited containers
   for this project; preserve running containers and volumes)
7. Check port availability (4000, 8000, 8080, 8081, 3030, 6379,
   8025, 9000, 9001, 9695)
8. Start Docker Compose services (excluding `client`)
9. Wait for Hasura to be healthy (poll `GET
   http://localhost:8080/healthz` every 2s, up to 60s timeout;
   Hasura has no compose healthcheck so Docker "running" state is
   insufficient)
10. Apply Hasura migrations (`hasura cli "migrate apply"`)
11. Validate `../client-v2` exists
12. Install client-v2 dependencies if `node_modules` missing
    (`bun install` in `../client-v2`)
13. Start client-v2 Vite dev server (spawn background process,
    write PID file)
14. Run health check and display summary

**Exit codes**:
- 0: Setup complete, all services healthy
- 1: Prerequisite missing (message names which + install guidance)
- 2: Postgres unreachable (message with connection details, no
  password)
- 3: Port conflict (message identifies port + suggests lsof)
- 4: client-v2 directory not found
- 5: Hasura migration failure

**Idempotency**: Safe to run multiple times. Skips steps that are
already satisfied (env files exist, network exists, containers
running, node_modules present, client-v2 already running).

---

## `dev start`

**Purpose**: Start the development environment (assumes setup has
been run at least once).

**Invocation**: `./cli.sh dev start [-e env]`

**Execution sequence**:
1. Load environment
2. Validate Postgres connectivity
3. Check port availability
4. Create Docker network if missing
5. Start Docker Compose services (excluding `client`)
6. Validate `../client-v2` exists
7. Start client-v2 if not already running (check PID file)
8. Display health check summary

**Exit codes**:
- 0: All services started
- 2: Postgres unreachable
- 3: Port conflict
- 4: client-v2 directory not found

**Difference from setup**: No prerequisite checks, no env file
copying, no dependency installation, no migration application.
Faster for daily use.

---

## `dev stop`

**Purpose**: Stop all development services.

**Invocation**: `./cli.sh dev stop`

**Env files**: Not required. This command overrides `init()` to
skip env validation — it only needs the PID file and Docker.

**Execution sequence**:
1. Stop client-v2 (read PID file, SIGTERM, remove PID file)
2. Stop Docker Compose services (`docker compose stop`)

**Exit codes**:
- 0: All services stopped

---

## `dev status`

**Purpose**: Display health-check summary of all services.

**Invocation**: `./cli.sh dev status`

**Env files**: Not required. This command overrides `init()` to
skip env validation — it only queries Docker and checks the PID
file.

**Output format** (table):
```
Service          Type     Port   Status     Uptime
─────────────────────────────────────────────────────
redis            docker   6379   running    2h 15m
actions          docker   3000   running    2h 15m
cubejs           docker   4000   running    2h 15m
cubejs_refresh   docker   -      running    2h 15m
hasura           docker   8080   running    2h 15m
hasura_cli       docker   9695   running    2h 15m
hasura_plus      docker   8081   running    2h 15m
minio            docker   9000   running    2h 15m
mailhog          docker   8025   running    2h 15m
cubestore        docker   3030   running    2h 15m
client-v2        host     8000   running    1h 30m
```

**Exit codes**:
- 0: Status displayed (regardless of service health)

---

## `dev logs`

**Purpose**: View logs from Docker services and/or client-v2.

**Invocation**: `./cli.sh dev logs [SERVICE] [--tail N]`

**Arguments**:
- `SERVICE` (optional): Specific service name. If "client-v2",
  tails the client-v2 process stdout. Otherwise passed to
  `docker compose logs`.
- `--tail` (default: 500): Number of lines

**Behavior**:
- No SERVICE arg: runs `docker compose logs --tail N -f` (Docker
  services only — client-v2 logs are separate)
- SERVICE = "client-v2": runs `tail -f -n N .dev-client-v2.log`
  (log file is written by `startClientV2()` which redirects
  stdout/stderr to `.dev-client-v2.log` in append mode). If log
  file doesn't exist, reports that client-v2 is not running.
- SERVICE = any Docker service: delegates to `docker compose logs
  {service} --tail N -f`

**Exit codes**:
- 0: Logs displayed
