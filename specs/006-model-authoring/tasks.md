# Tasks: Model Authoring Improvements

**Input**: Design documents from `/specs/006-model-authoring/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included per constitution (Principle III: Test-Driven Development is NON-NEGOTIABLE).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Backend**: `services/cubejs/src/` (CubeJS service)
- **Frontend**: `../client-v2/src/` (client-v2 app)
- **Tests**: `tests/` (StepCI integration), `../client-v2/` (Vitest unit)

---

## Phase 1: Setup

**Purpose**: Create the language service module structure and install dependencies

- [x] T001 Create the `cubejs-language` directory structure at `../client-v2/src/utils/cubejs-language/`
- [x] T002 Add `yaml` ^2.3.4 dependency to `../client-v2/package.json` and install
- [x] T003 Create shared types file at `../client-v2/src/utils/cubejs-language/types.ts` defining ParsedDocument, ParsedCube, ParsedView, ParsedMember, ParsedProperty, CursorContext, MonacoRange, CubeRegistryEntry, MemberEntry, ValidationError, and PropertySpec interfaces per data-model.md
- [x] T038 [PREREQUISITE] Fix language detection bug in `../client-v2/src/components/CodeEditor/index.tsx` — change `active.split(".")[0]` (line 128) to extract the file extension (last segment after final dot), not the basename. Current code maps `semantic_events.js` → `"semantic_events"` → undefined instead of `"js"` → `"javascript"`. Without this fix, Monaco language providers registered for 'yaml'/'javascript' will not attach. (FR-015)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema spec and parsers that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

### Schema Spec

- [x] T004 Write failing unit tests for the Cube.js schema spec at `../client-v2/src/utils/cubejs-language/__tests__/spec.test.ts` — verify cube top-level properties, dimension types, measure types, join relationships, pre-aggregation types, refresh_key forms, view properties, and YAML↔JS key mappings all match CubeValidator.js (v1.6.19)
- [x] T005 Create the static Cube.js schema spec at `../client-v2/src/utils/cubejs-language/spec.ts` — define all constructs (cube, view), all member types (dimensions, measures, joins, segments, pre_aggregations), all property definitions with types/enums/descriptions/required flags, all template variables (CUBE, FILTER_PARAMS, SECURITY_CONTEXT, SQL_UTILS, COMPILE_CONTEXT), YAML↔JS key mappings, and `CUBEJS_SPEC_VERSION = "1.6.19"` constant. Full coverage per research.md Section 2.

### YAML Parser

- [x] T006 [P] Write failing unit tests for the YAML parser at `../client-v2/src/utils/cubejs-language/__tests__/yamlParser.test.ts` — test parsing cubes/views from YAML, source position tracking for properties and members, getCursorContext at various positions (cube_root, member_list, member_body, property_value, sql), and graceful handling of invalid YAML
- [x] T007 [P] Implement the YAML parser at `../client-v2/src/utils/cubejs-language/yamlParser.ts` — use `yaml` package with `keepSourceTokens: true`, parse YAML into ParsedDocument with cubes/views/errors, map YAML structure to normalized model with MonacoRange positions, implement `getCursorContext(position)` returning CursorContext union type

### JS Parser

- [x] T008 [P] Write failing unit tests for the JS parser at `../client-v2/src/utils/cubejs-language/__tests__/jsParser.test.ts` — test parsing `cube()` and `view()` calls, brace-matching for object extraction, property/member position tracking, template literal detection (${CUBE}, ${FILTER_PARAMS...}), getCursorContext at various positions, and graceful handling of unparseable sections
- [x] T009 [P] Implement the JS parser at `../client-v2/src/utils/cubejs-language/jsParser.ts` — find `cube(`/`view(` call sites via regex, extract object literals via brace matching, parse properties with position tracking, detect template variable references in sql strings, implement `getCursorContext(position)` matching the same CursorContext type as YAML parser

### Cube Registry

- [x] T010 Write failing unit tests for the cube registry at `../client-v2/src/utils/cubejs-language/__tests__/registry.test.ts` — test populating from FetchMeta response, looking up cubes by name, getting members by type, refreshing on demand, and error state handling
- [x] T011 Implement the cube registry at `../client-v2/src/utils/cubejs-language/registry.ts` — wraps FetchMeta query result, stores CubeRegistryEntry[] with name/dimensions/measures/segments, provides lookup methods (getCube, getAllCubeNames, getMembersByType), exposes refresh() method, handles loading/ready/error states

**Checkpoint**: Foundation ready — schema spec, both parsers, and cube registry are tested and working. User story implementation can begin.

---

## Phase 3: User Story 1 — Autocomplete While Editing Models (Priority: P1) MVP

**Goal**: Context-aware autocomplete in Monaco for both YAML and JS Cube.js model formats

**Independent Test**: Open any model file, trigger autocomplete at various positions, verify correct context-sensitive suggestions appear

### Tests for User Story 1

- [x] T012 [P] [US1] Write failing unit tests for the completion provider at `../client-v2/src/utils/cubejs-language/__tests__/completionProvider.test.ts` — test suggestions for: cube_root (top-level keys), member_list (skeleton snippets), member_body (valid properties per member type), property_value for type enums (dimension types, measure types, relationship values), sql context (${CUBE}, template variables), join sql (cube names + member references from registry), extends (cube names), drill_members (current cube members), and YAML vs JS format differences

### Implementation for User Story 1

- [x] T013 [US1] Implement the completion provider at `../client-v2/src/utils/cubejs-language/completionProvider.ts` — register with Monaco for both 'yaml' and 'javascript' languages, set triggerCharacters ['.', '$', ':'], implement provideCompletionItems using getCursorContext → schema spec + cube registry lookup, generate CompletionItems with correct kind/sortText/documentation/range, use InsertAsSnippet for member scaffolding (dimension, measure, join, segment, pre-aggregation snippets with tabstops and choice dropdowns for type enums)
- [x] T014 [US1] Integrate the completion provider into the CodeEditor component at `../client-v2/src/components/CodeEditor/index.tsx` — import and register the completion provider on editor mount, pass the cube registry instance, dispose on unmount, ensure the registry is populated from FetchMeta on mount

**Checkpoint**: Autocomplete works in both YAML and JS. Users can scaffold members, get type suggestions, and reference other cubes in joins.

---

## Phase 4: User Story 2 — Real-Time Validation with Inline Errors (Priority: P1)

**Goal**: Client-side structural validation (instant) and backend semantic validation (on save) with Monaco markers

**Independent Test**: Introduce known errors (invalid property, wrong type value, nonexistent cube reference), verify red squiggles appear at correct positions

### Tests for User Story 2

- [x] T015 [P] [US2] Write failing unit tests for the diagnostic provider at `../client-v2/src/utils/cubejs-language/__tests__/diagnosticProvider.test.ts` — test client-side validation: invalid property names produce error markers, invalid type values produce error markers, missing required properties produce warning markers, deprecated properties produce warning markers; test backend result mapping: ValidationError[] converted to IMarkerData[] with correct severity/position; test marker lifecycle: markers cleared when errors are fixed, client and backend markers merged correctly
- [x] T016 [P] [US2] Write failing StepCI integration test for the validate endpoint at `tests/stepci/validate_flow.yml` (StepCI tests live under `tests/stepci/`, not `tests/workflows/`) — test valid files return `{ valid: true, errors: [], warnings: [] }`, test file with invalid property returns error with fileName/line/column, test file referencing nonexistent cube in join returns semantic error, test request without auth returns 401

### Implementation for User Story 2

- [x] T017 [US2] Implement the validate route at `services/cubejs/src/routes/validate.js` — accept POST with `{ files: [{ fileName, content }] }`, create in-memory SchemaFileRepository, call `prepareCompiler(repo)` then `compiler.compile()`, collect errors from `compiler.errorReport.getErrors()` and `.getWarnings()`, map CompilerErrorInterface/SyntaxErrorInterface to response format with severity/message/fileName/startLine/startColumn/endLine/endColumn, return `{ valid, errors, warnings }`
- [x] T018 [US2] Implement the version route at `services/cubejs/src/routes/version.js` — read `@cubejs-backend/schema-compiler` package version at startup, return `{ version }` on GET
- [x] T019 [US2] Register validate and version routes in `services/cubejs/src/routes/index.js` — add `POST /api/v1/validate` and `GET /api/v1/version` with `checkAuthMiddleware`
- [x] T020 [US2] Implement the diagnostic provider at `../client-v2/src/utils/cubejs-language/diagnosticProvider.ts` — client-side: listen to `editor.onDidChangeModelContent`, debounce 300ms, parse document, validate property names/types/required fields against schema spec, call `monaco.editor.setModelMarkers` with owner 'cubejs-client'; backend: on file save, POST all current version files to `/api/v1/validate`, map response errors to IMarkerData, call `setModelMarkers` with owner 'cubejs-backend'; merge: both owners coexist, Monaco shows markers from both
- [x] T021 [US2] Integrate the diagnostic provider into the CodeEditor component at `../client-v2/src/components/CodeEditor/index.tsx` — initialize diagnostic provider on editor mount, connect to save handler to trigger backend validation and cube registry refresh (FR-014: registry must refresh after saving a file), add version check on mount (GET /api/v1/version, compare with CUBEJS_SPEC_VERSION, show warning banner if mismatch), dispose on unmount

**Checkpoint**: Typing errors get instant red squiggles. Saving triggers deep validation. Both YAML and JS files validated correctly.

---

## Phase 5: User Story 3 — Regenerate Smart Model from Editor Toolbar (Priority: P2)

**Goal**: "Regenerate" button in editor toolbar for smart-generated files, with merge strategy selection and verified user-content preservation

**Independent Test**: Add custom joins to a smart-generated model, click Regenerate with merge strategy, verify joins are preserved

### Tests for User Story 3

- [x] T022 [P] [US3] Write failing integration test for merge preservation at `../client-v2/src/utils/cubejs-language/__tests__/mergePreservation.test.ts` — test that a smart-generated model with user-added joins, pre_aggregations, segments, custom dimensions, and edited descriptions survives regeneration with merge strategy; test that replace strategy replaces everything; test that auto strategy detects user content and selects merge

### Implementation for User Story 3

- [x] T023 [US3] Add "Regenerate" toolbar button to the CodeEditor component at `../client-v2/src/components/CodeEditor/index.tsx` — detect smart-generated YAML files using `isSmartGenerated()` from `provenanceParser.ts` AND verifying the file extension is `.yml`/`.yaml` (JS smart-generated files are excluded per FR-004 — merger.js and profileTable.js only support YAML), show/hide button conditionally, extract source_table and source_database from provenance metadata
- [x] T024 [US3] Implement the regenerate flow UI at `../client-v2/src/components/CodeEditor/RegenerateModal.tsx` — modal with merge strategy radio group (Auto recommended, Merge, Replace), progress indicator during regeneration, call SmartGenDataSchemas mutation with selected strategy, refresh editor content and cube registry on completion, disable editor during regeneration

**Checkpoint**: Users can regenerate smart models from the toolbar. Merge strategy preserves user content.

---

## Phase 6: User Story 4 — Full Cube.js Spec Coverage (Priority: P2)

**Goal**: Autocomplete covers the entire Cube.js v1.6 specification including advanced features

**Independent Test**: Author a pre-aggregation with partitioning, a rollup_join, extends, refresh_key, and SECURITY_CONTEXT — all via autocomplete

### Tests for User Story 4

- [x] T025 [P] [US4] Write failing unit tests for advanced completions at `../client-v2/src/utils/cubejs-language/__tests__/advancedCompletions.test.ts` — test: pre_aggregation properties (partition_granularity, refresh_key, indexes, build_range_start/end, rollup_join, rollup_lambda), refresh_key sub-properties (sql, every, incremental, update_window, immutable), view cubes/includes/excludes, access_policy structure, hierarchies, granularities for time dimensions, rolling_window options, multi-stage measure properties, FILTER_PARAMS callback syntax, SECURITY_CONTEXT.key.unsafeValue(), SQL_UTILS methods, COMPILE_CONTEXT

### Implementation for User Story 4

- [x] T026 [US4] Extend the completion provider at `../client-v2/src/utils/cubejs-language/completionProvider.ts` — add context cases for: pre_aggregation member_body (all type-specific properties), refresh_key nested properties, view cubes/includes/excludes, access_policy/member_level/row_level, hierarchies/levels, granularities (standard + custom), rolling_window (fixed vs to_date types), all FILTER_PARAMS/SECURITY_CONTEXT/SQL_UTILS/COMPILE_CONTEXT template completions with proper callback syntax snippets
- [x] T027 [US4] Extend client-side validation at `../client-v2/src/utils/cubejs-language/diagnosticProvider.ts` — validate pre-aggregation type-specific required properties (e.g., rollups required for rollup_join), validate refresh_key mutual exclusivity (every+sql vs immutable), validate view cubes array structure, warn on deprecated properties (shown, visible, refresh_range_start/end)

**Checkpoint**: Full Cube.js spec autocomplete — every property in CubeValidator.js has a completion and validation rule.

---

## Phase 7: User Story 5 — Hover Documentation (Priority: P3)

**Goal**: Hover tooltips on Cube.js keywords showing descriptions, valid values, and usage examples

**Independent Test**: Hover over `relationship`, `FILTER_PARAMS`, and a cube reference — verify informative tooltips appear

### Tests for User Story 5

- [x] T028 [P] [US5] Write failing unit tests for the hover provider at `../client-v2/src/utils/cubejs-language/__tests__/hoverProvider.test.ts` — test: hovering property names shows description + valid values, hovering type values shows what they mean, hovering template variables shows usage syntax, hovering cube references in join sql shows that cube's members, hovering deprecated properties shows replacement

### Implementation for User Story 5

- [x] T029 [US5] Implement the hover provider at `../client-v2/src/utils/cubejs-language/hoverProvider.ts` — register with Monaco for both 'yaml' and 'javascript', use getCursorContext + word detection to find what's under cursor, look up PropertySpec from schema spec for descriptions, look up CubeRegistryEntry for cube references, return Hover with markdown contents (bold name, description, valid values as code block, usage example for template variables)
- [x] T030 [US5] Register the hover provider in the CodeEditor component at `../client-v2/src/components/CodeEditor/index.tsx` — import and register on editor mount, pass schema spec and cube registry instances, dispose on unmount

**Checkpoint**: Hovering any Cube.js keyword shows helpful documentation inline.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T031 [P] Run `yarn codegen` in client-v2 if any GraphQL queries were modified — N/A, no .gql files changed
- [x] T036 [P] Validate zero false positives: create a test in `../client-v2/src/utils/cubejs-language/__tests__/diagnosticProvider.test.ts` that runs client-side validation against 3+ known-valid Cube.js model files (YAML and JS) and asserts zero error markers are produced (SC-007)
- [ ] T037 [P] Manual smoke test for SC-004: in the Models IDE, author a complete join between two cubes using only autocomplete suggestions and tab navigation — verify no manual typing of cube or member names is required
- [x] T032 [P] Run `yarn lint` in client-v2 and fix any lint errors in new files
- [ ] T033 Verify all StepCI tests pass (`./cli.sh tests stepci`) — requires Docker services running
- [x] T034 Run full client-v2 test suite (`cd ../client-v2 && yarn test`) — 58 passed, 1 pre-existing failure (VirtualTable unrelated)
- [ ] T035 Manual smoke test: open Models IDE, test autocomplete in YAML file, test autocomplete in JS file, test validation errors, test regenerate button, test hover tooltips

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately. T038 (language detection fix) is a PREREQUISITE for all Monaco provider work
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 Autocomplete (Phase 3)**: Depends on Phase 2
- **US2 Validation (Phase 4)**: Depends on Phase 2
- **US3 Regenerate (Phase 5)**: Depends on Phase 2 (no dependency on US1 or US2)
- **US4 Full Spec (Phase 6)**: Depends on US1 (Phase 3) — extends completion provider
- **US5 Hover (Phase 7)**: Depends on Phase 2 (no dependency on US1-US4)
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

```
Phase 1 (Setup)
    │
Phase 2 (Foundational: spec, parsers, registry)
    │
    ├── Phase 3 (US1: Autocomplete) ─── Phase 6 (US4: Full Spec Coverage)
    │
    ├── Phase 4 (US2: Validation)
    │
    ├── Phase 5 (US3: Regenerate)
    │
    └── Phase 7 (US5: Hover)
            │
        Phase 8 (Polish)
```

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Implementation follows test → code → verify cycle
- Story complete before moving to next priority

### Parallel Opportunities

- **Phase 2**: T006+T007 (YAML parser) and T008+T009 (JS parser) can run in parallel
- **Phase 3-5**: US1, US2, and US3 can all start in parallel after Phase 2
- **Phase 6-7**: US4 needs US1 done first; US5 can run parallel with anything after Phase 2
- **Within stories**: Test tasks marked [P] can run in parallel with other [P] tests

---

## Parallel Example: After Phase 2 Completes

```
Agent 1: US1 — Autocomplete (T012 → T013 → T014)
Agent 2: US2 — Validation (T015+T016 → T017 → T018 → T019 → T020 → T021)
Agent 3: US3 — Regenerate (T022 → T023 → T024)
```

## Parallel Example: After US1 Completes

```
Agent 1: US4 — Full Spec (T025 → T026 → T027)
Agent 2: US5 — Hover (T028 → T029 → T030)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (schema spec, parsers, registry)
3. Complete Phase 3: User Story 1 (Autocomplete)
4. **STOP and VALIDATE**: Test autocomplete independently in both YAML and JS
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 (Autocomplete) → Test → Deploy (MVP!)
3. Add US2 (Validation) → Test → Deploy
4. Add US3 (Regenerate) → Test → Deploy
5. Add US4 (Full Spec) → Test → Deploy
6. Add US5 (Hover) → Test → Deploy
7. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers/agents:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Agent A: US1 (Autocomplete) → then US4 (Full Spec)
   - Agent B: US2 (Validation)
   - Agent C: US3 (Regenerate) → then US5 (Hover)
3. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing (TDD per constitution)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- The schema spec (T005) is the largest single task (~1500 lines) — it defines the entire Cube.js property tree and is the foundation for everything else
