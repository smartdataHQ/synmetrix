# Tasks: Dynamic Model Creation

**Input**: Design documents from `/specs/004-dynamic-model-creation/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included per Constitution Principle III (TDD is non-negotiable). Write tests first, ensure they fail before implementation.

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Exact file paths included in descriptions

---

## Phase 0: Dev Environment Prerequisite

**Purpose**: Ensure the dev ClickHouse server is reachable and a datasource is configured

- [ ] T000 Verify `dev-clickhouse` (`100.87.250.36`) is reachable via Tailscale, confirm a ClickHouse datasource pointing to `cst` database exists in Synmetrix, and verify `cst.semantic_events` is queryable. This table is the primary test target for all integration tests and manual verification — it contains Map columns, Array columns, scalar types, and partitioned data exercising all profiling code paths.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Database migration, Hasura metadata, and project scaffolding

- [x] T001 Create Hasura migration `{timestamp}_add_teams_settings_column` with up.sql and down.sql in `services/hasura/migrations/`
- [ ] T002 Apply migration and verify with `./cli.sh hasura cli "migrate status"`
- [x] T003 [P] Add new GraphQL types (ProfileTableOutput, ProfiledColumnOutput with lc_values field, ArrayCandidateOutput, ArrayJoinInput, UpdateTeamSettingsOutput) to `services/hasura/metadata/actions.graphql`
- [x] T004 [P] Add new action definitions (profile_table, smart_gen_dataschemas, update_team_settings) with camelCase handler URLs matching RPC filenames to `services/hasura/metadata/actions.yaml`
- [x] T005 Add `settings` column to teams table select and update permissions in `services/hasura/metadata/tables.yaml`
- [x] T006 Create `services/cubejs/src/utils/smart-generation/` directory structure

**Checkpoint**: Database schema updated, Hasura actions registered, project scaffolding ready

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core utility modules and security context extensions that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

### Tests for Foundational

- [ ] T007 [P] Write unit tests for ClickHouse type parser covering: basic types, LowCardinality wrapping, Nullable wrapping, Map(K,V), Array(T), Nested/Grouped (dotted column names), nested combinations like `LowCardinality(Nullable(Array(Map(String, Float64))))`, and ValueType resolution — in `services/cubejs/src/utils/smart-generation/__tests__/typeParser.test.js`
- [ ] T008 [P] Write unit tests for field processors covering: string→dimension, number→measure(sum), date→dimension(time), UUID→dimension(string), boolean→dimension, Map key expansion (string values→dimensions, numeric values→measures), Nested/Grouped column handling (dotted names→prefixed fields), field name sanitization, and name collision disambiguation — in `services/cubejs/src/utils/smart-generation/__tests__/fieldProcessors.test.js`

### Implementation for Foundational

- [x] T009 [P] Implement ClickHouse type string parser (recursive type parsing, annotation peeling, ColumnType/ValueType classification, Nested/Grouped via dotted column name detection) in `services/cubejs/src/utils/smart-generation/typeParser.js`
- [x] T010 [P] Implement field processors (BasicFieldProcessor, MapFieldProcessor, ArrayFieldProcessor, NestedFieldProcessor, FieldProcessorFactory) with column→dimension/measure classification in `services/cubejs/src/utils/smart-generation/fieldProcessors.js`
- [x] T011 Extend `findUser()` GraphQL query in `services/cubejs/src/utils/dataSourceHelpers.js` to include `team.settings` in the user resolution query
- [x] T012 Extend `defineUserScope()` in `services/cubejs/src/utils/defineUserScope.js` to extract `partition` and `internal_tables` from team settings and pass through to security context
- [x] T013 Extend `buildSecurityContext()` in `services/cubejs/src/utils/buildSecurityContext.js` to include partition in the context hash for cache isolation
- [x] T014 Add `profileTable(params)` and `smartGenerate(params)` methods to `services/actions/src/utils/cubejsApi.js` with 180s timeout (matching existing `/generate-models` timeout config at line 155-159)

**Checkpoint**: Foundation ready — type parsing, field classification, and security context threading work. User story implementation can begin.

---

## Phase 3: User Story 1 — Profile and Generate Smart Models (Priority: P1) MVP

**Goal**: Users can select a ClickHouse table, trigger "Smart Generate", see a profiling summary with real-time progress, and get a rich YAML model with auto-tagged fields and Map key expansion.

**Independent Test**: Select a ClickHouse table with Map and scalar columns → trigger smart generation → verify output model has correct dimensions/measures, Map key fields, `meta.auto_generated` tags, and provenance metadata.

### Tests for User Story 1

- [ ] T015 [P] [US1] Write unit tests for profiler: schema analysis pass (DESCRIBE TABLE parsing), data profiling pass (batched SQL generation for basic/Map/Array columns), empty column filtering, batch failure fallback, sampling behavior (SAMPLE clause applied when row count exceeds threshold, results still accurate for cardinality/Map keys/LC values) — in `services/cubejs/src/utils/smart-generation/__tests__/profiler.test.js`
- [ ] T016 [P] [US1] Write unit tests for cube builder: ProfiledTable→cube object conversion, Map key expansion into separate fields, provenance metadata embedding, empty column exclusion, max Map key limit enforcement, filename convention (`{table_name}.yml`) — in `services/cubejs/src/utils/smart-generation/__tests__/cubeBuilder.test.js`
- [ ] T017 [P] [US1] Write unit tests for YAML generator: cube object→valid YAML serialization, `meta.auto_generated` tags on all fields, provenance metadata at cube level, field name sanitization in output — in `services/cubejs/src/utils/smart-generation/__tests__/yamlGenerator.test.js`
- [ ] T018 [P] [US1] Write unit tests for SSE progress emitter: event format validation (`progress`, `complete`, `error` events), no-op mode when Accept header is not `text/event-stream`, proper SSE framing (`event:` + `data:` + `\n\n`) — in `services/cubejs/src/utils/smart-generation/__tests__/progressEmitter.test.js`

### Implementation for User Story 1

- [x] T019 [US1] Implement ClickHouse table profiler — **port from `cxs-inbox/cube/profile_table.py`** with same SQL patterns and output shape (two-pass: DESCRIBE TABLE + batched SELECT aggregations, 10 columns per batch with fallback, Map key discovery via `groupUniqArrayArray(mapKeys())`, column filtering for empty data, **sampling via ClickHouse `SAMPLE` clause when table exceeds row count threshold per FR-028** — report sample size in profiling summary). Improvements over prototype: modular JS, per-column error handling, SSE progress hooks, existing_model lookup, sampling — in `services/cubejs/src/utils/smart-generation/profiler.js`
- [x] T020 [US1] Implement cube builder — **port from `cxs-inbox/cube/generate_cube_from_profile.py`** with same field classification rules and output shape (convert ProfiledTable to cube JS objects using field processors, embed provenance metadata, enforce max Map key limit of 500, detect field name collisions, use `{table_name}.yml` filename convention per Decision 9). Improvements: modular processors, provenance metadata, auto_generated tagging — in `services/cubejs/src/utils/smart-generation/cubeBuilder.js`
- [x] T021 [US1] Implement YAML generator (serialize cube objects to Cube.js YAML via `yaml.stringify()`, add `meta.auto_generated: true` to all fields, add cube-level provenance meta with source_database/source_table/generated_at) in `services/cubejs/src/utils/smart-generation/yamlGenerator.js`
- [x] T022 [US1] Implement SSE progress emitter utility (standardized event format with `progress`, `complete`, `error` events; no-op mode when Accept header is not `text/event-stream`; proper SSE framing with `Content-Type: text/event-stream` and keep-alive) in `services/cubejs/src/utils/smart-generation/progressEmitter.js`
- [x] T023 [US1] Implement CubeJS route `POST /api/v1/profile-table` (accept `branchId` in request, create driver, fetch existing dataschemas on branch to populate `existing_model` info — file_name, file_format, has_user_content, supports_reprofile, suggested_merge_strategy — run profiler with progress events for schema analysis and each profiling batch, return ProfiledTable JSON with existing_model — supports SSE when `Accept: text/event-stream`) in `services/cubejs/src/routes/profileTable.js`
- [x] T024 [US1] Implement CubeJS route `POST /api/v1/smart-generate` (profile table, build cubes, generate YAML, fetch existing schemas, compute clean checksum against full merged file content — do NOT reuse existing `generateDataSchema.js` checksum pattern which has a `cur.code` vs `content` field inconsistency — skip if identical per FR-014 and return `changed: false`, create new version, purge compiler cache, emit progress events throughout, return `version_id` + `file_name` + `changed` in response — supports SSE when `Accept: text/event-stream`) in `services/cubejs/src/routes/smartGenerate.js`
- [x] T025 [US1] Register both new routes in `services/cubejs/index.js`
- [x] T026 [P] [US1] Implement Actions RPC handler `profileTable.js` (thin proxy to CubeJS `/api/v1/profile-table`) in `services/actions/src/rpc/profileTable.js` — CRITICAL: pass `branchId` into the `cubejsApi()` constructor (not just the POST body) so CubeJS security context resolves the correct branch. See Decision 10 for the pre-existing branch-scoping mismatch in `genSchemas.js`.
- [x] T027 [P] [US1] Implement Actions RPC handler `smartGenSchemas.js` (thin proxy to CubeJS `/api/v1/smart-generate`) in `services/actions/src/rpc/smartGenSchemas.js` — CRITICAL: same `branchId` constructor pattern as T026. The security context, schema reads, merge, and version write MUST all target the same branch.
- [ ] T028 [US1] Add ProfileTable query and SmartGenDataSchemas mutation to `../client-v2/src/graphql/gql/datasources.gql`
- [ ] T029 [US1] Run `yarn codegen` in client-v2 to generate TypeScript types and URQL hooks
- [ ] T030 [US1] Add `useProfileTableQuery` and `useSmartGenDataSchemasMutation` to `../client-v2/src/hooks/useSources.ts`
- [ ] T031 [US1] Add "Smart Generate" option as a dedicated flow in `../client-v2/src/components/DataModelGeneration/index.tsx` (visible only for ClickHouse datasources, shows informative message for other types, single-table selection — does NOT modify existing standard generation or YAML/JS radio)
- [ ] T032 [US1] Add profiling summary preview view to DataModelGeneration component (shows column count, row count, Map keys discovered, primary keys detected, existing model info from `existing_model` response field — if `file_format` is `"js"` show warning about coexisting JS/YAML files — displayed between step 1 profile and step 2 generate confirmation)
- [ ] T033 [US1] Add SSE progress indicator to smart generation flow in `../client-v2/src/components/DataModelGeneration/index.tsx` (connect to CubeJS `/api/v1/profile-table` and `/api/v1/smart-generate` via `fetch()` + `ReadableStream` with JWT auth, display step name and progress bar during profiling and generation, fall back to Hasura Action path if SSE fails)
- [ ] T034 [US1] Implement two-step smart generation flow in `../client-v2/src/pages/Models/index.tsx` (step 1: call profile-table SSE endpoint → show preview with progress, step 2: call smart-generate SSE endpoint → refresh version → open model in editor — requires new state machine, NOT the existing single-mutation-then-close pattern at line 532)
- [ ] T035 [US1] Write StepCI integration test for `profile_table` and `smart_gen_dataschemas` actions (happy path against `dev-clickhouse` / `cst.semantic_events`, error path with non-ClickHouse datasource) in `tests/`

**Checkpoint**: Smart generation works end-to-end with real-time progress feedback. Users can profile a ClickHouse table and generate a rich YAML model with auto-tagged fields and Map key expansion.

---

## Phase 4: User Story 2 — Re-Profile and Smart Merge (Priority: P1)

**Goal**: Users can re-profile an existing smart-generated model. Auto-generated fields update/add/remove based on new profiling. User-created fields and user-edited descriptions are never touched.

**Independent Test**: Generate a model → add custom fields → edit descriptions on auto fields → re-profile → verify custom fields intact, descriptions preserved, new Map keys added, removed keys gone.

### Tests for User Story 2

- [ ] T036 [P] [US2] Write unit tests for merger covering all 4 merge strategies: `"auto"` (user content detection → merge or replace), `"merge"` (field update/add/remove, user field preservation, description preservation, joins/pre_aggregations/segments preservation), `"replace"` (full replacement), `"merge_keep_stale"` (stale auto fields retained), plus multi-cube merge: cube identity matching by `name` property, auto-generated cube removal when deselected, user-created cube preservation, name collision (user cube wins over auto cube) — in `services/cubejs/src/utils/smart-generation/__tests__/merger.test.js`

### Implementation for User Story 2

- [x] T037 [US2] Implement smart merger with 4 merge strategies per data-model.md: `"auto"` (detect user content → decide), `"merge"` (field-level + cube-level property preservation for joins/pre_aggregations/segments/description), `"replace"` (full replacement), `"merge_keep_stale"` (like merge, skip stale field removal). User content detection: fields without `auto_generated`, edited descriptions, joins/pre_aggregations/segments blocks. Multi-cube merge: match cubes by `name`, remove deselected auto cubes, preserve user cubes, skip auto cube on name collision with user cube — in `services/cubejs/src/utils/smart-generation/merger.js`
- [x] T038 [US2] Integrate merger into `services/cubejs/src/routes/smartGenerate.js` (accept `mergeStrategy` from request, default `"auto"`, pass to merger when existing model found by `{table_name}.yml` convention)
- [ ] T039 [US2] Create provenance parser utility in `../client-v2/src/utils/provenanceParser.ts` (extract source_database, source_table, source_partition from YAML cube-level metadata, detect user content presence for merge option defaults — reusable for re-profile visibility, request construction, and merge UI)
- [ ] T040 [US2] Add "Re-profile" button to `../client-v2/src/components/ModelsSidebar/index.tsx` (visible only for models with provenance metadata, detected via provenanceParser utility)
- [ ] T041 [US2] Add merge options UI to profiling preview in `../client-v2/src/components/DataModelGeneration/index.tsx` (shown when `existing_model` is non-null in profile response: use `has_user_content` for toggle defaults, `suggested_merge_strategy` for initial state — "Preserve custom changes" toggle default ON when `has_user_content: true`, "Keep removed columns" toggle default OFF, confirmation warning when replace chosen on model with user content)
- [ ] T042 [US2] Implement re-profile flow in `../client-v2/src/pages/Models/index.tsx` (use provenanceParser to extract source info, show compact merge options, pass selected `merge_strategy` to smart-generate SSE endpoint with progress, refresh version and reload model in editor)
- [ ] T043 [US2] Write StepCI integration test for merge strategies (generate model, add custom field + joins, test re-profile with `"merge"` preserves everything, test with `"replace"` discards everything, test `"merge_keep_stale"` retains removed columns) in `tests/`

**Checkpoint**: Re-profiling works with user-controlled merge strategies. Auto fields update safely, user fields are never touched unless user explicitly chooses replace. Both US1 and US2 are independently functional.

---

## Phase 5: User Story 3 — ARRAY JOIN Flattened Cube Generation (Priority: P2)

**Goal**: Smart generation detects Array-typed columns, presents them as ARRAY JOIN candidates in the profiling summary, and generates separate flattened cubes for user-selected arrays.

**Independent Test**: Profile a table with Array columns → select one for flattening → verify output includes a separate cube with `LEFT ARRAY JOIN` SQL and expanded element fields.

### Tests for User Story 3

- [ ] T044 [P] [US3] Write unit tests for ARRAY JOIN extensions: profiler array detection and sub-field profiling, cube builder flattened cube generation with `LEFT ARRAY JOIN` SQL, YAML generator multi-cube serialization, field name collision avoidance between raw and flattened cubes — in `services/cubejs/src/utils/smart-generation/__tests__/arrayJoin.test.js`

### Implementation for User Story 3

- [ ] T045 [US3] Extend profiler in `services/cubejs/src/utils/smart-generation/profiler.js` to detect Array-typed columns, profile array sub-fields, and return array_candidates with suggested aliases
- [ ] T046 [US3] Extend cube builder in `services/cubejs/src/utils/smart-generation/cubeBuilder.js` to generate flattened cubes (one per selected array join column) with `LEFT ARRAY JOIN` custom SQL, expanded element fields, and no field name collisions with raw cube
- [ ] T047 [US3] Extend YAML generator in `services/cubejs/src/utils/smart-generation/yamlGenerator.js` to serialize multi-cube output (raw + flattened cubes in single YAML file)
- [ ] T048 [US3] Add array candidate checkboxes with alias inputs to profiling summary preview in `../client-v2/src/components/DataModelGeneration/index.tsx`
- [ ] T049 [US3] Pass selected `array_join_columns` from frontend preview to SmartGenDataSchemas mutation in `../client-v2/src/pages/Models/index.tsx`
- [ ] T050 [US3] Write StepCI integration test for ARRAY JOIN generation (smart-generate with `array_join_columns` parameter, verify response includes flattened cube count > 1, verify generated YAML contains `LEFT ARRAY JOIN` SQL) in `tests/`

**Checkpoint**: ARRAY JOIN cubes generate correctly. Users can flatten nested arrays into queryable dimensions/measures.

---

## Phase 6: User Story 4 — Partition-Scoped Profiling and Query Isolation (Priority: P2)

**Goal**: Team owners configure partition and internal tables for their team. Profiling is scoped to the partition. Runtime queries are automatically filtered via `sql` with WHERE clause in the generated model (using `sql` instead of `sql_table`).

**Independent Test**: Configure partition for a team → generate model for internal table → verify profiling uses WHERE clause → verify generated YAML uses `sql` (not `sql_table`) with partition WHERE clause → query the model → verify partition filter applies regardless of user role.

### Tests for User Story 4

- [ ] T051 [P] [US4] Write unit tests for partition isolation: profiler partition scoping (WHERE clause generation for internal tables), YAML generator `sql` vs `sql_table` selection (uses `sql` with WHERE clause instead of `sql_table` when table is internal and partition configured), verify partition SQL is regenerated on re-profile — in `services/cubejs/src/utils/smart-generation/__tests__/partition.test.js`

### Implementation for User Story 4

- [ ] T052 [US4] Extend profiler in `services/cubejs/src/utils/smart-generation/profiler.js` to accept partition from security context and add `WHERE partition IN ('{value}')` to all profiling queries when table is internal
- [ ] T053 [US4] Extend YAML generator in `services/cubejs/src/utils/smart-generation/yamlGenerator.js` to use `sql: "SELECT * FROM {schema}.{table} WHERE partition = '{value}'"` instead of `sql_table` when the source table is in the team's `internal_tables` list and a partition value exists (per Decision 8 — `sql_where` is NOT a valid Cube.dev property; use `sql` with WHERE clause instead)
- [x] T054 [US4] Implement Actions RPC handler `updateTeamSettings.js` (validate caller is team owner, update teams.settings JSONB via Hasura GraphQL mutation) in `services/actions/src/rpc/updateTeamSettings.js`
- [ ] T055 [US4] Create `../client-v2/src/graphql/gql/teams.gql` with UpdateTeamSettings mutation and TeamSettings query
- [ ] T056 [US4] Run `yarn codegen` in client-v2 for new teams.gql types
- [ ] T057 [US4] Add `settings` to team GraphQL fragments in `../client-v2/src/graphql/gql/currentUser.gql` and create `../client-v2/src/hooks/useTeamSettings.ts` hook (useTeamSettingsQuery, useUpdateTeamSettingsMutation) — expand team state centrally before building admin UI
- [ ] T058 [US4] Add team settings UI for partition and internal tables configuration (string input for partition, list editor for internal table names) in appropriate admin settings area of client-v2
- [ ] T059 [US4] Write StepCI integration test for update_team_settings (owner succeeds, member rejected) and partition-filtered profiling (verify generated YAML uses `sql` with WHERE clause, not `sql_table`) in `tests/`

**Checkpoint**: Partition isolation works end-to-end — profiling scoped, generated models use `sql` with partition WHERE clause, admin UI functional.

---

## Phase 7: User Story 5 — Low-Cardinality Value Discovery (Priority: P3)

**Goal**: Profiling enumerates actual values for columns with fewer than 200 unique values and embeds them in field metadata for frontend filter support.

**Independent Test**: Profile a table with a low-cardinality column → verify the field's metadata contains the enumerated values.

### Tests for User Story 5

- [ ] T060 [P] [US5] Write unit tests for LC probe: profiler LC value enumeration for basic columns with <200 unique values, per-key LC on Map columns, skip for high-cardinality columns, YAML generator embedding of `lc_values` in field-level `meta` — in `services/cubejs/src/utils/smart-generation/__tests__/lcProbe.test.js`

### Implementation for User Story 5

- [ ] T061 [US5] Extend profiler in `services/cubejs/src/utils/smart-generation/profiler.js` to run LC probe (`arraySort(groupUniqArray(...))`) for columns with `unique_values < 200` and for per-key LC on Map columns
- [ ] T062 [US5] Extend YAML generator in `services/cubejs/src/utils/smart-generation/yamlGenerator.js` to embed `lc_values` in field-level `meta` when LC probe data is available

**Checkpoint**: LC values are captured and available in model metadata for frontend consumption.

---

## Phase 8: User Story 6 — Primary Key Auto-Detection (Priority: P3)

**Goal**: Smart generation automatically detects primary keys from ClickHouse table schema and marks them in the generated model.

**Independent Test**: Generate model for a table with defined primary keys → verify primary_key: true is set on correct dimensions.

### Tests for User Story 6

- [ ] T063 [P] [US6] Write unit tests for primary key detector: query `system.tables` parsing, sorting key fallback, filter to columns with data, integration with cube builder (PK columns get `primary_key: true` and `public: true`) — in `services/cubejs/src/utils/smart-generation/__tests__/primaryKeyDetector.test.js`

### Implementation for User Story 6

- [x] T064 [US6] Implement primary key detector (query `system.tables` for primary key info, fall back to sorting key, filter to columns with sufficient data) in `services/cubejs/src/utils/smart-generation/primaryKeyDetector.js`
- [ ] T065 [US6] Integrate primary key detection into cube builder in `services/cubejs/src/utils/smart-generation/cubeBuilder.js` (mark detected PK columns with `primary_key: true` and `public: true`)

**Checkpoint**: Primary keys auto-detected and marked. All user stories independently functional.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T066 [P] Verify all StepCI integration tests pass together with `./cli.sh tests stepci`
- [ ] T067 [P] Run `yarn codegen` and `yarn lint` in client-v2 to verify no type errors or lint issues
- [ ] T068 Run end-to-end manual verification per `specs/004-dynamic-model-creation/quickstart.md` verification checklist (include SC-001 performance validation: profile+generate <60s for tables with up to 100 columns)
- [ ] T069 [P] Verify non-ClickHouse datasources still work correctly with standard generation (regression check)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3–8)**: All depend on Foundational phase completion
  - US1 and US2 are both P1 but US2 depends on US1 (merger needs models to merge)
  - US3–US6 can start after US1 is complete
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational (Phase 2) — No dependencies on other stories
- **US2 (P1)**: Depends on US1 — needs smart-generate route and models to exist before merge can work
- **US3 (P2)**: Can start after US1 — extends profiler and cube builder with array support
- **US4 (P2)**: Can start after Foundational — partition threading is independent of generation logic, but benefits from US1 being complete for end-to-end testing
- **US5 (P3)**: Can start after US1 — extends profiler with LC probe
- **US6 (P3)**: Can start after US1 — extends cube builder with PK detection

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Utility modules before routes
- Routes before Actions handlers
- Backend before frontend
- Core implementation before integration tests

### Parallel Opportunities

- T003 + T004 (Hasura metadata files) can run in parallel
- T007 + T008 (foundational tests) can run in parallel
- T009 + T010 (type parser + field processors) can run in parallel
- T015 + T016 + T017 + T018 (US1 tests) can run in parallel
- T026 + T027 (US1 Actions handlers) can run in parallel
- T044 + T051 + T060 + T063 (US3/US4/US5/US6 tests) can all start in parallel after US1
- US3, US4, US5, US6 can all start in parallel after US1 completes (if team capacity allows)
- T066 + T067 + T069 (polish verification) can run in parallel

---

## Parallel Example: User Story 1

```text
# Launch all US1 tests together:
Task T015: "profiler unit tests"
Task T016: "cube builder unit tests"
Task T017: "YAML generator unit tests"
Task T018: "SSE progress emitter unit tests"

