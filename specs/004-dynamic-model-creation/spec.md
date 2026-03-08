# Feature Specification: Dynamic Model Creation

**Feature Branch**: `004-dynamic-model-creation`
**Created**: 2026-03-08
**Status**: Draft
**Input**: User description: "Dynamic Model Creation"

## Clarifications

### Session 2026-03-08

- Q: When a user triggers "Re-profile", what is the scope of the operation? → A: Re-profile targets a single model file (the one the user is viewing/selected).
- Q: When smart generation runs for a table that already has a standard-generated model, what happens? → A: Replace the standard-generated model with the new smart-generated model.
- Source table provenance: Each smart-generated model embeds its source table identity (database, table name, partition) in cube-level metadata so re-profile can resolve which table to re-introspect without external configuration.
- Array flattening UX: Smart generation is a two-step flow — first profile the table (discovering columns and array candidates), then present the profiling results with array flattening options before generating the final model.
- Internal tables: The list of tables subject to partition filtering is an explicit admin-configured list stored in team settings — not auto-detected or hardcoded.
- Map key limit: The maximum number of Map keys expanded per column defaults to 500 and is a system-level default. It can be overridden per generation request but is not persisted.
- Output format: Smart generation always produces YAML output. The YAML/JS format choice in the existing generation UI does not apply to smart generation.
- Opt-in: Smart generation is a new, separate path alongside existing standard generation. Standard generation continues to work exactly as before for all datasource types. Smart generation is opt-in (ClickHouse only).
- Joins preservation: Smart generation does not create, modify, or remove cube-to-cube `joins`. Any user-defined joins in an existing model are preserved during merge/re-profile. Same applies to `pre_aggregations` and `segments`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Profile and Generate Smart Models (Priority: P1)

A data analyst working with ClickHouse datasources in Synmetrix wants to generate rich, intelligent Cube.js data models from their tables. Instead of getting skeletal models that require extensive manual work, they select "Smart Generate" alongside the existing generation option. The system first profiles the selected table — discovering Map keys, detecting column types, identifying array structures — and presents a profiling summary. The user reviews the summary and confirms generation. The system then produces a YAML model with proper dimensions, measures, and Map key expansions. Each auto-generated field is tagged so the system knows it owns those fields. The generated cube-level metadata embeds the source table identity (database, table name) so the model can be re-profiled later without additional configuration.

**Why this priority**: This is the core value proposition. Without profile-driven generation, users must hand-build every Map key dimension, every measure aggregation, and every ARRAY JOIN cube manually. This story delivers the fundamental capability.

**Independent Test**: Can be fully tested by selecting a ClickHouse table, triggering smart generation, and verifying the output model contains profiled Map keys as dimensions/measures, correct type classifications, and auto-generated field tags.

**Acceptance Scenarios**:

1. **Given** a ClickHouse datasource with a table containing Map, Array, and scalar columns, **When** the user selects "Smart Generate" for that table, **Then** the system profiles the table and produces a Cube.js model with dimensions for string/date/UUID columns, measures for numeric columns, and individual fields for each discovered Map key.
2. **Given** a table with Map columns whose values are numeric, **When** smart generation runs, **Then** each discovered Map key becomes a separate measure field with the correct SQL access pattern (e.g., `{CUBE}.metrics['revenue']`).
3. **Given** a table with Map columns whose values are strings, **When** smart generation runs, **Then** each discovered Map key becomes a separate dimension field.
4. **Given** any smart-generated model, **When** the user views it in the editor, **Then** every system-generated field has a `meta.auto_generated: true` tag, and the model is valid Cube.js YAML.
5. **Given** a table with columns that contain no data (all nulls/empty), **When** smart generation runs, **Then** those columns are excluded from the generated model.
6. **Given** a table that already has a standard-generated model in the branch, **When** the user runs smart generation for that table, **Then** the standard-generated model is replaced by the new smart-generated model (the previous version remains in version history).

---

### User Story 2 - Re-Profile and Smart Merge Existing Models (Priority: P1)

A data analyst has previously smart-generated models but the underlying data has evolved — new Map keys have appeared, some columns were removed, and they've also added custom calculated fields to the model. They trigger "Re-profile" on the specific model file they are viewing. The system reads the source table identity embedded in the model's cube-level metadata (database, table name, partition), re-introspects that table, updates all system-managed fields (adding new ones, removing stale ones, updating types), and leaves all user-added custom fields completely untouched. Descriptions the user edited on auto-generated fields are preserved. Other model files in the branch are not affected.

