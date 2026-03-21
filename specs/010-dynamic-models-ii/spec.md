# Feature Specification: Dynamic Models II

**Feature Branch**: `010-dynamic-models-ii`
**Created**: 2026-03-15
**Status**: Draft
**Input**: User description: "Dynamic Models II"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Filtered Table Introspection (Priority: P1)

A data engineer wants to generate a Cube.js model for a ClickHouse table, but only for a relevant subset of the data. For example, the table contains events for all countries, but they only care about US events. They apply filters (e.g., `country = 'US'`, `event_date >= '2025-01-01'`) before profiling so that the generated model reflects the cardinality, value distributions, and column relevance of their actual working dataset — not the entire table.

**Why this priority**: Without filtered introspection, generated models reflect the global data shape, which may be misleading. A column with 1M unique values globally might have only 50 in the user's partition — changing whether it should be a dimension, a low-cardinality filter, or ignored entirely. This is the foundation that makes all subsequent generation more accurate.

**Independent Test**: Can be fully tested by profiling a table with and without filters and comparing the resulting column statistics. Delivers accurate, subset-specific models without requiring the LLM feature.

**Acceptance Scenarios**:

1. **Given** a user has selected a ClickHouse table for smart generation, **When** they specify one or more filter conditions (column, operator, value), **Then** the profiler runs all passes (schema discovery aggregates, initial profile, deep profile, LC probe) against only the filtered subset of data.
2. **Given** a user applies a filter like `event_date >= '2025-01-01'`, **When** profiling completes, **Then** row counts, cardinality, min/max/avg, and low-cardinality values all reflect only matching rows.
3. **Given** a user provides no filters, **When** they run smart generation, **Then** the system behaves identically to today (full-table profiling with optional partition filter).
4. **Given** a user applies filters that match zero rows, **When** profiling runs, **Then** the system returns a clear message that no data matched the filters instead of generating an empty model.

---

### User Story 2 - LLM-Generated Metrics and Calculations (Priority: P1)

After the profiler builds the base model (dimensions and simple measures like count/sum), an LLM analyzes the table structure, column semantics, and data characteristics to propose meaningful calculated metrics. These include averages, ratios, year-over-year comparisons, running totals, percentage breakdowns, and other domain-relevant calculations. The LLM-generated metrics are marked with `ai_generated: true` in their `meta` section so they are distinguishable from profiler-generated and user-created fields.

**Why this priority**: The core value proposition — turning raw table structure into actionable analytics without manual metric authoring. Simple sum/count measures are table stakes; the real value is intelligent calculated metrics that a domain expert would create.

**Independent Test**: Can be tested by running smart generation on a table and verifying that the output model contains LLM-proposed metrics beyond basic sum/count, each tagged with `ai_generated: true` in meta.

**Acceptance Scenarios**:

1. **Given** a table with date columns and numeric columns, **When** smart generation runs with LLM enrichment, **Then** the model includes time-based metrics (e.g., year-over-year growth, month-over-month change, rolling averages).
2. **Given** a table with revenue and quantity columns, **When** the LLM analyzes the profile, **Then** it proposes ratio metrics (e.g., average revenue per unit, revenue per user).
3. **Given** the LLM generates metrics, **When** the model is saved, **Then** every LLM-generated field has `meta.ai_generated: true` and `meta.ai_generation_context` describing why it was created.

---

### User Story 3 - LLM Metric Superset on Regeneration (Priority: P1)

When a user regenerates a model for a table that already has LLM-generated metrics, the LLM receives the previously generated metrics as context. It must produce a superset — retaining all prior AI metrics (unless the underlying columns no longer exist) and potentially adding new ones based on updated profile data. The LLM never removes a previously generated metric that is still valid.

**Why this priority**: Users may have built dashboards and reports on top of AI-generated metrics. Silently removing them on regeneration would break downstream consumers. The superset guarantee is critical for trust.

**Independent Test**: Can be tested by running smart generation twice on the same table (with a schema change between runs) and verifying that the second run's AI metrics are a superset of the first run's.

**Acceptance Scenarios**:

