---
description: "Task list for Proper Development Environment feature"
---

# Tasks: Proper Development Environment

**Input**: Design documents from `/specs/001-dev-environment/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Included per Constitution Principle III (TDD). Tests are written first, verified to fail, then implementation follows.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- CLI source: `cli/src/`
- CLI tests: `cli/test/commands/dev/`
- New commands: `cli/src/commands/dev/`
- Shared utilities: `cli/src/devUtils.ts`
- Root config: `.env.example`, `.dev.env.example`, `.gitignore`

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create environment templates, update gitignore, register CLI topic

- [x] T001 [P] Create `.env.example` from current `.env` with secret placeholders per data-model.md template mapping in `.env.example`
- [x] T002 [P] Create `.dev.env.example` from current `.dev.env` with secret/host placeholders per data-model.md template mapping in `.dev.env.example`
- [x] T003 Update `.gitignore` to add `.env`, `.dev.env`, `.dev-client-v2.pid`, `.dev-client-v2.log`
- [x] T004 Run `git rm --cached .env .dev.env` to stop tracking committed env files with secrets (preserves local copies)
- [x] T005 Register `dev` topic in `cli/package.json` under `oclif.topics` with description "Commands for development environment management"

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared utility module that ALL dev commands depend on

**CRITICAL**: No user story work can begin until this phase is complete

### Tests for Foundational

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T006 [P] Write unit tests for prerequisite checking functions (Docker, Compose, Node, Yarn, Bun detection) in `cli/test/devUtils.test.ts`
- [x] T007 [P] Write unit tests for port availability checking in `cli/test/devUtils.test.ts`
- [x] T008 [P] Write unit tests for Postgres TCP connectivity probe in `cli/test/devUtils.test.ts`
- [x] T009 [P] Write unit tests for env file copy-if-missing logic in `cli/test/devUtils.test.ts`
- [x] T010 [P] Write unit tests for client-v2 PID file management (write, read, check alive, remove) in `cli/test/devUtils.test.ts`
- [x] T010a [P] Write unit tests for Hasura readiness probe (`waitForHasura`) and client-v2 log file capture in `cli/test/devUtils.test.ts`

### Implementation for Foundational

- [x] T011 Implement `checkPrerequisites()` in `cli/src/devUtils.ts` — validates Docker, Docker Compose, Node.js, Yarn, Bun are available; returns array of missing with install guidance
- [x] T012 Implement `checkPortAvailability(ports: number[])` in `cli/src/devUtils.ts` — uses Node.js `net.createServer` probe; returns array of conflicting ports
- [x] T013 Implement `probePostgres(host: string, port: number)` in `cli/src/devUtils.ts` — TCP socket connect with 5s timeout; returns boolean; never logs credentials
- [x] T014 Implement `ensureEnvFiles(rootDir: string)` in `cli/src/devUtils.ts` — copies `.env.example` → `.env` and `.dev.env.example` → `.dev.env` if targets missing; never overwrites existing
- [x] T015 Implement `cleanStaleContainers(ctx: CustomContext)` in `cli/src/devUtils.ts` — queries `docker compose ps -a --status=exited --status=created` to find stopped containers, removes only those via `docker rm -f` with `.nothrow()`; preserves running containers and volumes (do NOT use `docker compose down` which destroys running containers)
- [x] T016 Implement client-v2 process management in `cli/src/devUtils.ts`: `startClientV2(rootDir)` spawns `yarn dev` in `../client-v2` as detached process, redirects stdout/stderr to `.dev-client-v2.log` (append mode), writes PID to `.dev-client-v2.pid`; `stopClientV2(rootDir)` reads PID, sends SIGTERM, removes PID file; `isClientV2Running(rootDir)` checks PID file + `kill -0`; `installClientV2Deps(rootDir)` runs `bun install` in `../client-v2` if `node_modules` missing
- [x] T017 Implement `getServiceStatus(ctx: CustomContext, rootDir: string)` in `cli/src/devUtils.ts` — queries `docker compose ps --format json` for Docker services + checks client-v2 PID/HTTP probe on port 8000; returns array of service status objects per data-model.md health check model
- [x] T018 Implement `formatStatusTable(services: ServiceStatus[])` in `cli/src/devUtils.ts` — renders service status array as aligned CLI table (Service, Type, Port, Status, Uptime columns per contracts/cli-commands.md)
- [x] T018a Implement `waitForHasura(port: number, timeoutMs: number)` in `cli/src/devUtils.ts` — polls `GET http://localhost:{port}/healthz` every 2s until 200 response or timeout (default 60s); returns boolean. Hasura has no compose healthcheck so Docker "running" state alone is insufficient before migrations
- [x] T019 Export constant `DEV_SERVICES` in `cli/src/devUtils.ts` — list of Docker Compose service names to start (all except `client`): `redis`, `actions`, `cubejs`, `cubejs_refresh_worker`, `hasura`, `hasura_cli`, `hasura_plus`, `minio`, `mailhog`, `cubestore`
- [x] T020 Export constant `DEV_PORTS` in `cli/src/devUtils.ts` — map of service name to port for conflict checking: `{cubejs: 4000, "client-v2": 8000, hasura: 8080, hasura_plus: 8081, cubestore: 3030, redis: 6379, mailhog: 8025, minio: 9000, minio_console: 9001, hasura_cli: 9695}`

