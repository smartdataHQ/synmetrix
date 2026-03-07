# Feature Specification: Proper Development Environment

**Feature Branch**: `001-dev-environment`
**Created**: 2026-03-07
**Status**: Draft
**Input**: User description: "Proper Development Environment"

## Clarifications

### Session 2026-03-07

- Q: Should client-v2 run as a Docker service or native host process? → A: Native host process — `cli.sh` spawns `yarn dev` in `../client-v2` as a background process and manages its lifecycle alongside Docker.
- Q: How should setup handle missing `.env` / `.dev.env` files? → A: Create `.env.example` + `.dev.env.example` templates in the repo; setup copies them if missing but MUST NOT overwrite existing files. Current committed env files with secrets need cleanup (moved to examples + gitignored), with a graceful transition.
- Q: Should setup validate external Postgres connectivity? → A: Fail fast — setup MUST refuse to start backend services if Postgres is unreachable.
- Q: How should setup handle stale containers from previous failed runs? → A: Auto-cleanup — setup automatically removes stopped/exited containers for this project before starting, preserving volumes.
- Q: Should setup auto-install client-v2 dependencies? → A: Yes — setup runs `bun install` in `../client-v2` if `node_modules` is missing.

## Current Infrastructure

This feature builds on top of and extends the existing development
infrastructure. It does NOT replace any of the following:

- **`cli.sh`** — Thin shell wrapper that bootstraps `cli/bin/run.js`
  (oclif CLI). Already supports `compose up`, `compose stop`,
  `compose logs`, `compose restart`, `compose destroy`, `hasura cli`,
  `tests stepci`, and `docker ex` commands.
- **`docker-compose.dev.yml`** — Defines services: redis, actions,
  cubejs, cubejs_refresh_worker, hasura_cli, hasura, hasura_plus,
  minio, mailhog, client (Nginx pre-built frontend), cubestore.
  Actions and CubeJS already mount source volumes and run
  `yarn start.dev` for file-watching.
- **`.env` + `.dev.env`** — Environment layering already in place
  with JWT keys, service URLs, Minio, SMTP (mailhog), and database
  connection. These files currently contain committed secrets that
  need to be transitioned to `.env.example` / `.dev.env.example`
  templates with the actual files gitignored.
- **External PostgreSQL** — The dev database is hosted externally
  (configured in `.dev.env`), not as a Docker Compose service.
- **External Docker network** — `synmetrix_default` is declared as
  `external: true` and must exist before `compose up`.
- **`client` service** — Builds and serves a pre-built frontend
  bundle via Nginx on port 80. This is NOT the client-v2 dev server
  with hot-reload.

Any new capabilities MUST be implemented as extensions to `cli.sh`
and the existing Docker Compose setup. Existing commands and
workflows MUST continue to work unchanged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - First-Time Setup (Priority: P1)

A new developer clones the Synmetrix repository and wants to get a
fully working local environment running. Today this requires knowing
to create the Docker network manually, understanding which env files
to configure, and running multiple commands in sequence. The improved
setup provides a single `cli.sh` command that validates
prerequisites, creates the Docker network if missing, copies
environment template files if no local env files exist, verifies
Postgres connectivity, cleans up any stale containers, installs
client-v2 dependencies if needed, and starts all services. Within
minutes they have the full stack running locally — both the backend
services (via `docker-compose.dev.yml`) and the frontend dev server
(client-v2 spawned as a native host process). The environment treats
client-v2 as an integral part of the dev stack; both codebases are
actively developed from this repository and MUST be running together
for a complete development experience.

**Why this priority**: Without a reliable first-time setup, no other
development work is possible. This is the entry point for every
contributor.

**Independent Test**: Can be tested by cloning the repo on a clean
machine (or in a fresh VM/container) and running the setup command.
Success is measured by being able to log in to the application in the
browser.

**Acceptance Scenarios**:

