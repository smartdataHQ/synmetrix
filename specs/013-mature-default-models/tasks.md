# Tasks: Mature Default Models

**Input**: Design documents from `/specs/013-mature-default-models/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED — constitution Principle III (TDD) is non-negotiable: within every phase, test tasks are written first and MUST FAIL before their implementation tasks begin.

**Scope guard (per invocation directive — no drift, no feature creep)**: every task below traces to an FR/SC in spec.md or a decision D1–D16 in research.md. Explicitly OUT of scope (deliberately no tasks): client-v2 UI badge for provenance, SQL-API canonical translation (documented limitation, D13), version-retention job, Hasura event triggers (D6 rejected), on-demand generation escape hatch (research "Scale ceiling"). Do not add tasks for these during implementation.

**Organization**: grouped by user story (US1–US5 from spec.md) for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

**Purpose**: configuration surface for the feature (no project scaffolding needed — existing monorepo services).

- [X] T001 Add the env keys from data-model.md "Configuration" table (seven `DEFAULT_MODELS_*` incl. `DEFAULT_MODELS_DRIFT_PROBES`, plus `ACTIONS_CRON_SECRET`) with comments to `.env.example`, and pass them through in `docker-compose.dev.yml` to the actions + cubejs services AND `ACTIONS_CRON_SECRET` to the **hasura** service (the cron trigger's `value_from_env` header resolves on the Hasura container)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: run persistence + shared config/reporting modules every story depends on.

**⚠️ CRITICAL**: no user story work until this phase completes.

- [X] T002 Create Hasura migration `services/hasura/migrations/<ts>_create_reconciliation_runs/` (FLAT layout — this repo does not use the `default/` database subdirectory; up.sql/down.sql exactly per data-model.md DDL incl. `heartbeat_at` and index); verify with `./cli.sh hasura cli "migrate apply"` in a clean environment (constitution Dev Workflow)
- [X] T003 Track `reconciliation_runs` in `services/hasura/metadata/tables.yaml` with NO permissions for role `user` (deny-by-default per data-model.md; constitution Principle IV)
- [X] T004 [P] Implement `services/actions/src/utils/defaultModels/config.js` — read + validate the seven env keys (incl. parsing `DEFAULT_MODELS_DRIFT_PROBES` JSON `[{table, timeColumn}]`), expose typed accessors, throw at startup when a required key is missing (TEMPLATE_DATASOURCE_ID, SYSTEM_USER_ID, TARGET_DATASOURCE_NAME) and apply defaults for the rest (HALT_THRESHOLD 0.2, COHORTS 4, CANARY_TEAM_IDS [], DRIFT_PROBES [] = treat all teams as changed); include its unit assertions in the same file's test `services/actions/src/utils/defaultModels/__tests__/config.test.js` (write test first)
- [X] T005 [P] Write failing unit tests for the run reporter (create run row, ATOMIC outcome appends under concurrency — Hasura jsonb `_append`, never read-modify-write; heartbeat refresh; stale-lease takeover of a `running` row with `heartbeat_at` > 10 min; finalize totals/status; single-team run shape) in `services/actions/src/utils/defaultModels/__tests__/runReporter.test.js`; also add the missing `"test": "node --test src/"` script to `services/actions/package.json` (actions currently has NO test script; NOTE actions runs Node 20 — `--test` does NOT expand glob strings there, so use directory discovery, not the cubejs-style glob which needs Node 22)
- [X] T006 Implement `services/actions/src/utils/defaultModels/runReporter.js` (admin-secret GraphQL writes to `reconciliation_runs`; `_append` for outcomes; heartbeat + stale-lease per data-model.md state machine) until T005 passes

**Checkpoint**: table exists, config loads, run rows can be written — user stories can begin.

---

## Phase 3: User Story 1 - Every team owns tailored default models (Priority: P1) 🎯 MVP

**Goal**: reconciliation pipeline end-to-end — templates read from the platform datasource, per-team probe → generate → validate → publish into the team's own datasource; triggered at onboarding, by schedule (backfill), or manually. FR-001..FR-009, FR-014, FR-018, FR-019.

**Independent Test**: quickstart.md steps 2–4 — author a template, run `reconcileDefaultModels`, verify two teams received differently-tailored, team-scoped, system-attributed models; empty-partition team gets a skeleton.

### Tests for User Story 1 (write first, must fail)

- [X] T007 [P] [US1] Unit tests for template-mode generation — provenance meta stamped (`default_model`, `template`, `template_checksum`, `from_template`), partition literal baked, skeleton output for an empty profile — in `services/cubejs/src/utils/smart-generation/__tests__/templateMode.test.js`
- [X] T008 [P] [US1] Unit tests for the worker pipeline — collision skip (team-authored file, no provenance meta → `skipped_collision`, no write), no-op guard (`skipped_no_change`), validation-failure isolation (previous version stays live, outcome `failed`, other templates continue), version `user_id` = system user, retirement sweep (derived model whose `meta.template` is absent from the request's `templates` list → stamped `meta.default_model_unmanaged: true`, no content updates — FR-020), append-only publish (publish always inserts a new version, never mutates an existing one — spec "Concurrent edit" edge) — in `services/cubejs/src/routes/__tests__/reconcileTeam.test.js`
- [X] T009 [P] [US1] StepCI workflow: single-team reconcile happy path (`POST /rpc/reconcileTeamDefaultModels` → outcomes `updated`, new version queryable via `/api/v1/load`) PLUS onboarding path: create a fresh team via the `create_team` action → poll until its derived models are queryable (FR-007c, SC-001 primary path) in `tests/workflows/default-models/reconcile-team.yml`

### Implementation for User Story 1

- [X] T010 [US1] Add template mode to `services/cubejs/src/utils/smart-generation/cubeBuilder.js`: accept template cube definitions as the base, stamp provenance meta per data-model.md conventions, keep existing baked `partition = '<team>'` behavior, emit skeleton (template structure only) when the profile is empty (D3, D5, D16b) — until T007 passes
- [X] T011 [US1] Implement `services/cubejs/src/routes/reconcileTeam.js` (`POST /api/v1/internal/reconcile-team`) — full 8-step pipeline per contracts/cubejs-internal.md (incl. retirement sweep, app-computed `versions.checksum` — NOT NULL, no DB trigger, files SORTED BY NAME before hashing/comparing — and per-outcome `breaking` removed-members diff via existing versionDiff) and "Auth & scope construction" (verify system-user JWT `sub` == `DEFAULT_MODELS_SYSTEM_USER_ID`; NO membership-based checkAuth — fetch the datasource admin-side and build scope via `defineUserScope([dataSource], syntheticMembers, ...)` per the `metaForBranch.js` pattern), per-template outcome isolation, `purgeStale()` + fire-and-forget metaConfig pre-warm; mount in `services/cubejs/src/routes/index.js` — until T008 passes
- [X] T012 [US1] Add `reconcileTeam(...)` client method (system-user token, 120s timeout) to `services/actions/src/utils/cubejsApi.js`
- [X] T013 [US1] Implement `services/actions/src/rpc/reconcileTeamDefaultModels.js` per contracts/actions-rpc.md — auth gate FIRST (`x-actions-cron-secret` == `ACTIONS_CRON_SECRET` OR portal admin, returning 403 — which requires the additive dispatcher change in `services/actions/index.js` honoring an optional `status` field on error returns, per contract note), then: idempotently ensure the system user row exists (`versions.user_id` FK — insert `users` row with the configured UUID if absent), resolve team + target datasource by `DEFAULT_MODELS_TARGET_DATASOURCE_NAME`, provision it if missing via existing `provisionDefaultDatasources` (if provisioning is impossible — no config entry or missing secret env — record outcome `failed` with reason `target_datasource_unavailable`, don't throw), read published templates from the template datasource's active branch, call the worker, record a single-team run via runReporter
- [X] T014 [US1] Implement `services/actions/src/rpc/reconcileDefaultModels.js` (minimal fleet loop, no staging yet): same auth gate as T013, concurrent-run guard with stale-lease takeover (200 `{status:"already_running", runId}` — cron-friendly, per contract), read templates once, iterate all teams with a small concurrency limit, per-team worker calls, outcomes + totals via runReporter, `dryRun`/`cohortLimit` accepted (FR-010 operational aids only — see contract traceability note); write the fleet-isolation unit test FIRST (one team's worker call rejects ⇒ remaining teams still processed and their outcomes recorded — FR-018, "Partial fleet failure" edge) in `services/actions/src/rpc/__tests__/reconcileDefaultModels.test.js`
- [X] T015 [US1] Fire-and-forget `reconcileTeamDefaultModels` after team creation in BOTH creation paths: `services/actions/src/auth/provision.js` AND `services/actions/src/rpc/createTeam.js` (which already calls `provisionDefaultDatasources` — same hook point; failure recovered by scheduled backfill — FR-002, SC-001)
- [X] T016 [US1] Add `reconcile_default_models` cron trigger (`*/15 * * * *`, payload `{trigger: schedule}`, header `x-actions-cron-secret` from env `ACTIONS_CRON_SECRET`) to `services/hasura/metadata/cron_triggers.yaml` per contracts/actions-rpc.md

**Checkpoint**: US1 acceptance scenarios 1–4 pass via quickstart steps 2–4. MVP deliverable.

---

## Phase 4: User Story 2 - Template updates propagate safely (Priority: P2)

**Goal**: publish detection, canary-first staged cohorts with halt threshold, template-wins convergence merge, retirement marking, admin report. FR-010, FR-012, FR-017, FR-020.

**Independent Test**: quickstart step 6 "validation gate" — publish a template edit, watch staged convergence; publish a broken edit, watch canary fail → halt → report; unchanged teams record nothing.

### Tests for User Story 2 (write first, must fail)

- [X] T017 [P] [US2] Unit tests for templateMerger — template-owned (`from_template`) fields converge to template (incl. overwriting a team edit — FR-012), probe-derived (`auto_generated`) fields regenerate, team-added fields preserved — in `services/cubejs/src/utils/smart-generation/__tests__/templateMerger.test.js`
- [X] T018 [P] [US2] Unit tests for cohorts — deterministic assignment (hash(team_id) mod `DEFAULT_MODELS_COHORTS`), canary cohort = fftech team + `DEFAULT_MODELS_CANARY_TEAM_IDS`, halt when cohort failure rate > `DEFAULT_MODELS_HALT_THRESHOLD`, CONTINUE to the next cohort when the rate is ≤ threshold (below-threshold failures never stop the fleet — FR-018) — in `services/actions/src/utils/defaultModels/__tests__/cohorts.test.js`
- [X] T019 [P] [US2] StepCI workflow: broken-template rollout → canary `failed` outcomes → run `halted`, non-canary teams untouched; then `getDefaultModelsReport` returns `teamsBehind` with reasons; plus retirement flow: publish a template-branch version with a template removed → next run stamps `default_model_unmanaged: true` on each team's derived model and applies no further updates to it (FR-020) — in `tests/workflows/default-models/rollout-halt.yml`

### Implementation for User Story 2

- [X] T020 [US2] Implement `services/cubejs/src/utils/smart-generation/templateMerger.js` (three-class merge per D4) and wire it into worker pipeline step 3 in `services/cubejs/src/routes/reconcileTeam.js` — until T017 passes
- [X] T021 [US2] Add template-publish detection to `services/actions/src/rpc/reconcileDefaultModels.js`: compare template branch's latest `versions.checksum` against last completed run's `template_checksum`; changed ⇒ run with `trigger: template_publish` covering all teams
- [X] T022 [US2] Implement `services/actions/src/utils/defaultModels/cohorts.js` and wire staged cohort-by-cohort execution + halt into the orchestrator, persisting `cohort_state` via runReporter — until T018 passes
- [X] T023 [US2] Implement `services/actions/src/rpc/getDefaultModelsReport.js` per contracts/actions-rpc.md (cron-secret/portal-admin gated; latest-run default; `teamsBehind` + `breakingChanges` projections — the latter from per-outcome `breaking` arrays, SC-003)
- [X] T024 [US2] Retirement marking (FR-020, D16c): templates absent from the template branch ⇒ next reconciliation stamps `meta.default_model_unmanaged: true` on the team's derived model and stops updating it — derived worker-side from the request's `templates` list per contracts/cubejs-internal.md step 4 (no extra orchestrator field) — until T008's retirement cases and T019's retirement flow pass

**Checkpoint**: US2 acceptance scenarios 1–4 pass; US1 still passes.

---

## Phase 5: User Story 3 - Models track evolving data (Priority: P3)

**Goal**: fleet-wide drift detection so changed teams refresh and unchanged teams cost nothing. FR-008 (cheap no-op), SC-006, SC-007.

**Independent Test**: quickstart step 6 flow — insert new-property rows for one team, run: that team updates, others `skipped_no_change`; immediate second run is a fleet-wide no-op.

### Tests for User Story 3 (write first, must fail)

- [X] T025 [P] [US3] Unit tests for drift detection — snapshot diff (partition → {row_count, max_event_time}) yields exactly the changed/new team set; missing prior snapshot ⇒ all teams considered changed — in `services/actions/src/utils/defaultModels/__tests__/drift.test.js`

### Implementation for User Story 3

- [X] T026 [US3] Implement `services/actions/src/utils/defaultModels/drift.js` — one `SELECT partition, count(), max(<timeColumn>) ... GROUP BY partition` probe per `DEFAULT_MODELS_DRIFT_PROBES` entry (D7), snapshot persistence on the run row (`drift_snapshot`), diff vs last completed run — and wire skip-unchanged into `services/actions/src/rpc/reconcileDefaultModels.js` (schedule-triggered runs process only changed teams; template-publish runs still cover all)
- [X] T027 [US3] StepCI workflow: two consecutive schedule runs with no data change — second run reports all teams `skipped_no_change` and writes zero new versions (SC-007) — in `tests/workflows/default-models/reconcile-noop.yml`

**Checkpoint**: US3 acceptance scenarios pass; scheduled runs are near-free when idle.

---

## Phase 6: User Story 4 - Customizations survive, provenance visible, opt-out honored (Priority: P4)

**Goal**: per-template opt-out semantics and end-to-end proof of preservation + attribution (merge/attribution mechanics were built in US1/US2; this story wires opt-out and proves the policies). FR-011, FR-013, FR-014.

**Independent Test**: quickstart step 6 "opt-out" and "customization survives" flows.

### Tests for User Story 4 (write first, must fail)

- [X] T028 [P] [US4] Unit tests for opt-out semantics — orchestrator/single-team RPC reads `team.settings.default_models.opt_out` and passes it through; worker double-checks and returns `skipped_opt_out`; opted-out template neither created nor updated (deletion sticks); deletion WITHOUT opt-out ⇒ recreated on next run — in `services/actions/src/rpc/__tests__/optOut.test.js` and extended cases in `services/cubejs/src/routes/__tests__/reconcileTeam.test.js`

### Implementation for User Story 4

- [X] T029 [US4] Wire opt-out through both services per FR-013/D11: read settings in `services/actions/src/rpc/reconcileTeamDefaultModels.js` + `reconcileDefaultModels.js`, honor + double-check in `services/cubejs/src/routes/reconcileTeam.js` — until T028 passes
- [X] T030 [US4] StepCI workflow: add a team dimension to a derived model → reconcile → field preserved AND run's new version attributed to the system user in version history; opt out via the EXISTING `update_team_settings` action as team owner (FR-013's write path — no new setter RPC; `partition` stays protected by the rule-linked strip in `updateTeamSettings.js`) → delete → stays deleted; remove opt-out → recreated — in `tests/workflows/default-models/customization.yml`

**Checkpoint**: US4 acceptance scenarios 1–3 pass (scenario 3 template-wins was proven by T017).

---

## Phase 7: User Story 5 - Canonical queries work for every team (Priority: P5)

**Goal**: pre-validation query pre-processor with the fixed day-one rule set (R1 canonical translation + R2 scoping enforcement), scoped exclusively to default models; SQL-API scoping backstop. FR-015, FR-016, SC-005.

**Independent Test**: quickstart step 5 — canonical query succeeds per team with team-scoped results; absent-member reference returns `DEFAULT_MODEL_MEMBER_UNAVAILABLE` (not a generic validation error); team-only queries pass through byte-identical.

### Tests for User Story 5 (write first, must fail)

- [X] T031 [P] [US5] Unit tests for the fixed rules — R1 canonical→variant translation, absent-member deterministic rejection payload (code, member, template), R2 scope-filter injection with dedupe, idempotence (double-processing is a no-op) — in `services/cubejs/src/utils/__tests__/defaultModelRules.test.js`
- [X] T032 [P] [US5] Unit tests for the middleware — in-scope detection via `meta.default_model` AND the `x-hasura-datasource-id` == target-datasource guard (a same-named cube on a DIFFERENT datasource must pass through byte-identical), branch/version-preview pass-through (`x-hasura-branch-id`/`x-hasura-branch-version-id` present ⇒ untouched), out-of-scope pass-through, array/blending queries, GET JSON-string form, fail-open-to-gateway on missing/invalid JWT and on meta-cache failure (contract guarantee 3) — in `services/cubejs/src/utils/__tests__/queryPreprocessor.test.js`
- [X] T033 [P] [US5] StepCI workflow: same canonical query under two teams' JWTs → each gets own-scoped results; absent-member query → 400 `DEFAULT_MODEL_MEMBER_UNAVAILABLE`; team-only-model query unaffected — in `tests/workflows/default-models/preprocessor.yml`

### Implementation for User Story 5

- [X] T034 [US5] Implement `services/cubejs/src/utils/defaultModelMeta.js` per contracts/query-preprocessor.md "Identity & member-map resolution" — admin-secret read-only chain partition → team → target datasource (by configured name) → active branch → latest version (dataschema ID set ⇒ schemaVersion cache key, TTL ≤ 30s), member map by PARSING raw dataschema files (reuse the `buildCubeToTableMap` pattern from `queryRewrite.js:99-151`; NO compiler/`metaForBranch` — avoids cold-compile latency on the query path); incl. legacy-JWT fallback (userId → membership → `team.settings.partition`)
- [X] T035 [US5] Implement `services/cubejs/src/utils/defaultModelRules.js` (R1 + R2 per contracts/query-preprocessor.md) — until T031 passes
- [X] T036 [US5] Implement `services/cubejs/src/utils/queryPreprocessor.js` and mount it for `/api/v1/load`, `/api/v1/dry-run`, `/api/v1/sql` (GET+POST) BEFORE `cubejs.initApp(app)` in `services/cubejs/index.js` (verified mount point index.js:100-102) — until T032 passes
- [X] T037 [P] [US5] Add `DEFAULT_MODEL_MEMBER_UNAVAILABLE` to `services/cubejs/src/utils/errorCodes.js` and keep `scripts/lint-error-codes.mjs` contract sync green
- [X] T038 [P] [US5] SQL-API scoping backstop (D13): verify existing seeds already cover the templates' source tables — migration `1741520400000` seeds `semantic_events`, `data_points`, `entities` with a UNIQUE constraint on (cube_name, dimension, property_source, property_key) — and add an IDEMPOTENT top-up migration (`INSERT ... ON CONFLICT DO NOTHING`) ONLY for source tables in `DEFAULT_MODELS_DRIFT_PROBES`/templates not yet covered, in `services/hasura/migrations/<ts>_seed_default_model_scoping_rules/` (flat layout); verify with `./cli.sh hasura cli "migrate apply"` in a clean environment (constitution Dev Workflow)
- [X] T039 [P] [US5] Raise `CUBE_TABLE_MAP_MAX_SIZE` from 50 to 1000 in `services/cubejs/src/utils/queryRewrite.js` (D15 — required once T038's rule is active fleet-wide)

**Checkpoint**: US5 acceptance scenarios 1–3 pass. All stories complete.

---

## Phase 8: Polish & Cross-Cutting

- [X] T040 Execute the full quickstart.md walkthrough (steps 1–7) against the dev stack end-to-end, timing team-creation → first successful default-model query (SC-001 ≤ 10 min); fix discrepancies between docs and behavior
- [X] T041 [P] Measure success criteria: timed no-op fleet run (SC-007 zero versions; extrapolate SC-006 and record it as extrapolated, not measured — accepted limitation, full 500-team fleet not exercised pre-GA), pre-processor added latency ≤ 10ms p95 on `/api/v1/load` (contract guarantee 5); record results in `specs/013-mature-default-models/quickstart.md` footnotes
- [X] T042 [P] Update `CLAUDE.md` "Key File Locations" with the new routes/utils (reconcileTeam, queryPreprocessor, defaultModelRules, defaultModels/*, reconciliation_runs migration)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 → Phase 2 → user stories**: T002/T003 (table) block runReporter (T006); T004/T006 block all RPC tasks.
- **US1 (Phase 3)**: only depends on Foundational. **MVP.**
- **US2 (Phase 4)**: depends on US1 (worker + orchestrator exist). T020 modifies `reconcileTeam.js` (after T011); T021/T022 modify `reconcileDefaultModels.js` (after T014).
- **US3 (Phase 5)**: depends on US1 orchestrator; independent of US2 (drift wiring touches `reconcileDefaultModels.js` — coordinate if US2/US3 run in parallel).
- **US4 (Phase 6)**: depends on US1 (both RPCs + worker); preservation proof leans on US2's merger (T020) for the merge path.
- **US5 (Phase 7)**: depends on US1 only (needs derived models with provenance meta to exist). Can run in parallel with US2–US4 (different files entirely).
- **Polish (Phase 8)**: after all desired stories.

### Within stories

Tests first and failing → implementation until green → StepCI. Tasks sharing a file are sequential (noted above); [P] tasks are safe to parallelize.

## Parallel Example: after Foundational completes

```text
Developer A (US1 — MVP path):     T007, T008, T009 in parallel → T010 → T011 → T012–T016
Developer B (US5 — independent):  T031, T032, T033 in parallel → T034 → T035 → T036; T037/T038/T039 anytime
Then: US2 (A), US3+US4 (B) — coordinate the shared reconcileDefaultModels.js edits (T021/T022 vs T026)
```

## Implementation Strategy

**MVP first**: Phases 1–3 (T001–T016) deliver the core promise — every team owns tailored, scoped, system-attributed default models with onboarding + scheduled backfill. Stop, validate with quickstart steps 2–4, demo.

**Increment order**: US2 (safe propagation — the reason templates exist) → US3 (cheap steady-state) → US4 (policy wiring) → US5 (canonical query product layer). Each checkpoint leaves prior stories green.

**Task counts**: Setup 1 · Foundational 5 · US1 10 · US2 8 · US3 3 · US4 3 · US5 9 · Polish 3 = **42 tasks**.