1. **Given** a model with 5 AI-generated metrics from a previous run, **When** the user regenerates the model, **Then** the new model contains at least those same 5 metrics plus any new ones the LLM identifies.
2. **Given** a previously AI-generated metric references a column that has been dropped from the table, **When** regeneration runs, **Then** the metric is removed and the change is surfaced in the diff preview.
3. **Given** the user has manually edited the description of an AI-generated metric, **When** regeneration runs, **Then** the user's description is preserved (not overwritten by the LLM).
4. **Given** the LLM is unavailable or returns an error, **When** smart generation runs, **Then** the base model (profiler-generated dimensions and measures) is still created successfully, and the user is informed that AI metrics could not be generated.

---

### User Story 4 - Filter Persistence Across Regeneration (Priority: P2)

When a user regenerates a model that was previously generated with filters, the system remembers and re-applies those filters. The user can modify or clear them, but they don't have to re-enter them each time.

**Why this priority**: Convenience and consistency. If the user always works with US data, they shouldn't have to re-specify the filter on every regeneration.

**Independent Test**: Can be tested by generating a model with filters, then regenerating — verifying the filters are pre-populated from the previous run.

**Acceptance Scenarios**:

1. **Given** a model was previously generated with filters `country = 'US'`, **When** the user opens the regeneration UI for that table, **Then** the filters are pre-populated with the previous values.
2. **Given** pre-populated filters exist, **When** the user clears or modifies them, **Then** the new filters are used for profiling and stored for the next run.

---

### User Story 5 - Frontend Filter Builder and AI Metrics Display (Priority: P2)

A data engineer using the smart generation UI can define filter conditions through a structured filter builder (pick column, operator, value) before profiling. After generation, AI-generated metrics are visually distinguished from profiler-generated and user-created fields in the model editor, with tooltips showing the AI's reasoning for each metric.

**Why this priority**: The backend delivers the core functionality; the frontend makes it accessible. Without the filter builder, users would need to call the API directly. Without AI metric distinction in the UI, users can't tell which metrics came from the LLM.

**Independent Test**: Can be tested by opening the smart generation dialog, adding filters, running generation, and verifying that AI metrics appear with distinct visual indicators and generation context tooltips.

**Acceptance Scenarios**:

1. **Given** a user opens the smart generation dialog for a table, **When** they click "Add Filter," **Then** they see a row with column dropdown (populated from table schema), operator dropdown, and value input.
2. **Given** a user has added multiple filters, **When** they run smart generation, **Then** the filters are sent to the backend and the profiled model reflects the filtered subset.
3. **Given** a generated model contains AI-generated metrics, **When** the user views the model in the editor, **Then** AI metrics are visually tagged (e.g., badge or icon) and hovering shows the `ai_generation_context`.
4. **Given** a model was previously generated with filters, **When** the user opens regeneration for that table, **Then** the filter builder is pre-populated with the previous filter conditions.
5. **Given** a table has an existing Cube.js model, **When** the user selects a column and an `=`, `!=`, `IN`, or `NOT IN` operator in the filter builder, **Then** the value input shows a searchable dropdown populated with real values from the underlying datasource via Cube.js load API, with server-side partial matching as the user types.
6. **Given** a table has no existing Cube.js model (first-time generation), **When** the user adds a filter, **Then** the value input falls back to free-text entry since no cube exists to query.
7. **Given** a user is configuring smart generation options (preview step), **When** they enter a custom file name or model name, **Then** the generated model uses those names instead of the auto-derived defaults (table name → file name, sanitized table name → cube name).
8. **Given** a user leaves the file name and model name fields empty, **When** they run smart generation, **Then** the system uses the default auto-derived names (backward compatible).

---

### Edge Cases

