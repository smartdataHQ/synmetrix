# Tasks: Dynamic Models II

**Input**: Design documents from `/specs/010-dynamic-models-ii/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Required per Constitution Principle III (TDD — NON-NEGOTIABLE). Test tasks precede implementation tasks in each phase.

**Organization**: Tasks grouped by user story. US1 (filtered introspection) is the MVP. US2+US3 (LLM metrics) form the second increment. US4+US5 (persistence + frontend) complete the feature.

**Incremental delivery note**: FR-007 (LLM enrichment always on) is fully satisfied after US2 completion. During US1-only MVP, LLM enrichment is absent by design.

**Terminology**: "AI metric" = short form. "AI-generated metric" = formal term. Both refer to Cube.js measures/dimensions created by the LLM with `meta.ai_generated: true`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **CubeJS backend**: `services/cubejs/src/`
- **Actions backend**: `services/actions/src/`
- **Hasura metadata**: `services/hasura/metadata/`
- **Frontend**: `../client-v2/src/`

---

## Phase 1: Setup

**Purpose**: Install new dependencies and configure environment

- [x] T001 Install `openai` npm package in `services/cubejs/package.json` (peer dep `zod` already satisfied by `@cubejs-backend/api-gateway` — verify with `npm ls zod`)
- [x] T002 [P] Install `react-querybuilder` in `../client-v2/package.json`
- [x] T003 [P] Add `OPENAI_API_KEY` to `.dev.env` and `docker-compose.dev.yml` (CubeJS service environment)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core utilities and prerequisite fixes that multiple user stories depend on. Tests written first per constitution.

**CRITICAL**: All user stories depend on JS model support (FR-P01–P04). US1 and US2 both depend on filterBuilder. US2 and US3 both depend on llmEnricher and llmValidator.

### 2A: JS Model Support Prerequisites (FR-P01–P04)

These tasks fix the existing codebase to support regeneration, merge, and diff of JS model files — a hard prerequisite for AI metric retention, diff preview, and filter persistence.

- [x] T004 Write tests for JS model parsing at `services/cubejs/src/utils/smart-generation/__tests__/jsModelSupport.test.js` — test cases: merger can parse and merge JS model files (not just YAML) — reuse `parseCubesFromJs()` from diffModels.js which already handles JS via Node's `vm` module; `extractAIMetrics()` works on JS files; `isAutoField` and new `isAIField` helper distinguish the three field categories; `analyzeExistingModel` in profileTable correctly identifies auto_generated and ai_generated fields in JS files (not treating all JS as opaque user content). Note: diffModels already parses JS — no changes needed there.
- [x] T005 Modify `services/cubejs/src/utils/smart-generation/merger.js` — extend `mergeModels()` to parse JS model files by importing and reusing `parseCubesFromJs()` from `diffModels.js` (which already parses JS via Node's `vm` module). When the existing content is JS, parse it with `parseCubesFromJs()` instead of `YAML.parse()`. Add `isAIField(field)` helper checking `field?.meta?.ai_generated === true`. Update merge logic to treat `ai_generated` as third category alongside `auto_generated` and user-created. Add `generation_filters`, `ai_enrichment_status`, `ai_metrics_count` to the provenance key list so they are overwritten (not preserved) on regeneration.
- [x] T006 [P] Modify `services/cubejs/src/utils/smart-generation/diffModels.js` — add `isAIField` check alongside existing `isAutoField`. No JS parsing changes needed (already handles JS via `parseCubesFromJs()`). Export `parseCubesFromJs` so merger.js can reuse it.
- [x] T007 [P] Modify `services/cubejs/src/utils/smart-generation/yamlGenerator.js` — ensure `generateJs()` does NOT stamp `auto_generated: true` on fields that have `ai_generated: true` in their meta. AI fields are a distinct category.
- [x] T008 [P] Modify `services/cubejs/src/routes/profileTable.js` — update `analyzeExistingModel()` to correctly parse JS files for `auto_generated` and `ai_generated` metadata instead of assuming all JS content is user-created.
- [x] T009 [P] Modify `../client-v2/src/components/CodeEditor/index.tsx` — extend regeneration button visibility to include JS model files that are smart-generated (currently YAML-only via `isYamlFile` check). Detect smart-generated JS files by checking for `auto_generated: true` in the file content.

### 2B: New Utility Modules

#### Tests (write FIRST — must FAIL before implementation)

- [x] T010 [P] Write unit tests for filterBuilder at `services/cubejs/src/utils/smart-generation/__tests__/filterBuilder.test.js` — test cases: empty filters returns empty string; single `=` filter returns correct WHERE; multiple filters AND-ed together; `IN` operator with array values; empty `IN` array rejected; `IS NULL`/`IS NOT NULL` with no value; invalid column name throws error; SQL injection attempts are safely escaped (verify no raw value interpolation); max 10 filters enforced; all 11 operators from FR-002 produce valid SQL; numeric values interpolated unquoted; string values single-quoted with internal quotes doubled; date values treated as quoted ISO strings; boolean values mapped to 1/0.
- [x] T011 [P] Write unit tests for llmValidator at `services/cubejs/src/utils/smart-generation/__tests__/llmValidator.test.js` — test cases: valid metric passes; unbalanced parentheses rejected; dangerous SQL keyword (DROP) rejected; invalid template var rejected; valid `{CUBE}` and `{FILTER_PARAMS}` accepted; name collision with profiler field gets `_ai` suffix; invalid Cube.js type rejected (e.g., `type: 'foo'`); all valid measure types accepted (`number`, `sum`, `avg`, `count`, `countDistinct`, etc. per CubeValidator); `{CUBE}.column_name` references validated against profiled table columns — hallucinated column rejected; `source_columns` entries validated as raw ClickHouse column names; empty metrics array returns empty valid array.
- [x] T012 [P] Write unit tests for llmEnricher at `services/cubejs/src/utils/smart-generation/__tests__/llmEnricher.test.js` — test cases: successful call returns `{metrics: [...], status: 'success', model: 'gpt-5.4'}`; timeout returns `{metrics: [], status: 'failed', error: ...}` without throwing; API error returns failed status without throwing; response includes all required fields per Zod schema; existing AI metrics are included in prompt when provided; empty table profile still produces a valid call.

#### Implementation

- [x] T013 Create filter condition builder module at `services/cubejs/src/utils/smart-generation/filterBuilder.js` — export `buildFilterWhereClause(filters, tableColumns)` that takes an array of `{column, operator, value}` conditions, validates columns against the table schema, and returns a SQL WHERE clause string. Type coercion: string values single-quoted with internal quotes doubled; numeric values validated as numbers and interpolated unquoted; date values treated as ISO strings (single-quoted); boolean values mapped to 1/0; `IN`/`NOT IN` values individually coerced per column type; empty `IN` arrays rejected. Support all 11 operators from FR-002. Return empty string if filters array is empty. Throw on invalid column names (FR-004). Enforce max 10 filter conditions.
- [x] T014 [P] Create LLM enricher module at `services/cubejs/src/utils/smart-generation/llmEnricher.js` — export `enrichWithAIMetrics(profiledTable, existingCubes, existingAIMetrics, options)`. Initialize OpenAI client from `OPENAI_API_KEY` env var. Build structured prompt. Instruct LLM to use `type: 'number'` for derived calculations (ratios, percentages, growth formulas) and aggregation types (`sum`, `avg`, etc.) for direct column aggregations. Instruct LLM to populate `source_columns` with raw ClickHouse column names (from the profiled table column list), not generated member names. Use `client.chat.completions.parse()` with `zodResponseFormat` to enforce the response schema. Set 30-second timeout. On failure, return `{metrics: [], status: 'failed', error: message}` — never throw.
- [x] T015 [P] Create LLM validator module at `services/cubejs/src/utils/smart-generation/llmValidator.js` — export `validateAIMetrics(metrics, profilerFields, profiledTableColumns)`. Validate: balanced parentheses/backticks, no dangerous SQL keywords, only allowed template vars, valid Cube.js types per CubeValidator (measures: `number`/`sum`/`avg`/`count`/`countDistinct`/`countDistinctApprox`/`min`/`max`/`runningTotal`/`string`/`boolean`/`time`; dimensions: `string`/`number`/`time`/`boolean`), column reference validation (extract `{CUBE}.col` patterns and verify `col` exists in `profiledTableColumns`), `source_columns` entries validated as raw ClickHouse column names from `profiledTableColumns`, name collision resolution via `_ai` suffix. Return `{valid: [...], rejected: [...reasons...]}`.

**Checkpoint**: Foundation ready — JS model support extended, filter builder, LLM enricher, and LLM validator are independently testable utilities. All tests pass.

---

## Phase 3: User Story 1 — Filtered Table Introspection (Priority: P1) MVP

**Goal**: Users can apply filter conditions during profiling so generated models reflect a data subset.

**Independent Test**: Profile a table with `filters: [{column: "country", operator: "=", value: "US"}]` and verify row_count/cardinality differ from unfiltered profile.

### Tests (write FIRST — must FAIL before implementation)

- [x] T016 [US1] Write integration test at `services/cubejs/src/utils/smart-generation/__tests__/filteredProfiling.test.js` — test cases: profiler with empty filters behaves identically to current behavior; profiler with one filter produces different row_count than unfiltered; partition filter is AND-ed with user filter (not replaced); filters that match zero rows return descriptive error; invalid column name in filter is rejected before any ClickHouse query.

### Implementation

- [x] T017 [US1] Modify `buildWhereClause()` in `services/cubejs/src/utils/smart-generation/profiler.js` — import `buildFilterWhereClause` from `filterBuilder.js`. Accept new `filters` option (array of filter conditions). Compose the result: existing partition WHERE (if any) AND-ed with the filter WHERE (if any). Update all 4 profiler passes (Pass 0 system metadata queries excluded — they don't filter by data; Pass 1 initial profile, Pass 2 deep profile, Pass 3 LC probe) to use the composed WHERE clause. When `filters` is provided, skip the system.parts_columns metadata query (same as partition behavior — metadata is unreliable for subsets). Handle zero-row result: if Pass 1 returns `row_count === 0`, emit an error event and return early with a descriptive message.
- [x] T018 [US1] Modify `services/cubejs/src/routes/profileTable.js` — accept `filters` from `req.body`, normalize (default to empty array if missing/invalid), pass to `profileTable()` options. This endpoint is called directly via SSE from the frontend (bypasses Hasura).
- [x] T019 [US1] Modify `services/cubejs/src/routes/smartGenerate.js` — accept `filters` from `req.body`, normalize, pass to `profileTable()` when profiling (not when using cached `profileData`). Store filters in the cube-level `meta.generation_filters` when calling `createDataSchema()`. On dry-run: do NOT call the LLM — return only profiler-generated field changes. LLM is called only on non-dry-run apply.

**Checkpoint**: Filtered profiling works end-to-end via REST API. Existing behavior unchanged when no filters provided. Tests pass.

---

## Phase 4: User Story 2 — LLM-Generated Metrics and Calculations (Priority: P1)

**Goal**: Every smart generation run enriches the model with AI-generated calculated metrics via OpenAI gpt-5.4.

**Independent Test**: Run smart-generate on a table with date + numeric columns. Verify output model contains measures with `meta.ai_generated: true` beyond the standard count/sum.

### Tests (write FIRST — must FAIL before implementation)

- [x] T020 [US2] Write integration test at `services/cubejs/src/utils/smart-generation/__tests__/llmIntegration.test.js` — test cases: `mergeAIMetrics()` inserts AI metrics into cube dimensions/measures with full meta; AI measures can use any valid CubeValidator type including `number` for derived calculations; `generateJs()` serializes AI metric meta correctly (ai_generated, ai_model, ai_generation_context, ai_generated_at, source_columns); smart-generate route returns `ai_enrichment` status in response; LLM failure results in base model without AI metrics and `ai_enrichment.status === 'failed'`; dry-run does NOT call LLM; simple AI metrics without template vars are also serializable in YAML format.

### Implementation

- [x] T021 [US2] Modify `services/cubejs/src/utils/smart-generation/cubeBuilder.js` — add `mergeAIMetrics(cubes, aiMetrics)` function that takes the profiler-built cubes and validated AI metrics, then inserts AI metrics into the appropriate cube's dimensions/measures arrays. Each AI metric gets full meta: `{ai_generated: true, ai_model, ai_generation_context, ai_generated_at, source_columns}`. Ensure field name uniqueness within each cube.
- [x] T022 [US2] Modify `services/cubejs/src/routes/smartGenerate.js` — after `buildCubes()` and before `generateJs()`, call `enrichWithAIMetrics()` passing the profiled table, built cubes, and empty array for existing AI metrics (first generation). Then call `validateAIMetrics()` on the result. Pass valid metrics to `mergeAIMetrics()`. Add `ai_enrichment` object to the response (`{status, model, metrics_count, error}`). Emit progress events for the LLM step ("Generating AI metrics..."). Skip LLM call entirely when `dryRun === true`.

**Checkpoint**: Smart generation produces AI-enriched models. LLM failures gracefully degrade to base model only. Tests pass.

---

## Phase 5: User Story 3 — LLM Metric Superset on Regeneration (Priority: P1)

**Goal**: On regeneration, the LLM sees prior AI metrics and produces a superset. Stale metrics (dropped columns) are removed.

**Independent Test**: Generate a model, then regenerate — verify all prior AI metrics are retained plus any new ones. Drop a column and regenerate — verify the orphaned AI metric is removed and appears in the diff.

### Tests (write FIRST — must FAIL before implementation)

- [x] T023 [US3] Write unit tests at `services/cubejs/src/utils/smart-generation/__tests__/aiMetricMerge.test.js` — test cases: `extractAIMetrics()` returns only fields with `meta.ai_generated: true`; merger treats `ai_generated` as third category (not auto_generated, not user-created); AI metric with dropped source column is removed; AI metric with valid source columns is retained; user edit to AI metric description is preserved on regeneration; diff output includes `ai_metrics_added`, `ai_metrics_retained`, `ai_metrics_removed`; superset validation force-retains metrics dropped by LLM if source columns still exist.

### Implementation

- [x] T024 [US3] Add `extractAIMetrics(existingModel)` to `services/cubejs/src/utils/smart-generation/merger.js` — parses existing model (YAML or JS) and returns all fields with `meta.ai_generated: true`. Superset rules: AI fields always retained unless source column dropped. User description edits preserved.
- [x] T025 [US3] Modify `services/cubejs/src/utils/smart-generation/diffModels.js` — add `ai_metrics_added`, `ai_metrics_retained`, and `ai_metrics_removed` arrays to the change preview output. Populate `ai_metrics_removed` when an AI metric's `source_columns` reference columns no longer in the profiled table.
- [x] T026 [US3] Modify `services/cubejs/src/routes/smartGenerate.js` — on regeneration (when `findDataSchemas()` returns existing model), call `extractAIMetrics()` to get prior AI metrics. Pass them to `enrichWithAIMetrics()` as `existingAIMetrics` parameter. After LLM returns, run superset validation: for each prior AI metric whose source columns still exist, verify it appears in the LLM output. If any valid metric was dropped by the LLM, force-retain it from the previous model. Include AI metric diff sections in the `change_preview` response.
- [x] T027 [US3] Modify LLM prompt in `services/cubejs/src/utils/smart-generation/llmEnricher.js` — when `existingAIMetrics` is non-empty, append a section to the prompt: "Previously generated metrics (RETAIN ALL unless source columns no longer exist):" followed by the serialized existing AI metrics. Instruct the LLM to return a superset.

**Checkpoint**: Regeneration preserves AI metrics. Stale metrics removed cleanly. User description edits survive. Tests pass.

---

## Phase 6: User Story 4 — Filter Persistence Across Regeneration (Priority: P2)

**Goal**: Filters used during generation are stored in the model and pre-populated on regeneration.

**Independent Test**: Generate with filters, then check the model's `meta.generation_filters` contains the filter array. On regeneration, verify the response includes previous filters.

### Tests (write FIRST — must FAIL before implementation)

- [x] T028 [US4] Write integration test at `services/cubejs/src/utils/smart-generation/__tests__/filterPersistence.test.js` — test cases: generated model's cube meta includes `generation_filters` array matching input filters; `generation_filters` is overwritten (not preserved from old model) on regeneration; profile-table response includes `previous_filters` when existing model has stored filters; profile-table response omits `previous_filters` when no existing model or no stored filters.

### Implementation

- [x] T029 [US4] Modify `services/cubejs/src/routes/smartGenerate.js` — on regeneration, when `findDataSchemas()` returns the existing model, extract `generation_filters` from the existing model's meta and include in the response as `previous_filters` so the frontend can pre-populate the filter builder. (T019 already stores filters in cube-level meta during generation.)
- [x] T030 [US4] Modify `services/cubejs/src/routes/profileTable.js` — when `branchId` is provided and an existing model is found, include `existing_model.meta.generation_filters` (if present) in the response as `previous_filters`. The frontend uses this to pre-populate the filter builder.

**Checkpoint**: Filters round-trip through generation and are available for pre-population. Tests pass.

---

## Phase 7: User Story 5 — Frontend Filter Builder and AI Metrics Display (Priority: P2)

**Goal**: Users can build filters in the UI and see AI-generated metrics distinguished in the model editor.

**Independent Test**: Open smart generation dialog, add filters, run generation, verify filtered results. View generated model in editor, verify AI metrics have visual indicators.

### Contract Updates

- [x] T031 [US5] Add `FilterConditionInput` type and `filters` parameter to `services/hasura/metadata/actions.graphql` — define `input FilterConditionInput { column: String!, operator: String!, value: jsonb }`. The `jsonb` type is the Hasura transport type; the backend normalizes values per data-model.md. Add `filters: [FilterConditionInput]` to the `smart_gen_dataschemas` action input. Add `ai_enrichment` and `previous_filters` to the action output type. Update `services/hasura/metadata/actions.yaml` accordingly.
- [x] T032 [US5] Modify `services/actions/src/rpc/smartGenSchemas.js` — extract `filters` from the action input and pass it through to the CubeJS `/api/v1/smart-generate` call.
- [x] T033 [US5] Update GraphQL mutation in `../client-v2/src/graphql/gql/datasources.gql` — add `$filters: [FilterConditionInput]` variable and `filters: $filters` argument to the `SmartGenDataSchemas` mutation. Add `ai_enrichment` and `previous_filters` to the response selection. Run `yarn codegen` to regenerate TypeScript types.

### Filter Builder UI

- [x] T034 [US5] Create `../client-v2/src/components/SmartGeneration/FilterBuilder.tsx` — build a filter builder component using `react-querybuilder` for logic (rule management, add/remove) with custom Ant Design control elements matching client-v2's existing style. Configure for **flat AND-only mode**: `combinators={[{name: 'and', label: 'AND'}]}` and hide combinator selector (no OR, no nested groups in v1). Reference cxs2 patterns from `cxs2/src/lib/querybuilder/cubeOperators.ts` (type→operator mapping) and `cxs2/src/components/semantic-layer/explore/FilterRow.tsx` (layout). Props: `schema` (table columns from get-schema), `filters` (current filter state), `onChange` (callback). Use Ant Design `Select` for column/operator dropdowns, `Input`/`InputNumber`/`DatePicker` for value based on column type. Map ClickHouse column types to react-querybuilder `dataType` for operator filtering. Support all 11 operators from FR-002. Support add/remove filter rows, max 10 filters. Output is a flat `FilterCondition[]` array (not a rule tree).
- [x] T035 [US5] Integrate FilterBuilder into `../client-v2/src/components/SmartGeneration/index.tsx` — add FilterBuilder between table selection and "Profile Table" button in the Select step. Manage filter state via `useState`. **Fix auto-profiling on reprofile**: when `initialTable`/`initialSchema` are provided (reprofile flow), change the `useEffect` at ~line 865 to NOT auto-start profiling. Instead: (1) accept `previousFilters` as a prop (the parent component passes it from the last smart-generate response or from the model's `meta.generation_filters` parsed by the existing model analysis in the profile-table response), (2) populate the filter builder with those filters, (3) set step to `"select"` instead of `"profiling"` so the user sees and can edit filters before clicking "Profile Table". Pass filters to the profile-table SSE call body (direct endpoint, not through Hasura) and to the `SmartGenDataSchemas` mutation. Convert flat `FilterCondition[]` array directly (no rule tree conversion needed — flat AND-only).

### AI Metrics Display

- [x] T036 [US5] Modify `../client-v2/src/components/CodeEditor/index.tsx` — extend the Monaco hover provider to detect `ai_generated: true` in model code and show the corresponding `ai_generation_context` value as a hover tooltip. Add subtle Monaco editor decorations (gutter icon or line background tint) for lines within AI-generated field blocks. Use existing Monaco `deltaDecorations` API — detect AI metric blocks by parsing the model text for `ai_generated: true` patterns.
- [x] T037 [US5] Modify `../client-v2/src/components/SmartGeneration/index.tsx` — in the ChangePreviewPanel section, add display for `ai_metrics_added`, `ai_metrics_retained`, and `ai_metrics_removed` from the `change_preview` response. Use existing tag styling (success for added, default for retained, error for removed). Show `ai_generation_context` as tooltip on each AI metric entry.

**Checkpoint**: Full-stack feature complete. Filters work in UI. AI metrics visible and distinguishable in editor.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T038 Add `OPENAI_API_KEY` environment variable documentation to `docker-compose.dev.yml` comments and quickstart
- [x] T039 [P] Update `services/cubejs/src/utils/smart-generation/progressEmitter.js` — add progress phases for "Validating filters", "Generating AI metrics", "Validating AI metrics" so the frontend progress bar reflects the new steps
- [x] T040 [P] Handle edge case: very small filtered dataset (<100 rows) — add a warning in the profiler output and LLM prompt noting the limited sample size may affect metric quality
- [x] T041 Verify backward compatibility: run existing StepCI tests to confirm no regressions when `filters` is omitted from smart-generate and profile-table requests
- [x] T042 Run quickstart.md verification commands against a live ClickHouse table to confirm end-to-end flow
- [x] T043 Add StepCI integration test to `tests/stepci/smart_gen_flow.yml`

---

## Phase 9: Filter Value Lookup via Cube.js Load API

**Purpose**: Populate filter builder value inputs with real data from the underlying datasource using Cube.js `contains` filter for server-side partial matching.

**Depends on**: Phase 7 (FilterBuilder component exists), existing Cube.js load API

- [x] T044 [US5] Modify `../client-v2/src/components/SmartGeneration/FilterBuilder.tsx` — replace static free-text value inputs with async Cube.js-powered value lookups: (1) add `useColumnValues` hook that calls `POST /api/v1/load` with a `contains` filter on the dimension as the user types, debounced at 300ms; (2) for `=`/`!=` operators show a searchable `Select` dropdown populated with real values; (3) for `IN`/`NOT IN` show a tag-mode `Select` with real value suggestions; (4) fall back to free-text when no `cubeName` is provided (first-time generation) or when the Cube.js query fails; (5) pass `cubeName`, `datasourceId`, `branchId` from parent for auth headers
- [x] T045 [US5] Modify `../client-v2/src/components/SmartGeneration/index.tsx`

---

## Phase 10: File Name & Model Name Overrides

**Purpose**: Allow users to override the auto-generated file name and cube/model name during smart generation.

**Depends on**: Phase 7 (SmartGeneration UI exists), smartGenerate.js, cubeBuilder.js

- [x] T046 Modify `services/cubejs/src/utils/smart-generation/cubeBuilder.js` — accept optional `cubeName` in options, use it instead of `sanitizeCubeName(table)` when provided
- [x] T047 Modify `services/cubejs/src/routes/smartGenerate.js` — accept `file_name` and `cube_name` from request body, use as overrides for `generateFileName()` and `buildCubes()` cubeName option
- [x] T048 Modify `services/hasura/metadata/actions.graphql` — add `file_name: String` and `cube_name: String` optional parameters to `smart_gen_dataschemas` mutation
- [x] T049 Modify `services/actions/src/rpc/smartGenSchemas.js` — extract and pass through `file_name` and `cube_name`
- [x] T050 Modify `../client-v2/src/graphql/gql/datasources.gql` and generated types — add `$file_name` and `$cube_name` variables
- [x] T051 Modify `../client-v2/src/components/SmartGeneration/index.tsx` — add "File name" and "Model name" input fields in the preview step (after merge strategy), pass overrides to mutation calls — pass `cubeName` (derived from selected table name), `datasourceId`, and `branchId` props to the FilterBuilder component so value lookups can authenticate against the Cube.js REST API — add a new step after existing `smart_gen_merge_replace` that calls `smart_gen_dataschemas` with `filters: [{column: "event_type", operator: "=", value: "view"}]` (using a column from the ClickHouse demo dataset). Verify response includes `code: "ok"`, `ai_enrichment` object with `status` (string), and `changed: true`. This satisfies Constitution Principle III: "New endpoints or mutations MUST have corresponding StepCI coverage." Note: AI enrichment may return `status: "failed"` in CI if `OPENAI_API_KEY` is not set — assert `status` exists (string) but accept any value.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup (T001 for openai package). Phase 2A (JS support T004-T009) and Phase 2B (new modules T010-T015) can overlap once setup is done
- **US1 (Phase 3)**: Depends on T005 (merger JS support) and T013 (filterBuilder). Test T016 before impl T017-T019
- **US2 (Phase 4)**: Depends on T007 (yamlGenerator AI field fix), T014, T015 (llmEnricher, llmValidator). Test T020 before impl T021-T022
- **US3 (Phase 5)**: Depends on US2 completion (T021-T022). Test T023 before impl T024-T027
- **US4 (Phase 6)**: Depends on US1 completion (T019 stores filters in meta). Test T028 before impl T029-T030
- **US5 (Phase 7)**: Depends on US1 + US2 (backend APIs must accept filters and return AI metrics)
- **Polish (Phase 8)**: Depends on all user stories. T043 (StepCI test) depends on T031 (Hasura action schema with filters) and T022 (AI enrichment response format)

### User Story Dependencies

```
Setup (Phase 1)
  └─→ Foundational Phase 2A (JS support: T004-T009)
  └─→ Foundational Phase 2B (new modules: T010-T015)
        ├─→ US1 (Phase 3: Test T016 → Impl T017-T019) ────────────┐
        │     └─→ US4 (Phase 6: Test T028 → Impl T029-T030)       │
        └─→ US2 (Phase 4: Test T020 → Impl T021-T022)             │
              └─→ US3 (Phase 5: Test T023 → Impl T024-T027)       │
                                                                   │
        US1 + US2 complete ──→ US5 (Phase 7: frontend) ────────────┘
                                └─→ Polish (Phase 8)
