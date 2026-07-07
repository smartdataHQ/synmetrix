# Tasks: Dynamic Map/JSON Field Access

**Input**: Design documents from `/specs/014-dynamic-map-json-access/`
**Prerequisites**: 013 fully implemented (pre-processor, templates, reconciliation, worker, StepCI seeds).

**Tests**: INCLUDED — constitution Principle III (TDD): within every phase, test tasks are written first and MUST FAIL before their implementation tasks begin.

**Scope guard**: every task traces to an FR/SC in spec.md. Explicitly OUT of scope: REST member expressions (FR-011 — permanently), lazy member materialization (rejected by product owner), automatic JSON explosion, client-v2 UI (contract documented only), Hasura/Actions changes (none needed).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup & Assumption Gates

- [X] T101 Add `DYNAMIC_META_TTL_MS` (default 120000) and `DYNAMIC_META_SAMPLE_VALUES` (default 5) to `.env.example` with comments; pass through to cubejs in `docker-compose.dev.yml`
- [X] T102 **Assumption gate (spec Assumptions #3)**: unit test proving a FILTER_PARAMS slot member (key dim + value member per plan's template convention) compiles in the standalone `prepareCompiler` validation gate (the 013 worker's validator) — in `services/cubejs/src/utils/smart-generation/__tests__/paramSlots.test.js`. If this FAILS, STOP and re-plan slot SQL (e.g. function-form FILTER_PARAMS) before any other work.

---

## Phase 2: Foundational

- [X] T103 [P] Add `DYNAMIC_KEY_SLOTS_EXHAUSTED` to `services/cubejs/src/utils/errorCodes.js` under the 013 `DefaultModelErrorCode` conventions (uppercase value; NOT in the 011 enum; `scripts/lint-error-codes.mjs` stays green)
- [X] T104 [P] Update the platform default template content (dev seed + template authoring guide section in examples.md): add the FR-002 slot set to `semantic_events` — `dim_key_a/dim_value_a`, `dim_key_b/dim_value_b` (dimensions map), `metric_key_a/metric_sum_a`, `metric_key_b/metric_sum_b`, `metric_avg_a` (metrics map), `flag_key_a/flag_value_a` (flags map) — all `from_template` with `meta.param_slot` markers

**Checkpoint**: slot members compile and publish through the existing 013 pipeline.

---

## Phase 3: User Story 1 - Canonical dynamic-key syntax (P1)

**Goal**: `Cube.<map>.<key>` rewritten pre-validation onto slots + injected key filters. FR-001, FR-003, FR-004.

### Tests first (must fail)

- [X] T105 [P] [US1] Unit tests for the R3 rule in `services/cubejs/src/utils/__tests__/defaultModelRules.test.js` (extend 013 suite): single key rewrite (dimension + injected `dim_key_a` filter), two keys of one map → slots a+b, key in a filter/timeDimension slot, mixed with declared members, THREE distinct keys of one map → `DYNAMIC_KEY_SLOTS_EXHAUSTED` rejection listing the limit, metrics key → measure slot with sum, flags key → boolean slot, no dynamic refs → byte-identical pass-through, idempotence (rewriting a rewritten query is a no-op), FR-004: rewritten query ALWAYS carries the key filter
- [X] T106 [P] [US1] Unit tests for slot-registry extraction in `services/cubejs/src/utils/__tests__/defaultModelMeta.test.js`: `buildMemberMap` surfaces `meta.param_slot` members as a per-cube slot registry `{map → {dimensionSlots:[{key,value}], measureSlots:[...], flagSlots:[...]}}`; cubes without slots yield an empty registry

### Implementation

- [X] T107 [US1] Extend `buildMemberMap` in `services/cubejs/src/utils/defaultModelMeta.js` with the slot registry — until T106 passes
- [X] T108 [US1] Implement R3 in `services/cubejs/src/utils/defaultModelRules.js`: detect `Cube.<map>.<key>` references (member map knows the map columns via slot registry), allocate slots deterministically (stable key→slot ordering), rewrite member refs + inject key filters, reject on exhaustion — until T105 passes
- [X] T109 [US1] StepCI: publish slot-bearing template → reconcile team → REST query `SemanticEvents.dimensions.<key>` returns grouped values; two-key query returns independent values (SC-004); 3-key query → 400 `DYNAMIC_KEY_SLOTS_EXHAUSTED` — in `tests/workflows/default-models/dynamic-access.yml`

**Checkpoint**: US1 scenarios 1–4 pass E2E.

---

## Phase 4: User Story 2 - Dynamic property discovery (P1)

**Goal**: filter-scoped, team-scoped, cached, member-shaped directory. FR-005..007.

### Tests first (must fail)

- [X] T110 [P] [US2] Unit tests for probe builders + shaping in `services/cubejs/src/utils/__tests__/dynamicPropertyProbe.test.js`: map probe SQL (mapKeys/arrayJoin, partition + user filter scoping, key-name escaping against injection), JSON probe SQL (JSONAllPaths + dynamicType distribution), result shaping into member-form entries (name `Cube.<map>.<key>`, kind dimension/measure/segment by map value type, occurrence/coverage/cardinality/sampleValues bounded by `DYNAMIC_META_SAMPLE_VALUES`, `query.rest` + `query.sql` forms), TTL cache hit/expiry/keying by (partition, cube, targets, filter-hash, schemaVersion)
- [X] T111 [P] [US2] Route-level tests in `services/cubejs/src/routes/__tests__/dynamicMeta.test.js` (deps-injected like 013's worker): auth required, filter pass-through to probes, empty partition → empty directory (not error), response carries generatedAt + ttl

### Implementation

- [X] T112 [US2] Implement `services/cubejs/src/utils/dynamicPropertyProbe.js` — until T110 passes
- [X] T113 [US2] Implement `services/cubejs/src/routes/dynamicMeta.js` (`POST /api/v1/meta/dynamic`, body `{cube, filters?, targets?}`), mount checkAuth-gated in `services/cubejs/src/routes/index.js`; driver via `cubejs.options.driverFactory({securityContext})` (013 worker pattern) — until T111 passes
- [X] T114 [US2] StepCI additions to `dynamic-access.yml`: discovery filtered to one event lists exactly that event's keys with member-shaped entries; repeat call within TTL returns identical payload fast; second team's JWT gets only its own directory (SC-006); JSON target lists paths with dominant types

**Checkpoint**: discovery→compose→query loop closes (SC-001).

---

## Phase 5: User Story 3 - Event-scoped explicit templates (P2)

**Goal**: `field_policy: explicit` prune-only generation + event-scoped sources. FR-008, FR-009.

### Tests first (must fail)

- [X] T115 [P] [US3] Unit tests in `services/cubejs/src/utils/smart-generation/__tests__/templateMode.test.js` (extend): explicit policy → probe fields NEVER added (SC-003), registry member with key absent from profile → pruned, present → kept, default policy unchanged (013 regression guard), event-scoped template → pruning probe receives the event filter

### Implementation

- [X] T116 [US3] Implement explicit mode in `buildCubesFromTemplate` (`services/cubejs/src/utils/smart-generation/cubeBuilder.js`): read `meta.field_policy`, prune `meta.registry_key`/`registry_path` members against the profile, add nothing; thread the template's event filter into the worker's probe call in `services/cubejs/src/routes/reconcileTeam.js` — until T115 passes
- [X] T117 [US3] StepCI: event-scoped explicit template rolls out via the standard 013 flow; team's derived cube contains exactly registry∩data members; registry edit propagates through staged rollout — extend `dynamic-access.yml`

---

## Phase 6: User Story 4 - JSON registry members (P3)

- [X] T118 [P] [US4] Unit tests: `registry_path: properties.<path> (<type>)` generates a member with explicit cast (`toString(...)`/`.:Float64` per registered type); unregistered paths generate nothing; pruning uses JSON path presence — extend `templateMode.test.js` (write first)
- [X] T119 [US4] Implement JSON registry member generation in `cubeBuilder.js` explicit mode — until T118 passes

---

## Phase 7: Polish & Examples (FR-012)

- [X] T120 Validate every example in `examples.md` against the dev stack (discovery → compose → query for map dim, map measure, flag, JSON path; SQL API variants); fix doc/behavior drift (SC-005)
- [X] T121 [P] Measure SC-001/SC-002 (cold + warm discovery timings, end-to-end compose loop) and record in examples.md footnotes
- [X] T122 [P] Update CLAUDE.md Key File Locations (dynamicMeta route, dynamicPropertyProbe, R3 in defaultModelRules) and the 013 preprocessor contract note (R3 added to the fixed rule set)

---

## Dependencies

- T102 gates EVERYTHING (assumption spike). Phase 2 → US1 → (US2 parallel with US1 after T104; discovery does not need R3). US3 → US4. Polish last.
- Files shared with 013 (defaultModelRules, defaultModelMeta, cubeBuilder, reconcileTeam): all 013 suites must stay green after every phase (regression guard is part of each checkpoint).

**Task count**: 22.