# After tests written, launch independent modules:
Task T019: "profiler implementation" (depends on T009 typeParser)
Task T020: "cube builder implementation" (depends on T010 fieldProcessors)
Task T021: "YAML generator implementation" (independent)
Task T022: "SSE progress emitter" (independent)

# After routes complete, launch Actions handlers in parallel:
Task T026: "Actions profileTable RPC"
Task T027: "Actions smartGenSchemas RPC"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (migrations, metadata)
2. Complete Phase 2: Foundational (type parser, field processors, security context)
3. Complete Phase 3: User Story 1 (profile + generate + SSE progress + frontend)
4. **STOP and VALIDATE**: Test smart generation end-to-end with a real ClickHouse table
5. Deploy/demo if ready — basic smart generation is immediately useful

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1 → Smart generation works with progress feedback → Deploy/Demo (MVP!)
3. US2 → Re-profiling with merge → Deploy/Demo
4. US3 → ARRAY JOIN cubes → Deploy/Demo
5. US4 → Partition isolation → Deploy/Demo
6. US5 + US6 → LC values + PK detection → Deploy/Demo (polish)
7. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: US1 → US2 (sequential, US2 depends on US1)
   - Developer B: US4 (partition, independent of US1 backend but needs US1 for e2e)
3. After US1 is complete:
   - Developer A: US3 (ARRAY JOIN)
   - Developer B: US5 + US6 (LC values + PK detection)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- Each user story is independently completable and testable
