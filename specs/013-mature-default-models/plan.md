# Implementation Plan: Mature Default Models

**Branch**: `013-mature-default-models` | **Date**: 2026-07-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/013-mature-default-models/spec.md`

## Summary

The platform team (fftech.is) maintains **global templates** as ordinary models in a platform-owned datasource. A **reconciliation pipeline** (Hasura cron → Actions orchestrator → CubeJS worker) guarantees every team owns derived models generated from those templates and tailored to the team's actual data via the existing smart-generation profiler (partition-scoped SQL probes). Derived models are ordinary team-owned dataschemas — they flow through the existing versioning, security-context, and compiler-cache machinery unchanged, which is what makes per-team caching and isolation free. Template updates roll out in canary-first cohorts with per-team validation before publish; team-added content is preserved by extending the existing merge engine with a template-provenance class (template wins on template-owned content). A new **query pre-processor** — Express middleware mounted ahead of the Cube API gateway — applies the fixed day-one rule set (account-scoping enforcement + canonical-reference translation) to queries touching default models **before standard query validation**, which the existing `queryRewrite` hook cannot do (verified: it runs after Joi normalization).

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 22.x (CubeJS service), Node.js 18+ (Actions service)
**Primary Dependencies**: Cube.js v1.6.x (`@cubejs-backend/server-core`, `schema-compiler`, `api-gateway` — all existing), Express 4.18.2 (existing), `yaml` ^2.3.4 (existing), Hasura v2 (existing). **No new npm dependencies.**
**Storage**: PostgreSQL via Hasura — existing `datasources`, `branches`, `versions`, `dataschemas`, `teams.settings`, `query_rewrite_rules`; ONE new table `reconciliation_runs` + one new `team.settings` key. ClickHouse: probe target, read-only.
**Testing**: unit tests in `services/{cubejs,actions}/src/**/__tests__/` (existing pattern), StepCI workflows in `tests/workflows/default-models/`
**Target Platform**: Dockerized Linux services (SaaS + on-prem installs)
**Project Type**: web-service monorepo (Actions + CubeJS + Hasura metadata; client-v2 unaffected day one)
**Performance Goals**: full-fleet reconciliation at 500 teams ≤ 4h (SC-006); pre-processor overhead ≤ 10ms p95 per request; zero query-latency regression during runs; new team queryable ≤ 10 min after onboarding (SC-001)
**Constraints**: reconciliation must be no-op cheap (single fleet-wide change-detection probe; existing checksum no-op guard); cron→RPC direct call avoids the 300s Hasura action timeout; propagation ≤ 24h of template publish (SC-002); no team left with a broken model set and breaking member changes reported per team (SC-003 — validation gate, canary halt, versionDiff-based breaking-change report)
**Scale/Scope**: 500 teams design target; architecture ceiling ~1,000 teams before generation must move to on-demand (documented escape hatch in research.md)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Evidence |
|---|-----------|--------|----------|
| I | Service Isolation | **PASS** | Additive contracts only: new Actions RPCs (`reconcileDefaultModels`, `reconcileTeamDefaultModels`, `getDefaultModelsReport`), one new internal CubeJS route (`POST /api/v1/internal/reconcile-team`), one Hasura cron trigger, one migration. No existing contract changes; each service remains independently deployable (pre-processor no-ops when config absent). client-v2 untouched (provenance meta is additive). |
| II | Multi-Tenancy First | **PASS** | Derived models are ordinary per-team dataschemas: resolution flows through `defineUserScope.js`/`buildSecurityContext.js` **unchanged**; new versions mint new dataschema row IDs so content-hashed cache isolation works exactly as today. The pre-processor adapts queries but never authorizes: `checkAuth`, access-list enforcement, and `queryRewrite` all still run downstream. Account scoping is baked per team at generation + backstopped by a `query_rewrite_rules` row (covers the SQL API path the middleware cannot see). The pre-processor's meta lookup (`defaultModelMeta.js`) is read-only admin-side resolution keyed to the caller's own verified partition claim — the same established pattern as `queryRewrite.js`'s cube→table map (`:99-151`) — returns no user data, and leaves `checkAuth`/`defineUserScope` enforcement untouched downstream. |
| III | Test-Driven Development | **PASS** (enforced in tasks) | Unit tests first for: template-provenance merge, pre-processor rules (scoping, translation, absent-field rejection, pass-through), collision/opt-out/skeleton logic, cohort/halt logic. StepCI coverage for the new RPCs and internal route. |
| IV | Security by Default | **PASS** | New `reconciliation_runs` table ships with Hasura permissions (no `user`-role access; reports served via admin-gated RPC). Internal reconcile route authenticated service-to-service (verified system-user JWT) and constructs its scope via `defineUserScope` with an explicitly fetched datasource — no membership grants for the system user (see contracts/cubejs-internal.md "Auth & scope construction"). Middleware fails open **to the gateway's auth** — on any resolution error it passes the request through untouched and the gateway rejects as today; it never mints or bypasses credentials. Datasource credentials stay in existing `db_params`/env flow. |
| V | Simplicity / YAGNI | **PASS** (3 justified items) | No new dependencies; reuses smart-gen, versioning, cron→RPC, and validation machinery end-to-end. Three genuinely new complexity items justified in Complexity Tracking. Rejected simpler alternatives documented per decision in research.md. |

**Post-Phase-1 re-check (2026-07-06)**: design artifacts introduce no new violations — data model adds one table + meta conventions only; contracts are additive; multi-tenancy path unchanged. Gates hold.

## Project Structure

### Documentation (this feature)

```text
specs/013-mature-default-models/
├── plan.md              # This file
├── research.md          # Phase 0 output — 16 decisions, all clarifications resolved
├── data-model.md        # Phase 1 output — entities, new table, meta conventions, state machines
├── quickstart.md        # Phase 1 output — end-to-end local dev walkthrough
├── contracts/           # Phase 1 output
│   ├── actions-rpc.md           # reconcileDefaultModels / reconcileTeamDefaultModels / getDefaultModelsReport
│   ├── cubejs-internal.md       # POST /api/v1/internal/reconcile-team (per-team worker)
│   └── query-preprocessor.md    # middleware behavior contract (paths, rules, errors, guarantees)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
services/actions/src/
├── rpc/
│   ├── reconcileDefaultModels.js        # fleet orchestrator: cohorts, change detection, halt (cron entry)
│   ├── reconcileTeamDefaultModels.js    # single-team entry (onboarding hook, admin retry)
│   ├── getDefaultModelsReport.js        # per-run report for platform admins (FR-017, SC-008)
│   └── createTeam.js                    # MODIFIED: fire-and-forget single-team reconcile (second creation path)
├── utils/defaultModels/
│   ├── config.js                        # template catalog source, target datasource name, cohort/halt config
│   ├── cohorts.js                       # deterministic cohort assignment (hash(team_id)), canary set
│   ├── drift.js                         # fleet-wide change-detection probe + snapshot diff (D7, US3)
│   └── runReporter.js                   # reconciliation_runs row lifecycle
├── utils/provisionDefaultDatasources.js # existing — invoked when a team lacks the target datasource
└── auth/provision.js                    # MODIFIED: fire-and-forget single-team reconcile after team creation

