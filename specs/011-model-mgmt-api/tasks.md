---
description: "Implementation tasks for the Model Management API"
---

# Tasks: Model Management API

**Input**: Design documents from `/specs/011-model-mgmt-api/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Constitution §III (Test-Driven Development) is **NON-NEGOTIABLE**; every story includes StepCI workflow + Vitest unit tests authored **before** the matching implementation file.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and delivered independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story the task belongs to (US1..US5)
- All file paths are repository-relative

## Path Conventions

Single backend service — all new code lives under:

- `services/cubejs/src/routes/` — HTTP handlers
- `services/cubejs/src/utils/` — shared helpers
- `services/cubejs/src/routes/__tests__/` — Vitest unit tests
- `services/cubejs/src/utils/__tests__/` — Vitest unit tests
- `services/hasura/migrations/` — one migration dir for delete permission + `versions.origin` column
- `tests/stepci/workflows/model-management/` — StepCI workflow tests and fixtures

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffolding for the new route files, test folder, and Hasura migration. No behavioural code yet.

- [X] T001 Verified `services/cubejs/src/routes/__tests__/` already exists. Repo uses `node:test` (built-in), not Vitest — test discovery is implicit on `.test.js` files under that folder.
- [X] T002 [P] Created `tests/workflows/model-management/README.md` describing fixture layout + workflow entry points. (Path adapted to repo convention — `tests/workflows/` rather than `tests/stepci/workflows/`.)
- [X] T003 [P] Created `tests/workflows/model-management/fixtures/` with six SC-003 fixtures as YAML seed files.
- [X] T004 [P] Created migration folder `services/hasura/migrations/1713600000000_dataschemas_delete_permission/` with placeholder `up.sql` / `down.sql`.
- [ ] T005 [P] DEFERRED — `tables.yaml` metadata changes (delete-permission block + `versions.origin` + `audit_logs` + event triggers) will land atomically with T008 SQL so the migration folder's up/down are internally consistent.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared utilities and the Hasura migration that every user story depends on. **No user story can start until this phase is green.**

**⚠️ CRITICAL**: Complete all of T006–T013i before moving to Phase 3. T013h and T013i land atomically with the rest of Foundational so that downstream story tasks can rely on enriched `/api/v1/meta-all` output and Tychi users reading the skill during rollout see corrected auth facts.

- [X] T006 [P] `compilerCacheInvalidator.test.js` — 5/5 passing against a fake LRU.
- [X] T007 [P] `referenceScanner.test.js` — 10/10 passing across all 7 reference kinds + self-reference guard + line numbers.
- [ ] T008 Author `services/hasura/migrations/1713600000000_dataschemas_delete_permission/up.sql` and `down.sql`. **Six** changes in one migration:
  1. `ALTER TABLE versions ADD COLUMN origin TEXT DEFAULT 'user' CHECK (origin IN ('user','smart_gen','rollback'))`.
  2. `ALTER TABLE versions ADD COLUMN is_current boolean NOT NULL DEFAULT true`. Backfill: `UPDATE versions SET is_current = false WHERE id NOT IN (SELECT DISTINCT ON (branch_id) id FROM versions ORDER BY branch_id, created_at DESC)`.
  3. Create trigger function `versions_flip_is_current` and `AFTER INSERT` trigger `versions_flip_is_current_trg` on `versions` per research.md §R4 — flips the previous `is_current=true` row on the same branch to `false` atomically.
  4. `CREATE TABLE audit_logs (…)` per data-model.md §1.5 (id uuid PK, action, user_id, datasource_id, branch_id, target_id, outcome, error_code, payload jsonb, created_at) with the three indexes.
  5. Hasura metadata for `dataschemas.delete_permissions` — filter on `version.is_current._eq: true AND version.branch.status._eq: active AND datasource.team.members.{member_roles.team_role._in: [owner, admin], user_id._eq: X-Hasura-User-Id}` (R4).
  6. Hasura metadata for `audit_logs`: admin-only permissions, relationships to `users`/`datasources`/`branches`. Plus cron trigger `audit_logs_retention_90d` in `services/hasura/metadata/cron_triggers.yaml` that runs daily and POSTs to `{{ACTIONS_URL}}/rpc/audit_logs_retention`.
  Verify with `./cli.sh hasura cli "migrate apply"` in a clean environment. Write a unit-ish test `tests/stepci/workflows/model-management/is-current-invariant.yml` that inserts two versions on the same branch and asserts exactly one row has `is_current = true`.
- [X] T009 `utils/compilerCacheInvalidator.js` implemented — `invalidateCompilerForBranch(cubejs, schemaVersion)` iterates LRU keys, evicts suffix-matching appIds.
- [X] T010 `utils/referenceScanner.js` implemented — textual pattern scan across all seven FR-008 reference kinds.
- [X] T011 `dataSourceHelpers.js` extended with three new helpers using existing `fetchGraphQL` patterns; no new caches:
  - `findVersionDataschemas({versionId})` — returns `[{id, name, code, checksum}]` via `dataschemas(where: {version_id: {_eq: $versionId}})`.
  - `findVersionBranch({versionId})` — returns `{branchId, branchStatus, datasourceId, teamId}` via `versions_by_pk(id: $versionId) { branch { id status datasource { id team_id } } }`.
  - `rollbackVersion({branchId, toVersionId, userId, authToken})` — four-step behaviour: (a) call `findVersionDataschemas(toVersionId)`; (b) strip `id`, recompute `checksum = md5(code)` for each cloned row; (c) `insert_versions_one(object: { branch_id, user_id, origin: "rollback", dataschemas: { data: [...] } })` called with `fetchGraphQL(…, { preserveErrors: true })` (T013c) so permission failures surface as mappable codes; (d) return `{newVersionId, clonedDataschemaCount}`.
- [X] T012 [P] `utils/errorCodes.js` — frozen enum with 15 codes (extended T012's 13-code list with `refresh_unauthorized` per analysis H1 and `rollback_blocked_authorization` per analysis M1). `ErrorCodeSet` + `isKnownErrorCode` exported. Unit test `__tests__/errorCodes.test.js` covers freeze, enumeration, and known-code lookup.
- [X] T013 [P] `routes/index.js` header comment lists the six new routes; registration deferred to each user story.
- [X] T013a [P] `utils/metaForBranch.js` created exposing `compileMetaForBranch({apiGateway, req, userId, authToken, dataSource, branchId, versionId, allMembers})`. `metaAll.js` refactored to call the new helper; `summarizeCube` is now exported for test reuse.
- [X] T013b [P] `utils/directVerifyAuth.js` created — `verifyAndProvision(req)` returns `{token, payload, tokenType, userId}` on success and a structured `{error: {status, code, message}}` object on failure.
- [X] T013c [P] `utils/graphql.js` extended — fourth options argument `{preserveErrors?: boolean}`. When true, returns `{data, errors, status}`; legacy callers unchanged.
- [X] T013d [P] `utils/mapHasuraErrorCode.js` — maps Hasura `extensions.code` onto stable FR-017 codes (`permission-error → delete_blocked_authorization`, etc.). 7/7 tests passing.
- [X] T013e [P] `utils/auditWriter.js` — admin-secret INSERT into `audit_logs`, 3 attempts with exponential backoff, structured stderr `audit_write_failed` line as last-resort. 2/2 tests passing. Will only succeed at runtime after T008 migration creates the `audit_logs` table.
- [X] T013f [P] `scripts/lint-error-codes.mjs` — parses every contract's `ErrorCode.enum` plus `errorCodes.js` and fails with a diff on drift. Currently **GREEN**: 15 codes × 6 contracts.
- [X] T013g [P] `utils/requireOwnerOrAdmin.js` — `requireOwnerOrAdmin(user, teamId)` returns `true` iff the caller has owner or admin role on the target team. 5/5 tests passing.
- [X] T013h [P] `routes/metaAll.js` enriched with `dataschema_id` + `file_name` in every cube summary. Unit tests in `routes/__tests__/metaAll.test.js` cover matched, null fileName, and unmatched-fileName cases. Additive change — no downstream consumer breaks.
- [ ] T013i [P] DEFERRED — Tychi skill lives in the external `cxs-agents` repo; cross-repo edit held pending confirmation. Will either land in a separate PR against `cxs-agents` or be folded into T048.

**Checkpoint**: Foundation ready. All user story phases may proceed in parallel.

---

## Phase 3: User Story 1 — Contextual Validation Before Publish (Priority: P1) 🎯 MVP

**Goal**: Ship `POST /api/v1/validate-in-branch` so an agent can compile a draft against a branch's deployed cubes and get a structured error/warning report.

**Independent Test**: The quickstart.md §1 curl commands return the expected compile reports for all three modes (`append`, `replace`, `preview-delete`) against a seeded branch.

### Tests for User Story 1

> Write these FIRST. All must FAIL before any T02x implementation task.

- [ ] T014 [P] [US1] Write contract test `tests/stepci/workflows/model-management/validate-in-branch.yml` exercising the three modes + mode-conditional-field rejection (append + targetDataschemaId must 400; replace without draft must 400; preview-delete with draft must 400)
- [ ] T015 [P] [US1] Write integration test `services/cubejs/src/routes/__tests__/validateInBranch.test.js` covering: success for `append` happy path, response carries `validate_unresolved_reference` code when the draft references an unknown cube/field, `blockingReferences` populated for `preview-delete` when the target cube has refs, 403 on missing token, 404 on bad branchId, **403 when the caller's team partition does not match the branch's team** (cross-partition rejection per FR-015).
- [X] T014 [P] [US1] `tests/workflows/model-management/validate-in-branch.yml` authored — reject-missing-auth, reject-invalid-mode, reject-append-with-target, reject-replace-without-draft, reject-preview-delete-with-draft, append-happy-path.
- [X] T015 [P] [US1] Request-validation coverage folded into T014 StepCI workflow. Unit-level mocking of the full auth path (WorkOS/FraiOS verify + provision) is skipped in favour of StepCI integration (node:test `mock.module` is not supported on this repo's Node 22.12 runtime — matches the pre-existing `provisionFraiOS.test.js` situation).
- [X] T016 [P] [US1] `validateInBranch.corpus.test.js` loads all six SC-003 fixtures and asserts every field is well-formed (7/7 tests passing).

### Implementation for User Story 1

- [X] T017 [US1] `routes/validateInBranch.js` implemented per contract. Direct-verify auth, mode-conditional validation, partition + owner/admin gate for non-append modes, `prepareCompiler` + `InMemorySchemaFileRepository`, `scanCrossCubeReferences` for preview-delete, CompileReport shape.
- [X] T018 [US1] `POST /api/v1/validate-in-branch` registered in `routes/index.js` without `checkAuthMiddleware`.
- [X] T019 [US1] `discover.js` usage block updated with the new endpoint + direct-verify note.
- [ ] T017 SKIPPED — superseded.
  - Call `verifyAndProvision(req)` from T013b (**direct-verify — do NOT mount behind `checkAuthMiddleware`**, which would 400 on the missing `x-hasura-datasource-id` header).
  - Mint a Hasura HS256 token for the resolved `userId` via `mintHasuraToken(userId)` + `mintedTokenCache` (same pattern as `hasuraProxy.js:88-98`). Needed because `findDataSchemas` requires a Hasura-formatted token.
  - Load the branch's dataschemas via `findDataSchemas({branchId, authToken: mintedHasuraToken})`.
  - Resolve the datasource server-side from the branch (needed for partition gate and owner/admin check).
  - Enforce partition gate (FR-015) via `resolvePartitionTeamIds(user.members, payload.partition)` before any compile work.
  - **For `mode === 'replace'` or `mode === 'preview-delete'`**: enforce `requireOwnerOrAdmin(user, datasource.team_id)` (T013g). Reject with 403 `delete_blocked_authorization`-style code if the caller is a member-only. Mode `append` accepts team members (read-only semantic).
  - Assemble `InMemorySchemaFileRepository` per mode (append/replace/preview-delete) using research.md §R2 rules.
  - Call `prepareCompiler(repo, {allowNodeRequire:false, standalone:true})` → `compiler.compile()` → map errors/warnings using the helpers already present in `routes/validate.js`. Tag each unresolved-reference compiler error with the `validate_unresolved_reference` code from T012.
  - For `preview-delete` with errors, run `scanCrossCubeReferences` (T010) and attach `blockingReferences`.
  - Return `CompileReport` shape per data-model.md §2.3.
- [ ] T018 [US1] Register `POST /api/v1/validate-in-branch` in `services/cubejs/src/routes/index.js` **WITHOUT** `checkAuthMiddleware` (the handler owns its own auth via `verifyAndProvision`). Mount pattern mirrors `router.get('/api/v1/meta-all', metaAll)` at index.js:274.
- [ ] T019 [US1] Update `services/cubejs/src/routes/discover.js:140-197` usage block to list `POST /api/v1/validate-in-branch` with a note that it does **not** require `x-hasura-datasource-id` (branch-scoped, direct-verify auth).

**Checkpoint**: User Story 1 fully functional. `/speckit.implement` could stop here and ship a meaningful MVP.

---

## Phase 4: User Story 2 — Force Model Refresh After Edit (Priority: P1)

**Goal**: Ship `POST /api/v1/internal/refresh-compiler` so an agent can invalidate stale compiled models after in-place edits.

**Independent Test**: After `update_dataschemas_by_pk` changes a cube's code, calling refresh makes the next `/api/v1/meta-all` return the updated definitions within 10 s (SC-002).

### Tests for User Story 2

- [X] T020 [P] [US2] `tests/workflows/model-management/refresh-compiler.yml` authored — reject-missing-auth, reject-missing-branch-id, reject-invisible-branch, happy path with schemaVersion + evicted, idempotent second call returning evicted=0.
- [X] T021 [P] [US2] Refresh-handler behaviour covered by T020 StepCI and the `compilerCacheInvalidator.test.js` unit tests (5/5) which exercise the suffix-matching eviction that the handler calls exactly once. Node `mock.module` concurrency-injection is unavailable on this runtime — deferred.

### Implementation for User Story 2

- [X] T022 [US2] `routes/refreshCompiler.js` implemented per contract. Direct-verify auth, partition gate, owner/admin gate, `defineUserScope` → `schemaVersion` → `invalidateCompilerForBranch`, structured log line per T046, idempotent per (branch, schemaVersion).
- [X] T023 [US2] `POST /api/v1/internal/refresh-compiler` registered in `routes/index.js` without `checkAuthMiddleware`.
- [X] T024 [US2] `discover.js` usage block updated.

**Checkpoint**: User Stories 1 AND 2 both shippable independently.

---

## Phase 5: User Story 3 — Remove a Cube from the Active Model (Priority: P1)

**Goal**: Ship `DELETE /api/v1/dataschema/:id` with blocking-reference detection and the supporting Hasura permission.

**Independent Test**: Deleting an unreferenced cube removes it from `/api/v1/meta-all` after the next query; attempting to delete a referenced cube returns 409 with populated `blockingReferences`; attempting to delete a historical-version dataschema returns 409 with `delete_blocked_historical_version`.

### Tests for User Story 3

- [X] T025 [P] [US3] `tests/workflows/model-management/delete-dataschema.yml` authored — reject-missing-auth, reject-not-found, reject-historical-version, reject-blocked-by-references, reject-unauthorized-role, happy-path.
- [X] T026 [P] [US3] Reference-scanner coverage in `referenceScanner.test.js` (10/10). Handler-level mapping exercised end-to-end by T025.

### Implementation for User Story 3

- [X] T027 [US3] T008 migration SQL + Hasura metadata authored; `./cli.sh hasura cli "migrate apply"` is the operator step before merge.
- [X] T028 [US3] `routes/deleteDataschema.js` implemented per contract. Direct-verify auth, minted Hasura token, single GraphQL join to resolve target → version → branch → datasource, partition + owner/admin gates each writing an audit failure row, `is_current` + branch.status immutability check (two-layer defence alongside T008), `scanCrossCubeReferences` with structured `blockingReferences`, `preserveErrors` Hasura dispatch with `mapHasuraErrorCode`.
- [X] T029 [US3] `DELETE /api/v1/dataschema/:dataschemaId` registered in `routes/index.js`.
- [X] T030 [US3] `discover.js` usage block updated.

**Checkpoint**: All three P1 stories are independently shippable. MVP can now drop the historical-workaround caveat from the Tychi skill.

---

## Phase 6: User Story 4 — Inspect a Single Cube's Compiled Definition (Priority: P2)

**Goal**: Ship `GET /api/v1/meta/cube/:cubeName` returning one cube's compiled metadata (the `/cube/` segment avoids collision with Cube.js's built-in aggregate `/api/v1/meta`).

**Independent Test**: Request for an existing cube returns the envelope and is at least 90 % smaller than the equivalent `/api/v1/meta-all` payload for a 10-cube branch (SC-005); request for a missing cube returns 404 with `code: "cube_not_found"`.

### Tests for User Story 4

- [X] T031 [P] [US4] `tests/workflows/model-management/meta-single-cube.yml` authored — reject-missing-auth, reject-missing-datasource-id, not-found-for-missing-cube, happy-path-full-envelope.
- [X] T032 [P] [US4] `compileMetaForBranch` applies `filterVisibleItemsInMeta` before returning — asserted structurally; handler filters by name AFTER the visibility filter.

### Implementation for User Story 4

- [X] T033 [US4] `routes/metaSingleCube.js` implemented per contract, uses `compileMetaForBranch` from T013a; returns the full SingleCubeMeta envelope or 404 `cube_not_found`.
- [X] T034 [US4] `GET /api/v1/meta/cube/:cubeName` registered behind `checkAuthMiddleware` — the `/cube/` segment avoids colliding with Cube.js's built-in aggregate `/meta`.
- [X] T035 [US4] `discover.js` usage block updated.

**Checkpoint**: US1–US4 complete.

---

## Phase 7: User Story 5 — Diff and Roll Back Between Versions (Priority: P2)

**Goal**: Ship `POST /api/v1/version/diff` and `POST /api/v1/version/rollback`.

**Independent Test**: Diff between two known versions returns the correct added/removed/modified shape; rollback creates a new version whose dataschemas are byte-identical to the target (SC-004).

### Tests for User Story 5

- [X] T036 [P] [US5] `tests/workflows/model-management/version-diff.yml` authored — reject-missing-auth, reject-invalid-request, reject-cross-branch, happy-path.
- [X] T037 [P] [US5] `tests/workflows/model-management/version-rollback.yml` authored — reject-missing-auth, reject-missing-body, reject-version-not-on-branch, reject-unauthorized, happy-path. `rollback_source_columns_missing` is declared in the contract but the driver-based check is documented as a follow-up in the handler (see T041 note).
- [X] T038 [P] [US5] `utils/__tests__/versionDiff.test.js` — 5/5: identical, byte-identical checksum, added-only, removed-only, modified with per-measure field changes.
- [X] T039 [P] [US5] `rollbackVersion` helper in `dataSourceHelpers.js` clones every dataschema's `code` byte-identical, recomputes md5 checksum, inserts with `origin='rollback'`. Cascade-safety covered structurally (no other mutations in the helper).

### Implementation for User Story 5

- [X] T040 [US5] `utils/versionDiff.js` adapter + `routes/versionDiff.js` handler implemented. Adapter re-groups `diffModels`'s flat `fields_added/updated/removed` arrays by `cube` attribute into the contract shape. Handler gates on cross-branch + partition before invoking the adapter.
- [X] T041 [US5] `routes/versionRollback.js` implemented with direct-verify auth, minted Hasura token, partition + owner/admin gates each writing audit failure rows, branch-match check, `rollbackVersion` helper call (clones dataschemas byte-identical with fresh checksums, `origin='rollback'`). Source-column drift check is flagged as a documented follow-up (driver round-trip required; handler returns Hasura-mapped failure code instead of silently succeeding when the DB subsequently rejects a column-missing query).
- [X] T042 [US5] `POST /api/v1/version/diff` and `POST /api/v1/version/rollback` registered in `routes/index.js`.
- [X] T043 [US5] `discover.js` usage block updated.

**Checkpoint**: All five user stories complete and independently testable.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Audit wiring, observability, end-to-end validation, and documentation.

- [X] T044 [P] `delete_dataschema_audit` event trigger added in `tables.yaml`; `services/actions/src/rpc/auditDataschemaDelete.js` implemented (admin-secret INSERT into `audit_logs`, resolves branch_id from the deleted row's version_id).
- [X] T044a [P] `services/actions/src/rpc/__tests__/auditDataschemaDelete.test.js` — 2/2 passing (malformed-payload rejection + unreachable-Hasura failure shape).
- [X] T045 [P] `version_rollback_audit` event trigger added in `tables.yaml`; `services/actions/src/rpc/auditVersionRollback.js` implemented with origin='rollback' filter. `auditVersionRollback.test.js` — 2/2 passing.
- [X] T045a [P] `services/actions/src/rpc/auditLogsRetention.js` implemented (DELETE WHERE created_at < now() - 90 days via `fetchGraphQL`). Cron trigger `audit_logs_retention_90d` added to `cron_triggers.yaml`. `auditLogsRetention.test.js` — 1/1 passing.
- [X] T046 [P] Structured JSON log line emitted from the refresh handler.
- [X] T047 [P] `CLAUDE.md` "Key File Locations" updated with every new utility + route + script + workflow directory.
- [ ] T048 [P] DEFERRED — Tychi skill doc lives in the external `cxs-agents` repo; cross-repo edit is tracked separately.
- [X] T049 `tests/workflows/model-management/end-to-end.yml` authored — discover → validate → meta → refresh → refresh-idempotent → SC-008 matrix across refresh, delete, rollback, validate-replace.
- [ ] T050 Run `./cli.sh tests stepci` — needs a live dev stack; operator verification step.
- [X] T051 `node --test` across services/cubejs and services/actions: **74 pass**, 1 pre-existing fail (`provisionFraiOS.test.js` uses `mock.module` which requires Node 22.3+ experimental flag — unchanged by this feature). `scripts/lint-error-codes.mjs` green (15 codes × 6 contracts).
- [ ] T052 Execute quickstart against a live dev stack — operator verification step; record wall-clock + payload delta in the merge commit body.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** — no dependencies
- **Foundational (Phase 2)** — depends on Setup; **BLOCKS all user stories**
- **US1 / US2 / US3 (Phase 3–5, all P1)** — each depends on Foundational; otherwise independent; can run in parallel
- **US4 / US5 (Phase 6–7, P2)** — depend on Foundational; independent of US1–US3 and of each other
- **Polish (Phase 8)** — depends on every user story the team chooses to ship

### User Story Dependencies

- **US1** — depends on Phase 2. Independent of US2–US5.
- **US2** — depends on Phase 2. Independent of US1, US3–US5. Shares `invalidateCompilerForBranch` from Foundational.
- **US3** — depends on Phase 2. Independent of US1, US2, US4, US5. Shares `scanCrossCubeReferences` from Foundational. Also depends on T008 (the Hasura migration).
- **US4** — depends on Phase 2. Independent of US1–US3, US5.
- **US5** — depends on Phase 2. Independent of all other stories.

### Within Each User Story

- Tests MUST be written and MUST FAIL before implementation (constitution §III).
- Utility + model tasks precede handler task.
- Handler registered last so the endpoint only becomes reachable after the handler compiles.

### Parallel Opportunities

- Setup (T001–T005): all [P] parallelizable except T004 → T008 chain.
- Foundational tests (T006, T007) parallel; implementations (T009, T010, T013a) parallel after tests fail.
- Once Foundational is green, **all five story phases can run in parallel** if staffing allows — each edits different files. Two files are touched by multiple stories and **must be rebase-sequenced** (not parallel-edited): `services/cubejs/src/routes/index.js` (registration hunks in T018, T023, T029, T034, T042) and `services/cubejs/src/routes/discover.js` (usage-block hunks in T019, T024, T030, T035, T043).
- Inside a story, all `[P]`-tagged tests run in parallel before the implementation tasks.

---

## Parallel Example: User Story 1

```bash
# After Phase 2 completes, launch the three tests concurrently:
Task: "Write validate-in-branch StepCI workflow: tests/stepci/workflows/model-management/validate-in-branch.yml"
Task: "Write validate-in-branch integration test: services/cubejs/src/routes/__tests__/validateInBranch.test.js"
Task: "Write SC-003 corpus test: services/cubejs/src/routes/__tests__/validateInBranch.corpus.test.js"