**Checkpoint**: All utility functions tested and implemented. Dev commands can now use them.

---

## Phase 3: User Story 1 - First-Time Setup (Priority: P1) MVP

**Goal**: A single `./cli.sh dev setup` command takes a developer from fresh clone to fully working environment.

**Independent Test**: Clone repo on clean machine, run `./cli.sh dev setup`, verify login page accessible at `http://localhost:8000`.

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T021 [US1] Write test for `dev setup` command: validates prerequisite check is called, env files are ensured, Postgres is probed, network is created, stale containers cleaned, services started (excluding `client`), migrations applied, client-v2 deps installed, client-v2 started, status displayed in `cli/test/commands/dev/setup.test.ts`
- [x] T022 [US1] Write test for `dev setup` idempotency: running setup twice does not overwrite env files or recreate running containers in `cli/test/commands/dev/setup.test.ts`
- [x] T023 [US1] Write test for `dev setup` failure cases: missing prerequisite exits code 1, Postgres unreachable exits code 2, port conflict exits code 3, missing client-v2 exits code 4 in `cli/test/commands/dev/setup.test.ts`

### Implementation for User Story 1

- [x] T024 [US1] Implement `dev setup` command in `cli/src/commands/dev/setup.ts` extending BaseCommand with overridden `init()` that runs `ensureEnvFiles()` before `super.init()` (BaseCommand hard-fails if env files missing). Execution sequence per contracts/cli-commands.md: prerequisite validation → env file copy → env load (via super.init) → Postgres probe (fail fast exit 2) → network create → stale cleanup → port check (exit 3) → `docker compose up -d` with DEV_SERVICES list → wait for Hasura healthy (poll `http://localhost:8080/healthz` with retries) → `hasura cli "migrate apply"` (exit 5) → validate `../client-v2` exists (exit 4) → install deps if needed → start client-v2 (redirect stdout/stderr to `.dev-client-v2.log`) → display status table
- [x] T025 [US1] Add exit code constants and actionable error messages to `dev setup` per contracts/cli-commands.md exit codes (1=prerequisite, 2=postgres, 3=port, 4=client-v2, 5=migration) in `cli/src/commands/dev/setup.ts`

**Checkpoint**: `./cli.sh dev setup` works end-to-end. A developer can go from fresh clone to running environment.

---

## Phase 4: User Story 2 - Daily Development Workflow (Priority: P2)

**Goal**: `dev start`, `dev stop`, and `dev status` commands for daily use — faster than setup, manages full stack lifecycle including client-v2.