1. **Given** a freshly cloned repository with no `.env` or `.dev.env`
   files (only `.env.example` and `.dev.env.example` in the repo),
   **When** the developer runs the setup command via `cli.sh`,
   **Then** `.env` and `.dev.env` are copied from their example
   templates, the developer is warned to review and fill in required
   secrets (e.g., Postgres connection string), the `synmetrix_default`
   network is created, Postgres connectivity is verified, stale
   containers are cleaned up, Docker Compose services start, Hasura
   migrations are applied, client-v2 dependencies are installed via
   `bun install`, the client-v2 dev server is spawned as a background
   process, and the application is accessible in the browser.

2. **Given** a machine missing a required prerequisite (e.g., Docker
   not installed, `yarn` not available),
   **When** the developer runs the setup command,
   **Then** the command exits early with a clear error message naming
   the missing prerequisite and how to install it.

3. **Given** the developer has previously run setup and already has
   running containers and existing `.env` / `.dev.env` files,
   **When** they run the setup command again,
   **Then** existing environment files are preserved (not
   overwritten), existing services are preserved (not recreated
   unnecessarily), and the environment comes up in its current state.

4. **Given** the `synmetrix_default` Docker network does not exist,
   **When** the developer runs any `cli.sh dev` command,
   **Then** the network is created automatically rather than failing
   with a cryptic Docker error.

5. **Given** the external Postgres database is unreachable (wrong
   host, VPN not connected, etc.),
   **When** the developer runs the setup command,
   **Then** setup reports the connectivity failure with an actionable
   message and refuses to start backend services.

6. **Given** stopped or exited containers exist from a previous
   failed setup attempt,
   **When** the developer runs the setup command,
   **Then** stale containers are automatically removed (volumes
   preserved) before starting fresh.

---

### User Story 2 - Daily Development Workflow (Priority: P2)

A returning developer starts their day and needs to bring up the
environment, make changes across backend services and/or the
frontend, see their changes reflected quickly, and inspect logs when
something goes wrong. The existing `cli.sh compose` commands already
handle starting, stopping, restarting, and viewing logs for Docker
services. This story extends the workflow to include the client-v2
dev server (running as a native host process managed by `cli.sh`)
as a first-class participant and adds a health-check summary so the
developer knows when everything is ready.

**Why this priority**: Once setup works, the daily workflow determines
developer productivity. Slow feedback loops and opaque errors are the
biggest productivity killers.

**Independent Test**: Can be tested by starting the environment,
modifying a file in any service, and verifying the change is reflected
without a full rebuild. Also tested by tailing logs for a specific
service.

**Acceptance Scenarios**:

1. **Given** a running development environment,
   **When** the developer edits a file in the Actions or CubeJS
   service source directory,
   **Then** the existing `yarn start.dev` (nodemon) file-watching
   detects the change and restarts the service automatically.

2. **Given** a running development environment with client-v2 started,
   **When** the developer edits a frontend component in
   `../client-v2`,
   **Then** the Vite dev server reflects the change via hot module
   replacement without a full page reload.

3. **Given** a running development environment with multiple services,
   **When** the developer runs `./cli.sh compose restart cubejs`,
   **Then** only the CubeJS service restarts and other services
   remain running and unaffected (existing behavior, preserved).

4. **Given** all services have been started,
   **When** the developer runs a health-check command,
   **Then** they see a summary table showing each service's status
   (Docker containers + client-v2 host process), port, and whether
   it is responding to requests.

---

### User Story 3 - Dual-Codebase Development (Priority: P3)

A developer works on changes that span both codebases simultaneously
— for example, adding a new Hasura action on the backend and
consuming it in client-v2 with updated GraphQL queries and codegen.
The environment makes this seamless: the backend runs via Docker
Compose (existing), the client-v2 dev server runs alongside it as a
native host process with proxy configuration pointing to the local
backend services, and shared contract changes (actions, migrations,
JWT claims) can be validated end-to-end without leaving the local
environment. The cxs2 blueprint project is available as a reference
for architectural patterns being adopted.

**Why this priority**: This is the normal development workflow, not
an edge case. Both codebases are developed from this repository and
most meaningful changes touch both sides. The environment must treat
dual-codebase development as the default mode of operation.

**Independent Test**: Can be tested by starting the full environment,
making a change to a Hasura action definition, updating the
corresponding frontend GraphQL query, running codegen, and verifying
the change works end-to-end in the browser.