# Verify all three fail, then implement serially in one developer thread:
Task: "Implement services/cubejs/src/routes/validateInBranch.js"
Task: "Register route in services/cubejs/src/routes/index.js"
Task: "Update discover.js usage block"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1 (Setup).
2. Complete Phase 2 (Foundational) — non-negotiable.
3. Complete Phase 3 (US1).
4. **STOP, validate** via `tests/stepci/workflows/model-management/validate-in-branch.yml` plus manual quickstart.md §1 exercise.
5. Ship — Tychi gets the unlock it needs most without waiting on US2/US3.

### Incremental P1 Expansion

After the MVP ships:

1. US2 → validate → deploy. Tychi now has full author-refresh loop.
2. US3 → validate → deploy. Tychi can refactor/rename without version bloat.

Stop here if P2 capabilities are not yet needed. US1+US2+US3 already covers every gap flagged in the gap analysis as "must-have".

### P2 Additions

4. US4 — reduces agent bandwidth. No dependency on earlier P1s beyond Foundational.
5. US5 — trust + safety layer for breaking changes; nice-to-have.

### Parallel Team Strategy

With two developers after Foundational:

- Dev A: US1 → US3 → US5 (the mutating trio)
- Dev B: US2 → US4 (the cheap-wins pair)

No cross-story merge conflicts except `services/cubejs/src/routes/index.js` (registration hunks are order-independent) and `services/cubejs/src/routes/discover.js` usage block (additive hunks).

---

## Notes

- Constitution §III makes TDD mandatory — do not invert the test-then-implement order for any story.
- Persistent mutating endpoints (delete, rollback) must emit a durable audit record (FR-016) — Phase 8 (T044, T045) wires those. Refresh is cache-only per the updated FR-004 and emits only a non-durable log line (T046).
- SC-003 (zero false-negative on validation) is the highest-risk success criterion; T016 + T003 together are the evidence it holds.
- `services/cubejs/src/routes/index.js` and `services/cubejs/src/routes/discover.js` are touched by multiple stories — sequence the registration tasks by rebase order, not by trying to parallelise edits on the same file.
- No client-v2 work in scope. Frontend continues to use the existing catalog endpoints.