**Why this priority**: Equal to P1 because without safe re-profiling, the initial generation becomes a one-shot tool. Data evolves constantly — Map keys appear, columns change. Users need confidence that re-profiling won't destroy their customizations.

**Independent Test**: Can be tested by generating a model, manually adding custom fields and editing descriptions on auto-generated fields, then triggering re-profile and verifying custom fields survive and descriptions are preserved.

**Acceptance Scenarios**:

1. **Given** a smart-generated model with user-added custom fields (no `auto_generated` tag), **When** the user triggers re-profile, **Then** all custom fields remain exactly as they were.
2. **Given** a smart-generated model where the user edited the description on an auto-generated field, **When** re-profile runs, **Then** the description is preserved even though other properties (SQL, type) may update.
3. **Given** a table where a Map key has been removed since the last profile, **When** re-profile runs, **Then** the corresponding auto-generated field is removed from the model.
4. **Given** a table where new Map keys have appeared since the last profile, **When** re-profile runs, **Then** new auto-generated fields are added for each new key.
5. **Given** re-profile completes, **When** the new version is saved, **Then** it is saved as an atomic new version (existing version history is preserved, not overwritten).
6. **Given** a smart-generated model with user content, **When** the profiling preview or re-profile UI is shown, **Then** merge options are displayed with "Preserve custom changes" defaulting to ON.
7. **Given** the user disables "Preserve custom changes" (selects replace strategy), **When** a confirmation warning is shown and the user confirms, **Then** the existing model is fully replaced with a clean smart-generated model and the previous version is preserved in history.
8. **Given** the user enables "Keep removed columns" during re-profile, **When** re-profile runs, **Then** auto-generated fields for columns no longer in the data are retained (not removed) alongside new fields.

---

### User Story 3 - ARRAY JOIN Flattened Cube Generation (Priority: P2)

A data analyst has a ClickHouse table with Array-typed columns (e.g., an array of product structs within an order event). Smart generation is a two-step flow: first, the system profiles the table and presents the profiling results — including discovered Array columns as ARRAY JOIN candidates. The user reviews the profiling summary, selects which arrays to flatten, and confirms generation. For each selected array, the system generates a separate "flattened" cube that uses `LEFT ARRAY JOIN` syntax, with the array elements expanded into individual queryable dimensions and measures.

**Why this priority**: ARRAY JOIN cubes are essential for analyzing nested data in ClickHouse (e.g., line items in orders, products in carts). However, the core profiling and Map key generation (P1) delivers value independently.

**Independent Test**: Can be tested by selecting a table with Array columns, reviewing the profiling summary, choosing to flatten one, and verifying the output includes a separate cube with ARRAY JOIN SQL and expanded element fields.

**Acceptance Scenarios**:

1. **Given** a table with Array-typed columns, **When** smart generation profiles the table, **Then** the profiling summary identifies all Array columns as candidates for ARRAY JOIN flattening before the user confirms generation.
2. **Given** the user selects an Array column for flattening in the profiling summary, **When** generation completes, **Then** a separate flattened cube is generated with `LEFT ARRAY JOIN` SQL syntax and the array elements as individual fields.
3. **Given** a flattened cube is generated, **When** the user views it, **Then** numeric array elements are measures (sum aggregation) and string elements are dimensions.
4. **Given** a flattened cube alongside the raw cube, **When** both are in the same model file, **Then** there are no field name collisions between them.

---

### User Story 4 - Partition-Scoped Profiling and Query Isolation (Priority: P2)

An administrator has configured a partition value for their team (e.g., `brimborg.is`). When any team member triggers smart generation on internal ClickHouse tables, profiling is automatically scoped to that team's partition — only their data is introspected. At query time, all queries against smart-generated models are automatically filtered to the team's partition, ensuring complete data isolation between tenants.

**Why this priority**: Partition isolation is critical for multi-tenant correctness. However, single-tenant deployments can use smart generation without partition configuration, making this separable from the core P1 story.

**Independent Test**: Can be tested by configuring a partition for a team, generating a model, and verifying profiling queries include the partition WHERE clause and runtime queries enforce partition filtering.