```

### Within Each User Story

- Tests FIRST — must fail before implementation (Red-Green-Refactor)
- Utility modules before route modifications
- Route modifications before integration
- Backend before frontend (within US5)

### Parallel Opportunities

- **Phase 1**: T001, T002, T003 all parallel (different files/projects)
- **Phase 2A**: T004 (tests) first, then T005-T009 parallel (different files)
- **Phase 2B**: Test tasks T010, T011, T012 all parallel. Implementation tasks T013, T014, T015 all parallel
- **Phase 3 + Phase 4**: US1 and US2 can run in parallel after Phase 2 (no dependencies between them)
- **Phase 7**: T031-T033 sequential (contract → passthrough → codegen). T034, T036 parallel (different components). T035 depends on T034. T037 depends on T022 response format.

---

## Parallel Example: Foundational Phase

```
# Phase 2A — JS support (sequential test, then parallel impl):
Task: "Write JS model support tests"
Then parallel:
  Task: "Extend merger for JS parsing"
  Task: "Fix diffModels for JS"
  Task: "Fix yamlGenerator AI field stamping"
  Task: "Fix profileTable JS analysis"
  Task: "Fix CodeEditor regen button for JS"

# Phase 2B — New modules (parallel tests, then parallel impl):
Task: "Write filterBuilder tests"
Task: "Write llmValidator tests"
Task: "Write llmEnricher tests"
Then:
Task: "Create filterBuilder.js"
Task: "Create llmEnricher.js"
Task: "Create llmValidator.js"
```

## Parallel Example: US1 + US2 After Foundational

```
# US1 and US2 can proceed in parallel:
Agent A (US1): T016 (test) → T017 → T018 → T019  (filtered profiling)
Agent B (US2): T020 (test) → T021 → T022           (LLM metrics)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T003)
2. Complete Phase 2A: JS support fixes (required for regen/merge to work on JS files)
3. Complete Phase 2B: filterBuilder only (T010, T013)
4. Complete Phase 3: US1 — test T016 then impl T017-T019
5. **STOP and VALIDATE**: Profile a table with filters via curl, verify filtered results
6. MVP delivers filtered introspection without LLM or frontend

### Incremental Delivery

1. Setup + Foundational (2A + 2B) → Foundation ready (tests green)
2. US1 (filtered profiling) → Test independently → Backend MVP
3. US2 (LLM metrics) → Test independently → AI-enriched models (FR-007 fully satisfied here)
4. US3 (superset regen) → Test independently → Safe regeneration
5. US4 (filter persistence) → Test independently → Round-trip filters
6. US5 (frontend) → Test independently → Full-stack feature
7. Polish → Hardening and documentation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- Tests precede implementation in every phase (Constitution Principle III)
- US1 and US2 are both P1 but independent — can be parallelized
- US3 depends on US2 (needs LLM infrastructure to exist)
- US4 depends on US1 (needs filter storage in meta)
- US5 depends on US1+US2 (needs backend APIs ready)
- LLM failures always degrade gracefully — base model still generated
- Partition filter always AND-ed with user filters (security boundary)
- FR-007 (always-on LLM) is only fully satisfied after US2 — during MVP, no LLM
- `FilterConditionInput.value` uses `jsonb` in GraphQL (Hasura transport), normalized to `string | string[]` in backend
