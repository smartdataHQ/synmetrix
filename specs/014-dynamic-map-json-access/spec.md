# Feature Specification: Dynamic Map/JSON Field Access

**Feature Branch**: `014-dynamic-map-json-access`
**Created**: 2026-07-07
**Status**: Draft
**Builds on**: 013-mature-default-models (templates, reconciliation, query pre-processor)
**Research**: [013 research addendum](../013-mature-default-models/research.md#addendum-2026-07-07-dynamic-mapjson-field-access-research--feature-014) + `memory: project-map-json-dynamic-research`

The common data store keeps open-ended attributes in uniformly-typed Map columns (`dimensions` → strings, `metrics` → floats, `flags` → booleans) and a native ClickHouse JSON column (`properties`). Keys vary per row — effectively per event type — so materializing every observed key produces unusably complex models, while leaving keys unexposed makes the data unreachable. This feature makes dynamic attributes reachable **without any implicit member creation**: every model member remains a deliberate, versioned declaration; only the *key* is dynamic at query time. Guiding principle (product owner decision): **explicit over implicit**. Lazy/automatic member materialization is explicitly rejected.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Query any map key through canonical syntax (Priority: P1)

An analyst or dashboard issues a REST query referencing `SemanticEvents.dimensions.store_format` — a key that is not (and never will be) a declared member. The platform-defined pre-processing step (013 FR-015) rewrites the reference onto a **declared parameter-slot member** plus an injected key filter, before standard validation. The model gains zero members; the query works; results are scoped and typed correctly per the map's uniform value type.

**Why this priority**: this is the core promise — dynamic access with a fully explicit model. Everything else supports or feeds it.

**Independent Test**: query `dimensions.<key>` for a key present in the team's data → correct grouped values; the same query shape against a key the team's data lacks → empty groups (SQL-natural, documented); a query using more distinct keys than declared slots → deterministic, specific rejection.

**Acceptance Scenarios**:

1. **Given** a derived model with declared parameter slots, **When** a query references `SemanticEvents.dimensions.store_format` as a dimension, **Then** it is rewritten to the slot member with `dim_key_a = 'store_format'` injected, executes, and returns per-value groups.
2. **Given** a query referencing two distinct map keys (e.g. one `dimensions.*` dimension and one `metrics.*` measure), **When** pre-processed, **Then** each resolves to its own independent slot and both return correct values in one result set.
3. **Given** a query referencing more distinct keys of one map than that map has declared slots, **When** pre-processed, **Then** it is rejected deterministically with a specific error code listing the slot limit — never a generic validation error.
4. **Given** a query with no dynamic-syntax references, **When** pre-processed, **Then** it passes through byte-identical (013 guarantee preserved).

---

### User Story 2 - Discover available dynamic properties (Priority: P1)

A dashboard or the query composer calls a **dynamic property discovery endpoint** with a cube and an optional filter (typically `event = '<name>'`). The platform probes the team's slice of the map/JSON columns under that filter and returns a **directory of available properties in the same shape as cube.dev model metadata** — name, member type, value type, title, occurrence stats, and the ready-to-use query forms (canonical REST syntax and raw SQL) — so clients can construct extended queries programmatically. Results are cached for a short, configurable interval.

**Why this priority**: the syntax (US1) is only usable programmatically if clients can enumerate what keys exist *right now, under this filter*. Discovery + slots together replace member materialization.

**Independent Test**: call discovery filtered to one event → returns exactly that event's keys/paths with counts; call unfiltered → the full per-team directory; second call within TTL is served from cache (fast, identical); a member of another team calling with the same inputs receives only their own team's directory.

**Acceptance Scenarios**:

1. **Given** a team with data, **When** discovery is called for `SemanticEvents` filtered to one event name, **Then** the response lists only keys/paths occurring in that team's rows matching the filter, each with member-shaped metadata (`type`, value type, occurrence count, cardinality, sample values) and both query forms.
2. **Given** the same call repeated within the TTL, **When** served, **Then** it returns the cached directory without re-probing.
3. **Given** callers from two different teams, **When** each calls discovery with identical inputs, **Then** each receives only their own partition's directory (no cross-tenant leakage).
4. **Given** a JSON (`properties`) target, **Then** each path entry carries its observed dominant value type and a typed access form.

---

### User Story 3 - Event-scoped explicit models from templates (Priority: P2)

The platform team publishes **event-scoped templates** — one template cube per significant event type, its source pre-filtered to that event, declaring exactly the map keys/JSON paths that belong to it (the editorial registry). Reconciliation (013) tailors these per team: declared members whose key does not occur in the team's data under that event are pruned; **nothing is ever auto-added**. Teams see small, meaningful, per-event models (empirically ≤6 map keys, ≤12 JSON paths per event) instead of one flattened mega-cube.

**Why this priority**: this is the explicit backbone. It bounds model complexity by the axis that actually drives heterogeneity, and it rides the existing 013 rollout (canary, validation, template-wins) unchanged.

**Independent Test**: publish an event-scoped template with a key registry; reconcile two teams whose data differ → each team's cube contains only registry keys present in its own slice for that event; a registry edit rolls out through the standard 013 staged rollout.

**Acceptance Scenarios**:

1. **Given** an event-scoped template with `field_policy: explicit` and a declared key registry, **When** a team is reconciled, **Then** the derived cube contains exactly the registry members present in that team's data for that event — no probe-derived additions.
2. **Given** a registry key absent from a team's data, **When** reconciled, **Then** that member is pruned for that team (and reappears automatically once data arrives — 013 US3 drift).
3. **Given** a template without the explicit policy, **When** reconciled, **Then** behavior is unchanged from 013 (probe-derived fields added) — full backward compatibility.

---

### User Story 4 - JSON properties exposed by registry only (Priority: P3)

JSON (`properties`) paths are never auto-exploded into members. Exposure happens through the same editorial registry in templates, generating members with explicit type casts (dominant observed type). Unregistered paths remain reachable through discovery (US2) + slots (US1) or the SQL API.

**Acceptance Scenarios**:

1. **Given** a template registering `properties.user_needed_help_with` as string, **When** reconciled, **Then** the derived model contains a typed member using cast access, and compiles/queries correctly.
2. **Given** unregistered JSON paths in a team's data, **When** reconciliation runs, **Then** no members are created for them, and discovery still lists them.

---

### Edge Cases

- **Key with no data under current filter**: slot query returns empty groups — SQL-natural, documented; discovery is the tool that prevents composing such queries blindly.
- **Slot exhaustion**: more distinct keys than slots in one query → deterministic rejection (US1 #3). Slots per map are declared in templates (explicit), default 2.
- **Key name collisions with declared members**: `Cube.dimensions.<key>` syntax is namespaced by the map column name — it can never collide with an ordinary declared member reference.
- **Discovery on an empty partition**: returns an empty directory (not an error), consistent with 013 skeleton semantics.
- **Whole-map selection**: never generated and never produced by rewriting (driver hydration corrupts whole-map values — research finding); all access is element-level with scalar results.
- **JSON per-row type variance**: discovery reports the dominant type and its share; registered members cast explicitly; composer may surface mixed-type warnings.
- **Caching staleness**: a key arriving within the discovery TTL window is invisible for at most the TTL — accepted (short TTL).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support the canonical dynamic-access syntax `<Cube>.<mapColumn>.<key>` in REST queries against default models, implemented exclusively by pre-validation rewriting (013 FR-015 pipeline) onto declared parameter-slot members plus injected key filters. No member may ever be created implicitly by a query.
- **FR-002**: Parameter-slot members MUST be declared in templates (template-owned, `from_template`), with the slot count and aggregations per map column an explicit template decision; the platform default template ships 2 dimension slots (`dimensions`), 2 sum + 1 avg measure slots (`metrics`), and 1 boolean slot (`flags`).
- **FR-003**: A query consuming more distinct keys of one map than available slots MUST be rejected before standard validation with a specific, stable error code identifying the limit.
- **FR-004**: The rewrite MUST close the FILTER_PARAMS `1 = 1` hole: a slot member can never be evaluated without its key filter present.
- **FR-005**: The system MUST provide a dynamic property discovery endpoint that, given a cube and optional standard Cube filters, probes the caller's team slice and returns a directory of available map keys and JSON paths, shaped like cube.dev member metadata (name, member kind, type, title) enriched with occurrence count, coverage, cardinality, bounded sample values, and ready-to-use query forms (canonical REST syntax and raw SQL expression).
- **FR-006**: Discovery MUST enforce team partition scoping identically to queries (per 013 FR-005 mechanisms) and MUST be authenticated through the standard CubeJS auth path.
- **FR-007**: Discovery results MUST be cached per (team, cube, targets, filter) with a short configurable TTL; the response MUST state its freshness (generated-at + TTL).
- **FR-008**: Templates MUST support an explicit field policy: under `field_policy: explicit`, reconciliation prunes declared registry members absent from the team's data and adds nothing; the default policy preserves current 013 behavior unchanged.
- **FR-009**: Templates MUST support event-scoped sources (a template whose SQL pre-filters to one event type); per-team probing and pruning MUST respect the same event scope.
- **FR-010**: JSON (`properties`) members MUST only ever be created from a template registry entry, with an explicit type cast derived from the registered type; automatic JSON path explosion MUST NOT occur anywhere.
- **FR-011**: The SQL API remains the sanctioned fully-dynamic surface (arbitrary `dimensions['k']` / JSON expressions); this feature MUST NOT enable member expressions or subquery joins on the REST path.
- **FR-012**: Usage examples MUST ship with the feature: discovery→compose→query flows for REST (slots) and SQL API, covering map dimensions, map measures, flags, and JSON paths.

### Key Entities

- **Parameter Slot**: a template-declared member pair (key filter dimension + value member) whose SQL fetches a map element via FILTER_PARAMS; the only bridge between dynamic keys and the fixed model.
- **Editorial Registry**: the set of map keys/JSON paths a template explicitly declares as members; versioned and rolled out like any template content (013).
- **Dynamic Property Directory**: the discovery response — a filter-scoped, team-scoped, cached enumeration of available dynamic properties in member-shaped form.
- **Event-Scoped Template**: a template cube whose source is pre-filtered to one event type and whose members are governed by `field_policy: explicit`.

### Success Criteria

- **SC-001**: A query composer can go discovery → construct → execute for any map key present in a team's data without any model change, in under 3 seconds end-to-end (cold discovery included).
- **SC-002**: Warm discovery responses (cache hit) serve in ≤ 50ms p95; cold probes complete in ≤ 2s p95 per cube at current data volumes.
- **SC-003**: Zero implicit members: reconciliation of a `field_policy: explicit` template never adds a member not in its registry (asserted in tests); the visible member count of default models does not grow from query activity, ever.
- **SC-004**: Two distinct dynamic keys in one query return correct independent results (slot independence proven E2E).
- **SC-005**: All shipped examples execute successfully against a dev-stack team (validated in the walkthrough).
- **SC-006**: Discovery never returns another team's keys/paths (cross-tenant isolation test).

## Assumptions

- Map columns remain uniformly typed per column (platform convention, verified live: `dimensions`→String, `metrics`→Float32, `flags`→Bool); slot value typing relies on this.
- The 013 pre-processor, reconciliation pipeline, and template rollout machinery are in place and unchanged in their guarantees; this feature only extends the fixed rule set (the R1 "extension point" documented in 013) and the generation mode.
- FILTER_PARAMS-based member SQL compiles in the standalone validation gate (to be confirmed by the first implementation task; the 013 incident was description-string evaluation, not FILTER_PARAMS SQL).
- REST responses name result columns after the slot member (aliasing per query is not possible on REST) — composers map results back using their own request context; documented in examples.
- ClickHouse ≥ 25.3 (JSON type GA); the platform cluster runs 26.6.
- Discovery probe cost is acceptable at current volumes because probes are partition-pruned and filter-scoped; the TTL cache bounds repeat cost.