**Acceptance Scenarios**:

1. **Given** a team with a configured partition value, **When** smart generation runs on an internal table, **Then** all profiling queries include a WHERE clause filtering to that partition.
2. **Given** a smart-generated model for a partitioned team, **When** a user queries the model at runtime, **Then** the query is automatically filtered to the team's partition without the user specifying it.
3. **Given** a team with no partition configured, **When** smart generation runs, **Then** profiling runs without partition filtering (full table scope).
4. **Given** a datasource that is not an internal ClickHouse table, **When** queries run, **Then** no partition filtering is applied regardless of team settings.

---

### User Story 5 - Low-Cardinality Value Discovery (Priority: P3)

During profiling, the system detects columns with a small number of unique values (fewer than 200). These values are captured and embedded in the model metadata so the frontend can use them for filter dropdowns and autocomplete without additional database queries.

**Why this priority**: This is a UX enhancement that improves the querying experience but is not required for model generation or data correctness.

**Independent Test**: Can be tested by profiling a table with a low-cardinality column (e.g., `event_type` with 5 distinct values) and verifying the values appear in the model's field metadata.

**Acceptance Scenarios**:

1. **Given** a column with fewer than 200 unique values, **When** profiling runs, **Then** the actual values are enumerated and stored in the field's metadata.
2. **Given** a column with 200 or more unique values, **When** profiling runs, **Then** no value enumeration is performed (only cardinality count).
3. **Given** a Map column where individual keys have low cardinality, **When** profiling runs, **Then** the per-key LC values are captured in the corresponding field's metadata.

---

### User Story 6 - Primary Key Auto-Detection (Priority: P3)

During smart generation, the system automatically detects primary key columns from the ClickHouse table schema. Detected primary keys are marked accordingly in the generated model. Users can manually edit the primary key in the generated model after generation if the auto-detection is incorrect.

**Why this priority**: Primary key detection improves model correctness but has reasonable fallback behavior (users can manually set primary keys after generation).

**Independent Test**: Can be tested by generating a model for a table with known primary keys and verifying they are correctly detected and marked.

**Acceptance Scenarios**:

1. **Given** a ClickHouse table with defined primary keys, **When** smart generation runs, **Then** the primary key columns are detected and marked with `primary_key: true` in the model.
2. **Given** a table where no primary key can be detected, **When** smart generation runs, **Then** a sensible fallback is used (e.g., a commonly named ID column if present) or no primary key is set.

---

### Edge Cases