**Independent Test**: Run `./cli.sh dev start`, verify all services healthy via `./cli.sh dev status`, edit a backend file and confirm auto-reload, run `./cli.sh dev stop` and verify everything stops.

### Tests for User Story 2

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T026 [P] [US2] Write test for `dev start` command: validates Postgres probed, ports checked, network ensured, services started (excluding `client`), client-v2 directory validated, client-v2 started if not running, status displayed in `cli/test/commands/dev/start.test.ts`
- [x] T027 [P] [US2] Write test for `dev stop` command: validates client-v2 stopped (PID killed, file removed), Docker Compose stopped in `cli/test/commands/dev/stop.test.ts`
- [x] T028 [P] [US2] Write test for `dev status` command: validates output includes all Docker services plus client-v2 with correct columns (Service, Type, Port, Status, Uptime) in `cli/test/commands/dev/status.test.ts`

### Implementation for User Story 2

- [x] T029 [US2] Implement `dev start` command in `cli/src/commands/dev/start.ts` extending BaseCommand with execution sequence per contracts/cli-commands.md: env load → Postgres probe → port check → network ensure → `docker compose up -d` with DEV_SERVICES → validate `../client-v2` exists (exit 4) → start client-v2 if not running → display status
- [x] T030 [US2] Implement `dev stop` command in `cli/src/commands/dev/stop.ts` extending BaseCommand with overridden `init()` that skips env file validation (stop only needs PID file + Docker): stop client-v2 via `stopClientV2()` → `docker compose stop`
- [x] T031 [US2] Implement `dev status` command in `cli/src/commands/dev/status.ts` extending BaseCommand with overridden `init()` that skips env file validation (status only queries Docker + PID): call `getServiceStatus()` → `formatStatusTable()` → print to stdout

**Checkpoint**: Daily workflow complete. Developer can start/stop/check the full environment.

---

## Phase 5: User Story 3 - Dual-Codebase Development (Priority: P3)

**Goal**: `dev logs` command for unified log viewing across Docker services and client-v2. Documentation of sibling project layout and cross-project workflows.

**Independent Test**: Run `./cli.sh dev logs cubejs` to see CubeJS logs, run `./cli.sh dev logs client-v2` to see Vite output, verify proxy configuration works end-to-end by modifying a Hasura action and consuming it in client-v2.

### Tests for User Story 3

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T032 [US3] Write test for `dev logs` command: validates no-arg delegates to `docker compose logs`, service arg delegates to specific service, "client-v2" arg handles host process logs, `--tail` flag passes through in `cli/test/commands/dev/logs.test.ts`

### Implementation for User Story 3

- [x] T033 [US3] Implement `dev logs` command in `cli/src/commands/dev/logs.ts` extending BaseCommand with `name` arg (optional service) and `--tail` flag (default 500) per contracts/cli-commands.md: no arg → `docker compose logs --tail N -f`, "client-v2" → `tail -f -n N .dev-client-v2.log` (log file written by startClientV2), other → `docker compose logs {service} --tail N -f`
- [x] T034 [US3] Add sibling project layout documentation to `specs/001-dev-environment/quickstart.md` — verify directory layout section documents `../client-v2` (required) and `../cxs2` (optional reference), cross-project workflow section documents Hasura action → codegen → verify flow

**Checkpoint**: All user stories complete. Full dev environment lifecycle managed via CLI.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Validation, cleanup, and backward compatibility verification