**Acceptance Scenarios**:

1. **Given** the developer has both synmetrix and client-v2 cloned as
   sibling directories,
   **When** they start the development environment,
   **Then** the client-v2 Vite dev server proxies API requests to
   the local Docker services (Hasura on 8080, Hasura+ on 8081,
   CubeJS on 4000) and the application works end-to-end.

2. **Given** the developer modifies a Hasura action or migration,
   **When** they run `./cli.sh hasura cli "migrate apply"` or the
   equivalent reload command,
   **Then** the changes are applied to the running Hasura instance
   and the developer can regenerate frontend types via `yarn codegen`
   in client-v2.

3. **Given** the developer wants to reference a pattern from cxs2,
   **When** they look for the cxs2 sibling directory,
   **Then** the project documentation clearly indicates the expected
   location (`../cxs2`) and its role as a read-only architectural
   blueprint.

---

### Edge Cases

- What happens when the Docker daemon is not running when the
  developer attempts setup? → Setup detects this during prerequisite
  validation and exits with an actionable error.
- What happens when ports required by services (3030, 4000, 6379,
  8000, 8025, 8080, 8081, 9000, 9001) are already in use? → Setup
  detects port conflicts before starting and reports the conflicting
  process.
- Stale containers from a previous failed setup → Setup auto-removes
  stopped/exited containers for this project before starting;
  persistent volumes are preserved.
- Unreachable external Postgres → Setup fails fast with an
  actionable error; backend services are not started.
- `../client-v2` does not exist → Setup exits with an error
  explaining that client-v2 is required and where to clone it.
- `../client-v2` exists but has no `node_modules` → Setup
  automatically runs `bun install` before starting the dev server.
- Environment variable templates updated in repo but developer has
  existing local overrides → Existing `.env` / `.dev.env` files are
  never overwritten; the developer is responsible for merging new
  variables from the example templates.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The environment MUST extend the existing `cli.sh` CLI
  with a setup/init command that orchestrates first-time environment
  bootstrapping: prerequisite checks, env file creation from
  templates, Postgres connectivity validation, Docker network
  creation, service startup, migration application, client-v2
  dependency installation, and client-v2 dev server startup.
- **FR-002**: Prerequisite validation MUST check for: Docker, Docker
  Compose, Node.js, Yarn, and Bun (for client-v2) before attempting
  to start services.
- **FR-003**: The `synmetrix_default` Docker network MUST be created
  automatically if it does not exist, rather than requiring manual
  creation.
- **FR-004**: `.env.example` and `.dev.env.example` template files
  MUST be created in the repository with safe defaults (no real
  secrets). The setup command MUST copy these to `.env` / `.dev.env`
  if the target files do not exist, and MUST NOT overwrite existing
  env files. The actual `.env` and `.dev.env` files MUST be added to
  `.gitignore`. This transition MUST respect the current state of
  committed env files — existing developers with local copies are
  unaffected.
- **FR-005**: The setup process MUST validate that the external
  Postgres database (configured in `.dev.env`) is reachable before
  starting backend services. If unreachable, setup MUST fail with an
  actionable error message and MUST NOT start Hasura, Actions, or
  CubeJS.
- **FR-006**: The setup process MUST apply Hasura database migrations
  via the existing `hasura_cli` service (or `./cli.sh hasura cli
  "migrate apply"`) on first run.
- **FR-007**: All existing Docker Compose services MUST start and
  become responsive. The environment MUST NOT require any changes to
  `docker-compose.dev.yml` that would break existing workflows.
- **FR-008**: Existing `cli.sh` commands (`compose up`, `compose
  stop`, `compose restart`, `compose logs`, `compose destroy`,
  `compose ps`, `docker ex`, `hasura cli`, `tests stepci`) MUST
  continue to work unchanged.
- **FR-009**: The client-v2 Vite dev server MUST be started as a
  native host process (not a Docker container) managed by `cli.sh`.
  The setup command spawns `yarn dev` in `../client-v2` as a
  background process on port 8000 with proxy configuration pointing
  to the local Docker services. `cli.sh` MUST manage the client-v2
  process lifecycle (start, stop, status).