- What happens when a ClickHouse table has zero rows? The profiler should still generate a model from the schema but with no Map key expansions or LC values (since there's no data to profile).
- What happens when a Map column has thousands of keys? The system should impose a reasonable limit on the number of keys expanded into fields and report that the limit was reached.
- What happens when profiling a column fails (e.g., query timeout)? The system should continue profiling remaining columns and report which columns failed, generating the model without the failed columns.
- What happens when two Map keys from different columns produce the same sanitized field name? The system should detect the collision and disambiguate by prefixing with the column name.
- What happens when the user triggers smart generation on a non-ClickHouse datasource? The system should show an informative message that smart generation is only available for ClickHouse and offer the standard generation option.
- What happens when a re-profile produces a model identical to the existing one? No new version should be created (skip save when checksum matches).
- What happens when smart generation replaces a standard-generated model that the user has manually edited? The replacement proceeds (smart generation was explicitly requested), but the previous version with the user's edits is preserved in version history and can be restored.
- What happens when a user tries to re-profile a model that has no source table provenance metadata (e.g., a manually created model or a standard-generated model)? The "Re-profile" action should not be available for models without provenance metadata — it should only appear for smart-generated models.
- What happens when the admin has not configured any internal tables in team settings? Partition filtering is not applied to any table. Smart generation still works (profiling runs without partition scope), but runtime partition isolation is inactive.
- What happens when a user has added `joins` (cube-to-cube relationships) to a smart-generated model and then triggers re-profile? The `joins` block is preserved unchanged. Smart generation never creates, modifies, or removes joins — they are always user-owned content.
- What happens when a user has added `pre_aggregations` or `segments` to a smart-generated model? These sections are preserved unchanged during re-profile, same as joins.
- What happens when a smart-generated model has no user modifications at all (every field is auto-generated, no user-added joins/segments/pre_aggregations)? The model can be fully replaced without merge, since there is no user content to preserve.
- What happens when the existing model for a table is a `.js` file (not `.yml`)? Smart generation always creates `{table_name}.yml`. If a `.js` model exists for the same table, smart generation creates the `.yml` file alongside it — the `.js` file is left untouched. The profiling preview warns the user about the coexisting files. If the user wants to replace the `.js` file, they must delete it manually after generation.
- What happens during merge when a multi-cube YAML file has cubes added or removed (e.g., a new flattened ARRAY JOIN cube)? Cubes are matched by their `name` property. Existing cubes not in the new generation (e.g., a previously flattened cube whose array was deselected) are removed if auto-generated, preserved if user-created. New cubes are appended. Cube-level merge rules apply independently to each matched cube.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a "Smart Generate" option alongside the existing standard model generation, available only for ClickHouse datasources.
- **FR-002**: System MUST profile ClickHouse tables by introspecting both schema structure (column types) and data characteristics (cardinality, value distribution, Map keys, array contents). The profiling logic, SQL patterns, and field classification rules are a port of the proven Python prototype (`cxs-inbox/cube/profile_table.py` and `generate_cube_from_profile.py`) with improvements for modularity, error handling, and new features (merge, SSE progress, provenance tagging).
- **FR-003**: System MUST classify columns into categories: scalar (string, number, date, UUID, boolean), Map, Array, Nested, and Grouped — and generate appropriate Cube.js fields for each category.
- **FR-004**: System MUST expand Map columns by discovering all keys present in the data and generating a separate dimension or measure per key, with correct SQL access syntax.
- **FR-005**: System MUST tag every auto-generated field with `meta.auto_generated: true` to distinguish system-managed fields from user-created fields. Smart-generated cubes MUST also embed source table provenance (database, table name, partition) in cube-level metadata so re-profile can resolve the source table without external configuration.
- **FR-006**: System MUST perform field-level smart merge on re-profile: update auto-generated fields, remove auto-generated fields for columns no longer in the data, add new auto-generated fields, and never modify user-created fields.
- **FR-007**: System MUST preserve user-edited descriptions on auto-generated fields during re-profile.
- **FR-008**: System MUST generate flattened cubes with `LEFT ARRAY JOIN` syntax for user-selected Array columns, with array elements expanded into individual fields.
- **FR-009**: System MUST support partition-scoped profiling by filtering all profiling queries to the team's configured partition value.
- **FR-010**: System MUST enforce partition isolation at query time for smart-generated models on internal ClickHouse tables. Partition filtering MUST be embedded in the generated model's `sql` property as a WHERE clause (using `sql` instead of `sql_table`, not in queryRewrite) to ensure it applies regardless of user role, including owners and admins who bypass access-control checks.
- **FR-011**: System MUST enumerate values for low-cardinality columns (fewer than 200 unique values) and store them in field metadata.
- **FR-012**: System MUST auto-detect primary key columns from the ClickHouse table schema and mark them in the generated model.
- **FR-013**: System MUST save each generation/re-profile result as a new immutable version, preserving full version history.
- **FR-014**: System MUST skip version creation if the re-profile output produces an identical checksum to the current version.
- **FR-015**: System MUST handle profiling failures gracefully — if a column fails to profile, continue with remaining columns and report the failure.
- **FR-016**: System MUST impose a maximum limit on the number of Map keys expanded per column to prevent model bloat. The default limit is 500 keys per column. This default can be overridden per generation request but is not persisted between runs.
- **FR-028**: System MUST use sampling for large tables during profiling rather than full table scans. ClickHouse's `SAMPLE` clause or `LIMIT`-based sampling should be used when the table exceeds a row count threshold (e.g., 1M rows). Sampling must still produce accurate results for cardinality estimation, Map key discovery, and LC value enumeration. The profiling summary should indicate when sampling was used and the sample size.
- **FR-017**: System MUST filter out columns with no data (all nulls or empty) from the generated model.
- **FR-018**: System MUST only apply smart generation to ClickHouse datasources and show an informative message if attempted on other database types. Smart generation always produces YAML output — the YAML/JS format choice in the existing standard generation flow does not apply.
- **FR-019**: System MUST allow team owners to configure the partition value and internal tables list for their team.
- **FR-020**: System MUST provide a "Re-profile" action accessible from the models interface for previously smart-generated models. Re-profile operates on the single model file the user is currently viewing — other model files in the branch are unaffected.
- **FR-021**: System MUST replace an existing standard-generated model when smart generation is run for the same table. The replaced model remains accessible in version history.
- **FR-022**: Smart generation MUST follow a two-step flow: (1) profile the table and present a profiling summary showing discovered columns, Map keys, Array candidates, and column statistics, then (2) generate the model after the user reviews and confirms. This enables informed decisions about array flattening before model creation.
- **FR-023**: The list of internal tables subject to partition filtering MUST be an explicit admin-configured list stored in team settings — not auto-detected or hardcoded. Only tables on this list receive partition-scoped profiling and runtime query filtering.
- **FR-024**: Smart generation and re-profile MUST preserve all user-defined `joins` (cube-to-cube relationships), `pre_aggregations`, and `segments` in existing models. Smart generation does not create, modify, or remove these sections — they are always carried forward unchanged during merge.
- **FR-025**: When smart generation targets a table with an existing model, the system MUST default to a smart merge strategy (`"auto"`) that merges when user content is detected and replaces when no user content exists. The user MUST be able to override this default via merge options in the profiling preview UI. Available strategies: `"auto"` (smart default), `"merge"` (always preserve user content), `"replace"` (discard all existing content — with confirmation warning), `"merge_keep_stale"` (like merge but retain auto fields for columns no longer in data).
- **FR-026**: When the user selects `"replace"` merge strategy on a model that has user content, the system MUST show a confirmation warning that custom fields, joins, and descriptions will be discarded. The previous version is always preserved in history regardless of strategy chosen.
- **FR-027**: System MUST provide real-time progress feedback during profiling and model generation via Server-Sent Events (SSE). The frontend connects directly to CubeJS REST endpoints (which have their own JWT auth via `checkAuth`) for streaming. Progress events report the current step (schema analysis, column profiling batches, cube building, merging, version save), a human-readable message, and a numeric progress indicator. Hasura Actions remain available as a synchronous non-streaming path.

### Key Entities

- **Team Settings**: Team-level configuration including partition value and an explicit list of internal table names subject to partition filtering. Writable only by team owners. One settings record per team.
- **Profiled Table**: The result of introspecting a ClickHouse table — contains row count, column classifications, Map key inventories, cardinality statistics, LC value enumerations, and primary key information. Ephemeral (exists only during generation, not persisted). Presented to the user as a profiling summary before model generation (two-step flow).
- **Smart-Generated Model**: A Cube.js YAML model produced by profiling, containing auto-tagged fields alongside user-created fields. Stored as a dataschema within a version. May include a RAW cube and zero or more Flattened (ARRAY JOIN) cubes. Each cube embeds source table provenance (database, table name, partition) in its metadata to enable re-profiling without external configuration.
- **Field Tag (meta.auto_generated)**: A metadata marker on each field indicating whether the system manages it. Determines merge behavior during re-profiling. Fields without this tag are user-owned and immune to system changes.
- **Version**: An immutable snapshot of all dataschemas for a branch, identified by content checksum. Smart generation always creates a new version (unless content is identical).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can generate a complete, valid model from a ClickHouse table with Map columns in under 60 seconds (for tables with up to 100 columns and up to 500 Map keys total).
- **SC-002**: Re-profiling a previously generated model preserves 100% of user-created custom fields and 100% of user-edited descriptions on auto-generated fields.
- **SC-003**: Smart-generated models are immediately queryable after generation — no manual editing required to execute basic queries against profiled dimensions and measures.
- **SC-004**: Partition-scoped profiling and runtime query isolation produce identical results to manually adding WHERE clauses — zero data leakage between tenant partitions.
- **SC-005**: The smart generation option reduces the manual effort to create a production-ready model from a complex ClickHouse table by at least 80% compared to standard generation (measured by number of fields that must be manually added/modified).
- **SC-006**: Re-profiling correctly detects and reflects 100% of schema changes (new columns, removed columns, new Map keys, removed Map keys) without user intervention.
- **SC-007**: Users who have never used the system can successfully generate their first smart model within 3 minutes of selecting a datasource, without consulting documentation.