- Constitution III mandates: write tests first, verify they fail, then implement
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- **Prototype port**: The Python prototype at `cxs-inbox/cube/` (`profile_table.py`, `generate_cube_from_profile.py`) is the **proven reference implementation**. The profiler, type parser, field processors, cube builder, and YAML generator MUST be faithful ports of this working code — same SQL patterns, same field classification logic, same output shape — with improvements for modularity, error handling, and the new features (merge, SSE, multi-cube). The prototype's profiling behavior and generated model output are the baseline; do NOT reimagine or simplify the profiling approach. Consult `docs/plans/004-smart-model-generation.md` for detailed profiling SQL patterns.
- Partition isolation uses `sql` with WHERE clause (not `sql_table`) in generated YAML (Decision 8) — `sql_where` is NOT a valid Cube.dev property — `queryRewrite.js` is NOT modified
- Smart-generated files use `{table_name}.yml` naming convention (Decision 9)
- Version checksum (FR-014) uses clean comparison against full merged content, not the existing `generateDataSchema.js` pattern
- Branch scoping: Actions RPC handlers MUST pass `branchId` into `cubejsApi()` constructor (Decision 10). The existing `genSchemas.js` has a pre-existing bug where branchId is only in the POST body, causing CubeJS to resolve the default branch's security context. New handlers must not repeat this mistake.
- SSE progress: CubeJS routes support `Accept: text/event-stream` for real-time progress (FR-027). Frontend connects directly to `/api/v1/*` endpoints for streaming. Hasura Actions remain synchronous (no SSE) for backward compatibility.
- Permissions: CubeJS uses `HASURA_GRAPHQL_ADMIN_SECRET` for internal Hasura calls (see `services/cubejs/src/utils/graphql.js`), bypassing row-level security. This means `createDataSchema` works regardless of the calling user's role. The Hasura Action permission (`role: user`) gates access at the GraphQL layer; the actual write uses admin privileges.
- JS model coexistence: Smart generation always creates `.yml` files. If a `.js` model exists for the same table, the `.yml` is created alongside it (the `.js` file is untouched). The profile response's `existing_model.file_format` field allows the UI to warn about this.
- Multi-cube merge: Cubes are matched by `name` property during merge. Auto-generated cubes removed from re-generation are deleted; user-created cubes are always preserved. Name collisions between user and auto cubes are resolved in favor of the user cube.
