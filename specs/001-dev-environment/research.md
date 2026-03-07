# Research: Proper Development Environment

## R1: CLI Command Structure for New Topic

**Decision**: Add a `dev` topic with 5 commands (`setup`, `start`,
`stop`, `status`, `logs`) following existing oclif patterns.

**Rationale**: The existing CLI uses oclif with topic-based command
organization (`compose`, `swarm`, `docker`, `hasura`, `tests`). A
`dev` topic is the natural extension. All commands extend
`BaseCommand` to inherit env loading, network name, and shell flags.

**Alternatives considered**:
- Adding flags to `compose:up` (rejected: overloads existing command,
  mixes concerns — Docker management vs. full dev orchestration)
- A standalone script outside the CLI (rejected: loses env layering,
  inconsistent UX, duplicates BaseCommand capabilities)

## R2: Client-v2 Process Management

**Decision**: Use PID file (`.dev-client-v2.pid`) and `zx` process
spawning to manage client-v2 as a native host process.

**Rationale**: Vite HMR works best with direct filesystem access.
The client-v2 Vite config already has proxy rules pointing to
`localhost:8080` (Hasura), `localhost:8081` (Hasura+), and
`localhost:4000` (CubeJS) — matching the Docker Compose port
mappings. No proxy configuration changes needed.

**Implementation details**:
- Spawn `yarn dev` in `../client-v2` as a detached child process
- Redirect stdout/stderr to `.dev-client-v2.log` (append mode) so
  `dev logs client-v2` can tail the output
- Write PID to `.dev-client-v2.pid` in the synmetrix repo root
- On stop: read PID, send SIGTERM, remove PID file (log file
  preserved for debugging)
- On status: check if PID is alive + HTTP probe on port 8000
- On start: check for existing PID file, skip if already running

**Alternatives considered**:
- Docker Compose service with volume mount (rejected: Vite HMR
  unreliable through Docker volumes on macOS, adds complexity,
  client-v2 is not a production container)
- tmux/screen session (rejected: adds dependency, harder to
  programmatically manage lifecycle)

## R3: Environment File Template Strategy

**Decision**: Create `.env.example` and `.dev.env.example` from
current `.env` and `.dev.env`, replacing real secrets with
placeholder values. Add `.env` and `.dev.env` to `.gitignore`.

**Rationale**: The current repo commits `.env` and `.dev.env` with
real JWT keys, database credentials, and Minio passwords. This
violates Constitution Principle IV (Security by Default). The
transition must be graceful: existing developers with local copies
are unaffected; new developers get templates to fill in.

**Transition plan**:
1. Create `.env.example` from current `.env`, replacing:
   - `JWT_KEY=LGB6...` → `JWT_KEY=<generate-a-random-32-char-key>`
   - Keep all non-secret values as-is (ports, hostnames, flags)
2. Create `.dev.env.example` from current `.dev.env`, replacing:
   - `HASURA_GRAPHQL_ADMIN_SECRET=devsecret` → placeholder
   - `POSTGRES_HOST=100.79.113.70` → `POSTGRES_HOST=<your-db-host>`
   - `POSTGRES_PASSWORD=...` → `POSTGRES_PASSWORD=<your-db-password>`
   - `POSTGRES_ADDR=...` → reconstructed from variables
   - Keep Minio defaults (local dev only, not sensitive)
   - Keep mailhog defaults (local dev only, not sensitive)
3. Add to `.gitignore`: `.env`, `.dev.env`, `.dev-client-v2.pid`
4. Setup command: if `.env` missing, copy from `.env.example` and
   warn developer to fill in secrets

**Alternatives considered**:
- Interactive prompts for each secret (rejected: too many variables,
  slow, developers prefer editing a file)
- Encrypted env files (rejected: adds complexity, YAGNI for dev
  environment)

## R4: Postgres Connectivity Validation

**Decision**: Use `pg_isready` or a TCP socket probe to test Postgres
connectivity during setup, fail fast if unreachable.