services/cubejs/src/
├── routes/
│   ├── reconcileTeam.js                 # POST /api/v1/internal/reconcile-team — probe→generate→merge→validate→publish
│   └── index.js                         # MODIFIED: mount new route + queryPreprocessor middleware
├── utils/
│   ├── queryPreprocessor.js             # pre-gateway middleware (FR-015)
│   ├── defaultModelRules.js             # fixed rule set: scoping enforcement + canonical translation (FR-016)
│   ├── defaultModelMeta.js              # cached per-team derived-model meta (partition → cube/member map)
│   └── queryRewrite.js                  # MODIFIED: cubeTableMap cache 50 → 1000 (research D15)
├── utils/smart-generation/
│   ├── templateMerger.js                # template-provenance merge class (FR-011/FR-012)
│   └── cubeBuilder.js                   # MODIFIED: template mode — provenance meta, skeleton generation
└── index.js                             # MODIFIED: queryPreprocessor mounted before cubejs.initApp (line ~100)

services/hasura/
├── metadata/cron_triggers.yaml          # MODIFIED: + reconcile_default_models (*/15)
├── migrations/<ts>_create_reconciliation_runs/           # new table + permissions (flat layout — no default/ subdir in this repo)
└── migrations/<ts>_seed_default_model_scoping_rules/     # idempotent query_rewrite_rules top-up (D13, T038)

tests/workflows/default-models/          # StepCI: RPCs, internal route, preprocessor behavior
```

**Structure Decision**: Existing monorepo service layout; all new code follows the established per-service patterns (Actions RPC-per-file, CubeJS route/util split, Hasura metadata + migrations). No new services, packages, or projects.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Pre-gateway Express middleware (new step in the query path) | FR-015 requires query transformation **before standard validation**. Verified in the installed gateway (`@cubejs-backend/api-gateway/dist/src/gateway.js:898-952`): Joi structural validation (`normalizeQuery`) runs **before** `queryRewrite`, so the existing hook cannot satisfy the requirement. Mount point verified safe: `services/cubejs/index.js:100` (custom routes) precedes `cubejs.initApp(app)` at `:102`. | *queryRewrite-only*: canonical/extended queries would already be rejected by structural validation before the hook fires; translation of variant-absent members would be impossible. |
| Template-provenance class in the merge engine | FR-011 + FR-012 need three-way field classing: template-owned converges (template wins), probe-derived regenerates, team-added persists. Existing `diffModels.js` classes (user / `auto_generated` / `ai_generated`) preserve user content but cannot converge template content. | *Full replace per reconciliation*: destroys team customizations, violating FR-011. *Never-touch merge (existing `merge` strategy)*: template updates could never converge edited fields, violating FR-012's "template wins". |
| New `reconciliation_runs` table | FR-017/SC-008 require a durable, queryable per-team outcome record ("which teams are behind and why") plus rollout/halt state for staged cohorts (FR-010). | *Logs only*: not queryable, lost on rotation. *Reuse `audit_logs`*: shaped for per-user mutations, 90-day retention cron would silently erase rollout history, and rows are written per action — no run-level state for cohort/halt tracking. |