- [x] T035 Verify all existing CLI commands still work unchanged: run `./cli.sh compose up`, `./cli.sh compose ps`, `./cli.sh compose logs`, `./cli.sh compose stop`, `./cli.sh compose restart`, `./cli.sh compose destroy`, `./cli.sh docker ex`, `./cli.sh hasura cli`, `./cli.sh tests stepci` and confirm identical behavior (FR-008, SC-006)
- [ ] T036 Run full quickstart.md validation: follow the quickstart guide on a clean checkout and verify each step succeeds
- [x] T037 Build CLI and verify no TypeScript errors: `cd cli && yarn build && yarn lint`
- [x] T038 [P] Run all CLI tests: `cd cli && yarn test` — verify all new and existing tests pass
- [x] T039 [P] Verify `.env` and `.dev.env` are properly gitignored and not tracked after transition

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (T005 topic registration needed before commands)
- **User Story 1 (Phase 3)**: Depends on Phase 2 (all devUtils functions)
- **User Story 2 (Phase 4)**: Depends on Phase 2 (devUtils) — can run in parallel with US1 but reuses some US1 patterns
- **User Story 3 (Phase 5)**: Depends on Phase 2 (devUtils) — can run in parallel with US1/US2
- **Polish (Phase 6)**: Depends on all user stories complete

### User Story Dependencies

- **User Story 1 (P1)**: Depends only on Foundational. Delivers the core `dev setup` command.
- **User Story 2 (P2)**: Depends only on Foundational. Can start after Phase 2 independently of US1. Reuses devUtils functions.
- **User Story 3 (P3)**: Depends only on Foundational. Can start after Phase 2 independently of US1/US2.

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Utility functions (devUtils) before commands
- Core command before error handling refinement
- Story complete before moving to next priority

### Parallel Opportunities

- T001, T002 can run in parallel (different files)
- T006–T010 can all run in parallel (separate test sections in same file)
- T026, T027, T028 can run in parallel (different test files)
- US1, US2, US3 can run in parallel after Phase 2 (different command files, shared devUtils)
- T035, T038, T039 can run in parallel (independent verification)

---

## Parallel Example: Phase 2 (Foundational)

```bash
# Launch all test tasks in parallel (different sections of devUtils.test.ts):
Task T006: "Unit tests for prerequisite checking"
Task T007: "Unit tests for port availability"
Task T008: "Unit tests for Postgres probe"
Task T009: "Unit tests for env file copy"
Task T010: "Unit tests for PID file management"

# Then implement sequentially (all in same file cli/src/devUtils.ts):
Task T011 → T012 → T013 → T014 → T015 → T016 → T017 → T018 → T019 → T020
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (env templates, gitignore, topic)
2. Complete Phase 2: Foundational (devUtils.ts + tests)
3. Complete Phase 3: User Story 1 (`dev setup` command)
4. **STOP and VALIDATE**: Run `./cli.sh dev setup` from a clean state
5. Verify login page accessible at `http://localhost:8000`

### Incremental Delivery

1. Setup + Foundational → devUtils ready
2. US1 (`dev setup`) → Test end-to-end → MVP!
3. US2 (`dev start/stop/status`) → Test daily workflow
4. US3 (`dev logs` + docs) → Test cross-project workflow
5. Polish → Backward compatibility + full test suite

### Parallel Team Strategy

With multiple developers after Phase 2:
- Developer A: US1 (`dev setup`)
- Developer B: US2 (`dev start`, `dev stop`, `dev status`)
- Developer C: US3 (`dev logs` + documentation)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- All commands extend `BaseCommand` and inherit `-e`, `-n`, `--shell` flags
- `dev setup` overrides `init()` to run `ensureEnvFiles()` before `super.init()` (BaseCommand hard-fails if env files missing)
- `dev stop` and `dev status` override `init()` to skip env validation (they only need PID file + Docker queries)
- `devUtils.ts` is the single shared module — avoid splitting into multiple utility files (YAGNI)
- Client-v2 stdout/stderr is redirected to `.dev-client-v2.log` for `dev logs client-v2` support
- Client-v2 proxy config already points to localhost:8080/8081/4000 — no changes needed
- Explicit service list in DEV_SERVICES excludes `client` (Nginx) per FR-015
- Stale container cleanup removes only stopped/exited containers — do NOT use `docker compose down` (destroys running containers)
- Hasura readiness: poll `/healthz` endpoint before running migrations (no compose healthcheck defined)
- Commit after each task or logical group
