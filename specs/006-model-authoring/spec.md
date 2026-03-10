# Feature Specification: Model Authoring Improvements

**Feature Branch**: `006-model-authoring`
**Created**: 2026-03-10
**Status**: Draft
**Input**: User description: "Model Authoring Improvements"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Autocomplete While Editing Models (Priority: P1)

A data engineer is editing a Cube.js model file (YAML or JS) in the Models IDE. As they type, the editor suggests valid property names, type values, template variables, and cube/member references — similar to an IDE experience for a typed language. They can press Tab to accept suggestions and quickly scaffold new dimensions, measures, joins, and pre-aggregations without referencing documentation.

**Why this priority**: Autocomplete is the highest-leverage improvement. It accelerates every editing session, reduces errors at the point of entry, and makes joins (currently the hardest thing to author) easy by suggesting target cubes and their members.

**Independent Test**: Can be tested by opening any model file in the editor and verifying that context-aware suggestions appear for property names, type enums, cube references, template variables, and join targets.

**Acceptance Scenarios**:

1. **Given** a user is editing a cube's top-level properties, **When** they trigger autocomplete, **Then** they see valid top-level keys (sql_table, dimensions, measures, joins, etc.) with descriptions.
2. **Given** a user is inside a `dimensions` block, **When** they trigger autocomplete for a new member, **Then** a skeleton snippet is inserted with tabstops for name, sql, and type.
3. **Given** a user is typing a `type` value for a measure, **When** they trigger autocomplete, **Then** they see only valid measure types (sum, count, avg, min, max, etc.).
4. **Given** a user is editing a join's `sql` property, **When** they trigger autocomplete after `${`, **Then** they see CUBE and all other cube names from the current branch, and selecting a cube name followed by `.` shows that cube's dimensions.
5. **Given** a user is editing a YAML model file, **When** they trigger autocomplete, **Then** suggestions use YAML syntax (not JS).
6. **Given** a user is editing a JS model file with `${FILTER_PARAMS...}` references, **When** they trigger autocomplete inside a template literal, **Then** they see valid template variables including FILTER_PARAMS, SECURITY_CONTEXT, CUBE, and SQL_UTILS.

---

### User Story 2 - Real-Time Validation with Inline Errors (Priority: P1)

A data engineer saves or edits a model file and sees validation errors inline in the editor (red squiggles under problematic code) with descriptive error messages on hover. Validation catches both structural issues (invalid property names, wrong types, missing required fields) and semantic issues (referencing a nonexistent cube in a join, circular dependencies).

**Why this priority**: Without validation, users only discover errors when queries fail at runtime. Inline errors catch mistakes immediately, reducing the debug cycle from minutes to seconds.

**Independent Test**: Can be tested by introducing known errors into a model file (e.g., invalid type value, reference to nonexistent cube) and verifying that red squiggles appear with helpful error messages.

**Acceptance Scenarios**:

1. **Given** a user types an invalid property name inside a cube definition, **When** the editor re-validates (debounced after typing stops), **Then** a red squiggle appears under the invalid property with a message listing valid alternatives.
2. **Given** a user sets a dimension type to an invalid value (e.g., "integer"), **When** the editor validates, **Then** a diagnostic appears stating the valid type options.
3. **Given** a user references a nonexistent cube in a join, **When** the file is saved or validation runs, **Then** a semantic error from the backend appears under the join definition.
4. **Given** a model has a missing required property (e.g., a measure without a `type`), **When** the editor validates, **Then** a warning appears indicating the missing field.
5. **Given** the backend validation endpoint returns errors with line/column positions, **When** errors are received, **Then** they appear as Monaco markers at the correct positions in the editor.
6. **Given** a user fixes a validation error, **When** the editor re-validates, **Then** the corresponding marker is removed.

---

### User Story 3 - Regenerate Smart Model from Editor Toolbar (Priority: P2)

A data engineer is viewing a smart-generated model file in the editor. They click a "Regenerate" button in the editor toolbar to re-profile the source table and update the model. The existing merge strategy options (auto, merge, replace) are presented, and after regeneration, user-added content (joins, pre-aggregations, custom measures, edited descriptions) is preserved according to the chosen strategy.

**Why this priority**: Re-profiling is essential as source data evolves. Placing the action in the editor toolbar (where the user is already working) removes friction. The merge behavior is the key trust factor — users must be confident their manual edits survive.

**Independent Test**: Can be tested by adding custom joins/pre-aggregations to a smart-generated model, regenerating with "merge" strategy, and verifying the custom content is preserved while auto-generated fields are updated.

**Acceptance Scenarios**:

1. **Given** a user has a smart-generated file open in the editor, **When** they look at the editor toolbar, **Then** a "Regenerate" button is visible.
2. **Given** a user has a non-smart-generated file open, **When** they look at the editor toolbar, **Then** no "Regenerate" button is shown.
3. **Given** a user clicks "Regenerate", **When** an existing model exists for that table, **Then** they are presented with merge strategy options (auto, merge, replace) before proceeding.
4. **Given** a user has added custom joins and pre-aggregations to a smart-generated model, **When** they regenerate with "merge" strategy, **Then** their custom joins and pre-aggregations are preserved in the new version.
5. **Given** a user has edited the `description` on an auto-generated dimension, **When** they regenerate with "merge" strategy, **Then** the edited description is preserved.
6. **Given** a user regenerates with "replace" strategy, **When** the new version is created, **Then** all previous content is replaced with the fresh profile output.
7. **Given** regeneration is in progress, **When** the user views the editor, **Then** a progress indicator is shown and the editor is not editable until complete.

---

### User Story 4 - Full Cube.js Spec Coverage in Completions (Priority: P2)

The autocomplete covers the entire Cube.js model specification — not just basic properties, but advanced features including pre-aggregation configuration (partition granularity, refresh keys, indexes, build ranges), rollup joins/lambdas, context blocks, extends, refresh_key options, SQL_UTILS helpers, and all FILTER_PARAMS/SECURITY_CONTEXT patterns.

**Why this priority**: Power users need the long tail of Cube.js features. Incomplete autocomplete forces them back to documentation, breaking flow.

**Independent Test**: Can be tested by attempting to author each major Cube.js feature (pre-aggregation with partitioning, rollup_join, extends, refresh_key, SECURITY_CONTEXT) and verifying that autocomplete provides correct suggestions for each.

**Acceptance Scenarios**:

1. **Given** a user is inside a `pre_aggregations` block, **When** they trigger autocomplete, **Then** they see all valid pre-aggregation properties including type, measures, dimensions, time_dimension, granularity, partition_granularity, refresh_key, indexes, build_range_start, build_range_end.
2. **Given** a user types `extends` at the cube root, **When** they trigger autocomplete for the value, **Then** they see a list of all other cube names in the branch.
3. **Given** a user is editing a `refresh_key` block, **When** they trigger autocomplete, **Then** they see valid options (sql, every, incremental, update_window).
4. **Given** a user types `${SQL_UTILS}` inside a sql property, **When** they trigger autocomplete after the dot, **Then** they see available SQL utility methods.

---

### User Story 5 - Hover Documentation (Priority: P3)

A data engineer hovers over a property name, type value, or template variable in the editor and sees a tooltip with a brief description of what it does, valid values, and usage notes.

**Why this priority**: Hover docs complement autocomplete by providing context without leaving the editor. Lower priority because autocomplete descriptions provide partial coverage.

**Independent Test**: Can be tested by hovering over various Cube.js keywords and verifying that informative tooltips appear.

**Acceptance Scenarios**:

1. **Given** a user hovers over a property name like `relationship`, **When** the tooltip appears, **Then** it shows a description and valid values (one_to_one, one_to_many, many_to_one).
2. **Given** a user hovers over `${FILTER_PARAMS}`, **When** the tooltip appears, **Then** it explains FILTER_PARAMS usage with the callback syntax pattern.
3. **Given** a user hovers over a cube reference in a join sql, **When** the tooltip appears, **Then** it shows the referenced cube's available dimensions and measures.

---

### Edge Cases

- What happens when a model file has syntax errors so severe the parser cannot determine cursor context? Autocomplete degrades gracefully to top-level suggestions; validation shows a parse error.
- What happens when FetchMeta fails or returns empty? Autocomplete works for schema spec properties but not for cube references; a warning is shown.
- What happens when the backend validation endpoint is unreachable? Client-side validation still functions; semantic validation is skipped with a status indicator.
- What happens when a user edits a file that another user has also modified? Version conflict handled by existing checksum mechanism.
- What happens when a YAML file contains invalid YAML syntax? YAML parser catches it and shows a parse error diagnostic before any schema validation.
- What happens when a JS model uses non-standard patterns (e.g., helper functions, imports)? Parser marks unparseable sections as unknown; no false errors emitted for code outside `cube()`/`view()` blocks.
- What happens when a user renames a cube or adds a member in an unsaved file? The cube registry reflects the last saved state; cross-cube references won't include unsaved changes until save. This is a known v1 limitation — a workspace overlay is deferred to a future iteration.
- What happens when inline Monaco markers show the same errors as the existing Console component? The Console continues to show branch-level compilation errors from FetchMeta. Inline markers show per-file errors from the new validation flow. Both surfaces coexist; the Console is not modified in this iteration.

### Format Scope (v1)

Smart generation currently outputs JS files, but the merge/reprofile pipeline (`merger.js`, `profileTable.js`) operates on YAML structures. Until a JS merge path exists:

- **YAML files**: Full support — autocomplete, validation, hover, regenerate with merge
- **JS files**: Autocomplete, hover, and backend validation (via `/api/v1/validate`). Client-side structural validation operates on parsed `cube()`/`view()` blocks only. Regenerate button is NOT shown for JS smart-generated files (the `isSmartGenerated` check must also verify the file is YAML)
- **Future**: JS merge support and JS provenance detection are deferred

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide context-aware autocomplete suggestions in the Monaco editor for both YAML and JS Cube.js model formats.
- **FR-002**: System MUST validate model files client-side for structural correctness (valid properties, types, required fields) and display errors as Monaco diagnostic markers.
- **FR-003**: System MUST validate model files server-side via a backend endpoint for semantic correctness (invalid references, circular dependencies, compilation errors) and display results as Monaco diagnostic markers with correct line/column positions.
- **FR-004**: System MUST include a "Regenerate" button in the editor toolbar that is visible only when editing smart-generated YAML model files (JS smart-generated files are excluded until JS merge support exists).
- **FR-005**: System MUST present merge strategy options (auto, merge, replace) when regenerating a model that already exists.
- **FR-006**: The merge strategy MUST preserve user-added content (joins, pre-aggregations, segments, custom measures/dimensions, edited descriptions) when using "merge" or "auto" strategies.
- **FR-007**: Autocomplete MUST suggest other cube names and their members when editing join targets and sql references.
- **FR-008**: Autocomplete MUST cover the full Cube.js model specification including pre-aggregations, refresh keys, extends, rollup joins/lambdas, context blocks, FILTER_PARAMS, SECURITY_CONTEXT, and SQL_UTILS.
- **FR-009**: System MUST provide member scaffolding snippets (dimension, measure, join, segment, pre-aggregation) with tabstops for required fields.
- **FR-010**: System MUST ship a static Cube.js schema spec versioned to match the backend CubeJS version, with a non-blocking warning banner displayed if the frontend spec version differs from the backend version (major or minor).
- **FR-011**: System MUST provide hover tooltips for Cube.js property names, type values, and template variables with descriptions and valid values.
- **FR-012**: Client-side validation MUST run on a debounced timer after edits; backend validation MUST run on file save.
- **FR-013**: System MUST use the existing FetchMeta query as the source for the cube registry (cube names, dimensions, measures, segments) used by autocomplete. The registry reflects the last saved/compiled state; unsaved edits in dirty buffers are not reflected until save.
- **FR-015**: System MUST fix the existing language detection bug in CodeEditor (currently splits filename on `.` taking the first segment instead of the extension) as a prerequisite for Monaco language provider registration.
- **FR-014**: The cube registry MUST refresh after saving a file, after smart regeneration, and on initial editor load.

### Key Entities

- **Schema Spec**: A structured definition of all valid Cube.js model properties, their types, nesting rules, descriptions, and allowed values. Versioned to the CubeJS backend version.
- **Cube Registry**: A runtime cache of all cubes and their members in the current branch, populated from FetchMeta. Used for cross-cube reference suggestions and validation.
- **Parsed Document**: A format-agnostic representation of a model file (cubes, members, properties with source positions) produced by either the YAML or JS parser.
- **Cursor Context**: The semantic location of the cursor within the document tree (e.g., "inside a measure's type property of the events cube"), used to determine what completions to offer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Autocomplete suggestions appear within 100ms of trigger in both YAML and JS formats.
- **SC-002**: Client-side validation errors appear within 500ms of the user stopping typing.
- **SC-003**: Backend validation results appear within 3 seconds of saving a file.
- **SC-004**: Users can author a complete join between two cubes (including sql reference) using only autocomplete suggestions and tab navigation, without typing cube or member names manually.
- **SC-005**: Smart model regeneration with "merge" strategy preserves 100% of user-added content (joins, pre-aggregations, segments, custom members, edited descriptions).
- **SC-006**: The schema spec covers all Cube.js model properties documented in the official Cube.js v1.6 specification.
- **SC-007**: Zero false-positive validation errors on valid Cube.js model files (no red squiggles on correct code). For JS files, client-side validation only covers parsed `cube()`/`view()` blocks; code outside these blocks is not validated and must not produce false markers.

## Assumptions

- The existing FetchMeta GraphQL query returns sufficient metadata (cube names, member names, member types) for autocomplete purposes.
- The CubeJS compiler can be invoked programmatically to validate a set of model files and return structured errors with source positions.
- Monaco editor's language service APIs (CompletionItemProvider, DiagnosticProvider, HoverProvider) support the registration model needed for both YAML and JS simultaneously.
- The current smart generation merge logic correctly preserves user content — this will be verified through testing rather than reimplemented.
- Users are comfortable with the existing 5-step smart generation wizard for initial model creation; only the re-profile/regenerate flow is being streamlined.