- What happens when a filter references a column that doesn't exist in the table? The system validates filter columns against the table schema before profiling and rejects invalid columns with a clear error.
- What happens when the LLM suggests a metric with invalid Cube.js SQL syntax? The system validates LLM output against known Cube.js patterns and discards malformed metrics with a warning in the generation summary.
- What happens when the LLM generates duplicate metrics (same name as a profiler-generated field)? AI metrics use a naming convention that avoids collision with profiler fields, and any collisions are detected and resolved by appending a suffix.
- How does the system handle LLM rate limits or timeouts? The base model is generated independently of the LLM call. If the LLM times out (30-second limit), the model is saved without AI metrics and the user is notified.
- What happens when filters produce a very small dataset (e.g., 10 rows)? The profiler proceeds normally but flags in the profile output that the sample size is very small, which may affect metric accuracy.
- How does the dry-run preview interact with LLM enrichment? Dry-run (preview) does NOT call the LLM — it shows only profiler-generated field changes. The LLM is called only on the final apply step. AI metrics from the apply step are cached in the response so the change preview panel can display them post-apply.
- How do filters interact with the frontend's auto-profiling on reprofile? When reprofile opens the smart generation modal with pre-selected table/schema, the modal MUST NOT auto-start profiling. Instead, the parent component passes `previousFilters` as a prop (sourced from the last smart-generate response's `previous_filters` field, or from the profile-table response's `previous_filters` field if already available). The modal displays these in the filter builder and waits for the user to review/edit before manually triggering profiling. The profile-table endpoint MUST return `previous_filters` in its response when an existing model is found.
- What types can AI-generated measures use? AI measures may use any valid Cube.js measure type: aggregation types (`sum`, `avg`, `count`, `countDistinct`, `countDistinctApprox`, `min`, `max`, `runningTotal`) AND scalar types (`number`, `string`, `boolean`, `time`). The `number` type is the correct choice for derived calculations like ratios, percentages, and growth formulas (per Cube.js CubeValidator and official docs). AI dimensions use scalar types (`string`, `number`, `time`, `boolean`).
- How are filter values type-coerced? String values are escaped and single-quoted. Numeric values are validated as numbers and interpolated unquoted. Date values are treated as strings (single-quoted ISO format). Boolean values are mapped to 1/0. `IN`/`NOT IN` values are individually coerced per the column type. Empty `IN` arrays are rejected. `LIKE` values are treated as strings. `IS NULL`/`IS NOT NULL` take no value.

## Requirements *(mandatory)*

### Functional Requirements

#### Prerequisites (JS Model Support)

- **FR-P01**: Both reprofile entrypoints MUST work for JS model files: (a) the ModelsSidebar reload button (primary — already works for smart-generated files regardless of format), and (b) the CodeEditor "Regenerate" button (currently restricted to YAML via `isYamlFile` check at CodeEditor/index.tsx:145). Smart generation produces JS files; both entrypoints must support them.
- **FR-P02**: The merger module MUST parse and merge both YAML and JS model files. Currently `mergeModels()` only parses YAML via `YAML.parse()` — JS files fall through to replacement, which blocks AI metric retention and filter persistence. Note: `diffModels.js` already parses JS via `parseCubesFromJs()` using Node's `vm` module, so diff/preview is not affected.
- **FR-P03**: The existing-model analysis in the profile-table endpoint MUST correctly analyze JS files for `auto_generated` and `ai_generated` metadata, not assume all JS content is user-created.
- **FR-P04**: The serializer MUST NOT stamp `auto_generated: true` on AI-generated fields. Fields with `meta.ai_generated: true` are a distinct category and must not receive the `auto_generated` flag.

#### Filtered Introspection

- **FR-001**: System MUST accept a flat array of filter conditions (column, operator, value) alongside existing smart generation parameters. All filters are AND-ed together (conjunctive only — no OR combinators or nested groups in v1). Maximum 10 filter conditions per request.
- **FR-002**: System MUST support these filter operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `IN`, `NOT IN`, `LIKE`, `IS NULL`, `IS NOT NULL`.
- **FR-003**: System MUST apply filters as a WHERE clause to all profiler passes (schema discovery aggregates, initial profile, deep profile, LC probe). User filters MUST be AND-ed with the existing partition filter — partition is a security boundary and cannot be bypassed.
- **FR-004**: System MUST validate filter columns against the table schema before executing any queries, rejecting unknown columns.
- **FR-005**: System MUST safely escape filter values to prevent SQL injection. String values MUST be single-quoted with internal quotes doubled. Numeric values MUST be validated as numbers before interpolation. Column names MUST be validated against the table schema whitelist (never user-supplied raw strings). Empty `IN` arrays MUST be rejected. `LIKE` patterns are treated as escaped strings.
- **FR-006**: System MUST store applied filters in the model's cube-level `meta` section so they can be retrieved on regeneration.
- **FR-006a**: The merger MUST treat `generation_filters`, `ai_enrichment_status`, and `ai_metrics_count` as system-managed meta keys (like `auto_generated`, `generated_at`). These MUST be overwritten with new values on regeneration, not preserved from the old model.