- **FR-010**: If `../client-v2/node_modules` is missing, the setup
  command MUST automatically run `bun install` in `../client-v2`
  before starting the dev server.
- **FR-011**: The setup command MUST automatically remove stopped or
  exited containers for this project before starting services.
  Persistent volumes MUST be preserved.
- **FR-012**: The environment MUST provide a health-check summary
  command showing the status of each service (Docker containers +
  client-v2 host process), its port, and whether it is responding.
- **FR-013**: Port conflicts MUST be detected before starting
  services, with clear error messages identifying the conflicting
  process.
- **FR-014**: The environment MUST expect client-v2 as a sibling
  directory (`../client-v2`) and validate its presence on startup.
  The cxs2 blueprint (`../cxs2`) MUST be documented as the expected
  reference location but is not required to be present for the
  environment to function.
- **FR-015**: The existing Nginx `client` service (pre-built
  frontend on port 80) MUST NOT start by default in dev mode. The
  client-v2 Vite dev server (port 8000) replaces it as the active
  frontend during development. The Nginx service MUST remain defined
  in `docker-compose.dev.yml` and available for explicit startup
  when needed (e.g., for testing production-like behavior).

### Key Entities

- **Service**: A containerized component of the platform (name,
  port, health status, restart policy, volume mounts) — already
  defined in `docker-compose.dev.yml`
- **Host Process**: A non-containerized process managed by `cli.sh`
  (client-v2 Vite dev server), tracked by PID for lifecycle
  management
- **Environment Configuration**: `.env.example` / `.dev.env.example`
  templates checked into the repo; `.env` / `.dev.env` local copies
  (gitignored) specific to a deployment target (dev/stage/test)
- **Prerequisite**: A system dependency required before setup can
  proceed (name, version constraint, validation command, install
  instructions)

### Post-Merge Follow-Up: Secret Rotation

The current `.env` and `.dev.env` files contain real secrets
(`JWT_KEY`, `POSTGRES_PASSWORD`, `HASURA_GRAPHQL_ADMIN_SECRET`) that
are already committed to git history. While this feature stops
tracking these files going forward (`git rm --cached`), the secrets
remain in the repository history. After merging this feature:

1. Rotate all exposed secrets (JWT key, Postgres password, Hasura
   admin secret)
2. Distribute new credentials to existing developers via a secure
   channel
3. Consider `git filter-branch` or BFG Repo-Cleaner to remove
   secrets from history (optional, depends on threat model)

This is an operational task outside the scope of this CLI tooling
feature.

## Assumptions

- Docker and Docker Compose are the only supported container
  runtimes for local development (existing convention).
- `cli.sh` and the oclif CLI (`cli/`) are the primary interface for
  environment management (existing convention).
- The client-v2 frontend uses `bun install` and `yarn dev` as its
  dev workflow (per CLAUDE.md).
- PostgreSQL remains an external service (not managed by Docker
  Compose). The `.dev.env` file provides the connection string.
- The cxs2 blueprint project is read-only reference material; the
  dev environment does not need to run cxs2 services.
- Developers use macOS or Linux. Windows support via WSL2 is
  acceptable but not a primary target.
- The existing `docker-compose.dev.yml` service definitions, volume
  mounts, port mappings, and env_file references are correct and
  working. This feature does not modify them.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new developer can go from a fresh clone to a working
  local environment (all services healthy, application accessible in
  browser) in under 10 minutes on a machine with prerequisites
  installed.
- **SC-002**: After initial setup, bringing up the full environment
  on subsequent runs takes under 60 seconds.
- **SC-003**: Code changes in Actions and CubeJS services are
  reflected in the running environment within 10 seconds via the
  existing nodemon file-watching (preserved, not reimplemented).
- **SC-004**: Frontend hot module replacement in client-v2 reflects
  component changes in the browser within 3 seconds.
- **SC-005**: 100% of setup failures produce an actionable error
  message that tells the developer exactly what to fix.
- **SC-006**: All existing `cli.sh` commands continue to work
  identically before and after this feature is implemented.