**Rationale**: Postgres is external (not in Docker Compose). A bad
connection string is the most common first-time setup failure. Since
Hasura, Actions, and CubeJS all depend on Postgres, starting them
against an unreachable DB wastes time and produces confusing errors.

**Implementation details**:
- Parse `POSTGRES_HOST` and `POSTGRES_ADDR` from loaded env
- Attempt TCP connection to host:port with 5-second timeout
- If unreachable: print actionable error (check VPN, verify host,
  verify `.dev.env` settings) and exit
- Do NOT log credentials in the error message

**Alternatives considered**:
- `pg_isready` command (rejected: requires PostgreSQL client tools
  installed on host — adds prerequisite)
- Node.js `net.connect` via zx inline script (selected: zero
  additional dependencies, works cross-platform)

## R5: Stale Container Cleanup

**Decision**: Remove only stopped/exited containers for this project
before starting, preserving running containers and volumes.

**Rationale**: After a failed setup, orphaned containers block port
bindings and cause confusing "port already in use" errors. Cleaning
stopped/exited containers is safe — it doesn't affect running
services or persistent data volumes. `docker compose down` is NOT
suitable here because it tears down ALL containers including healthy
running ones, which violates the idempotency requirement (US1
scenario 3).

**Implementation details**:
- Before `compose up`, query stopped/exited containers:
  `docker compose -f {file} ps -a --status=exited --status=created
  --format '{{.Name}}'`
- Remove only those containers:
  `docker rm -f {container_names}` with `.nothrow()`
- Also remove orphans not defined in the compose file:
  `docker compose -f {file} rm --stop --force` with filter for
  non-running containers only
- Named volumes (`pgstorage-data`, `minio-data`) are preserved
  (no `--volumes` flag)
- Only runs during `dev:setup`, not during `dev:start` (start
  assumes containers are in a known state)

**Alternatives considered**:
- `docker compose down --remove-orphans` (rejected: destroys ALL
  containers including healthy running ones, violates idempotency)
- Manual cleanup instruction (rejected: bad UX, violates SC-005)

## R6: Port Conflict Detection

**Decision**: Check key ports before starting services using
`lsof -i :{port}` or Node.js `net.createServer` probe.

**Rationale**: Multiple services bind to specific ports (4000, 8000,
8080, 8081, 3030, 6379, 9000). If another process holds a port,
Docker and Vite produce unhelpful error messages.

**Implementation details**:
- Check ports: 4000 (CubeJS), 8000 (client-v2), 8080 (Hasura),
  8081 (Hasura+), 3030 (CubeStore), 6379 (Redis)
- Use Node.js `net.createServer().listen(port)` — if it fails, port
  is in use
- On conflict: report which port and suggest `lsof -i :{port}` for
  the developer to identify the process
- Run during `dev:setup` and `dev:start`

**Alternatives considered**:
- `lsof` parsing (rejected: macOS/Linux output differs, fragile)
- Skip check, let Docker fail (rejected: violates SC-005)

## R7: Excluding Nginx Client Service

**Decision**: Use `docker compose up` with explicit service names,
excluding `client`, rather than modifying the compose file.

**Rationale**: FR-015 requires the Nginx `client` service to not
start by default in dev mode, but FR-007 requires no changes to
`docker-compose.dev.yml`. The solution is to enumerate services
explicitly in the `dev:start` command.

**Implementation details**:
- `dev:start` runs: `docker compose -f docker-compose.dev.yml up -d
  redis actions cubejs cubejs_refresh_worker hasura hasura_cli
  hasura_plus minio mailhog cubestore`
- Explicitly omits `client` from the list
- Developer can still run `./cli.sh compose up client` manually
  if needed

**Alternatives considered**:
- Docker Compose profiles (rejected: requires modifying
  `docker-compose.dev.yml`, violates FR-007)
- Override compose file `docker-compose.dev-override.yml` (rejected:
  more complexity than explicit service list, YAGNI)
