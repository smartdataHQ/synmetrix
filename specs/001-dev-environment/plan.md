# Implementation Plan: Proper Development Environment

**Branch**: `001-dev-environment` | **Date**: 2026-03-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-dev-environment/spec.md`

## Summary

Extend the existing `cli.sh` / oclif CLI with a `dev` command topic
that orchestrates the full development environment: prerequisite
validation, env file bootstrapping from templates, Postgres
connectivity check, Docker network creation, stale container cleanup,
Docker Compose service startup (excluding the Nginx `client` service),
client-v2 dependency installation, and client-v2 Vite dev server
lifecycle management as a native host process. Adds a health-check
summary command. All existing CLI commands remain unchanged.

## Technical Context

**Language/Version**: TypeScript (ES2022, Node16 modules) — matches
existing CLI at `cli/src/`
**Primary Dependencies**: oclif (CLI framework), zx (shell execution)
— both already in `cli/package.json`
**Storage**: PID file at `.dev-client-v2.pid` for client-v2 process
tracking; no database changes
**Testing**: oclif test harness (Mocha + Chai) — existing pattern in
`cli/test/`
**Target Platform**: macOS, Linux (WSL2 acceptable)
**Project Type**: CLI extension (new commands in existing oclif CLI)
**Performance Goals**: Setup < 10min first run, < 60s subsequent;
health check < 5s
**Constraints**: MUST NOT modify `docker-compose.dev.yml`; MUST NOT
break existing commands; client-v2 at `../client-v2` relative to
repo root
**Scale/Scope**: 5 new command files, 1 new utility module, 2
env example files, .gitignore update

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Service Isolation | PASS | New commands extend CLI only; no service code changes. Docker Compose services remain independently deployable. client-v2 runs as a separate native process. |
| II. Multi-Tenancy First | N/A | No changes to datasource resolution, branch selection, schema loading, or security contexts. |
| III. Test-Driven Development | PASS | CLI tests will be written using existing oclif test harness before implementation. |
| IV. Security by Default | PASS | FR-004 moves secrets out of committed env files into gitignored local copies. Postgres credentials validated but never logged. |
| V. Simplicity / YAGNI | PASS | Reuses existing BaseCommand, callCompose, zx patterns. No new dependencies. PID file for process management is the simplest viable approach. |

No violations. No Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-dev-environment/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── cli-commands.md  # New CLI command interface contracts
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
cli/src/
├── BaseCommand.ts              # Existing (no changes)
├── utils.ts                    # Existing (no changes)
├── devUtils.ts                 # NEW: client-v2 process mgmt, prereq
│                               #   checks, Postgres probe, port checks
├── commands/
│   ├── compose/                # Existing (no changes)
│   │   ├── up.ts
│   │   ├── stop.ts
│   │   ├── restart.ts
│   │   ├── logs.ts
│   │   ├── destroy.ts
│   │   ├── ps.ts
│   │   └── push.ts
│   ├── dev/                    # NEW: dev environment topic
│   │   ├── setup.ts            # First-time + subsequent setup
│   │   ├── start.ts            # Start env (compose up + client-v2)
│   │   ├── stop.ts             # Stop env (compose stop + client-v2)
│   │   ├── status.ts           # Health-check summary
│   │   └── logs.ts             # Unified logs (compose + client-v2)
│   ├── docker/                 # Existing (no changes)
│   ├── hasura/                 # Existing (no changes)
│   ├── swarm/                  # Existing (no changes)
│   └── tests/                  # Existing (no changes)
└── index.ts                    # Existing (no changes)

cli/test/commands/dev/           # NEW: tests for dev commands
├── setup.test.ts
├── start.test.ts
├── stop.test.ts
├── status.test.ts
└── logs.test.ts

# Root-level files
.env.example                     # NEW: base env template (no secrets)
.dev.env.example                 # NEW: dev env template (placeholder
                                 #   secrets)
.gitignore                       # MODIFIED: add .env, .dev.env,
                                 #   .dev-client-v2.pid,
                                 #   .dev-client-v2.log
```

**Structure Decision**: Extends the existing CLI project at `cli/`.
New commands live under a `dev` topic (parallel to existing `compose`,
`swarm`, `docker`, `hasura`, `tests` topics). Shared dev utilities in
a new `devUtils.ts` module. No new top-level directories created.

**Bootstrap Override**: `dev setup` overrides `BaseCommand.init()` to
create env files before calling `super.init()`, since BaseCommand
hard-fails if env files are missing. `dev stop` and `dev status`
also override `init()` to skip env validation — they only need PID
files and Docker queries, not loaded environment variables.
BaseCommand itself remains unchanged.

## Complexity Tracking

> No violations detected. Table empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