#### LLM Metric Generation

- **FR-007**: System MUST send the profiled table structure (column names, types, cardinality, value ranges, descriptions) to OpenAI `gpt-5.4` after base model generation on every non-dry-run smart generation. Dry-run (preview) MUST NOT call the LLM — it returns only profiler-generated field changes. The LLM is called on the final apply step only.
- **FR-008**: System MUST include a structured prompt that instructs the LLM to generate Cube.js-compatible calculated measures and dimensions.
- **FR-009**: Every LLM-generated field MUST have `meta.ai_generated: true` and `meta.ai_model` identifying the model used.
- **FR-010**: Every LLM-generated field MUST have `meta.ai_generation_context` explaining the reasoning behind the metric.
- **FR-011**: System MUST validate LLM-generated SQL expressions before including them in the model. Validation includes: balanced parentheses/backticks, valid Cube.js template variables (`{CUBE}`, `{FILTER_PARAMS}`), no dangerous SQL keywords, valid measure/dimension types per CubeValidator, and verification that `{CUBE}.column_name` references exist in the profiled table's column list (catches hallucinated column names).
- **FR-012**: System MUST gracefully handle LLM failures (timeout, API error, malformed response) by completing model generation without AI metrics and notifying the user.

#### Superset Guarantee on Regeneration

- **FR-013**: On regeneration, system MUST extract all existing `ai_generated: true` fields from the current model and include them in the LLM prompt as "previously generated metrics to retain."
- **FR-014**: System MUST instruct the LLM to produce a superset of previously generated metrics — retaining all prior metrics whose source columns still exist.
- **FR-015**: System MUST detect and remove AI-generated metrics whose `source_columns` no longer exist in the table, surfacing these removals in the diff preview. `source_columns` MUST reference raw ClickHouse table column names (as returned by `DESCRIBE TABLE`), not generated Cube.js member names. The LLM prompt must instruct the model to populate `source_columns` with the raw column names the metric depends on.
- **FR-016**: System MUST preserve user edits to AI-generated field descriptions, treating them like user-created content during merge.

### Key Entities

- **Filter Condition**: Represents a single filter (column name, operator, value(s)). Applied during profiling to subset the data.
- **AI-Generated Metric**: A Cube.js measure or dimension created by the LLM, tagged with `ai_generated: true` in meta. Contains generation context and model version.
- **Generation Context**: Metadata stored per AI metric explaining why it was created (e.g., "Year-over-year comparison of revenue using created_at as time dimension").

## Clarifications

### Session 2026-03-15

- Q: Which OpenAI model should be used for metric generation? → A: `gpt-5.4` (current flagship, best coding/reasoning, most token-efficient)
- Q: How do user-supplied filters interact with the existing partition filter? → A: AND — user filters narrow within the existing partition. Partition is always enforced as a security boundary and cannot be bypassed.
- Q: Should LLM metric generation be always-on, opt-in, or opt-out? → A: Always on — every smart generation run includes LLM metric enrichment.
- Q: Where should the OpenAI API key be stored? → A: Environment variable (`OPENAI_API_KEY`) on the CubeJS service. Secrets are already managed in the fraios infra repo.
- Q: Is frontend UI (filter builder, AI metrics display) in scope? → A: Yes, full stack — backend API changes and frontend UI for filter builder and AI metrics display are both in scope.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can apply up to 10 filter conditions and receive a profiled model reflecting only the filtered data subset within the same time tolerance as unfiltered profiling (plus overhead of filter evaluation).
- **SC-002**: Smart generation with LLM enrichment produces at least 3 meaningful calculated metrics for any table with 2+ numeric columns and a date column. A metric is "meaningful" if it: (a) references at least one column from the profiled table, (b) has valid Cube.js SQL, and (c) is not a simple duplicate of a profiler-generated measure (e.g., not just another `sum` of the same column).
- **SC-003**: On regeneration of a model with existing AI metrics, 100% of still-valid prior AI metrics are retained in the output.
- **SC-004**: LLM failures do not block model generation — base models are always produced within the existing performance envelope.
- **SC-005**: Users can distinguish AI-generated metrics from profiler-generated and user-created fields by inspecting the meta section.
