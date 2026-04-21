# Feature Specification: Model Management API

**Feature Branch**: `011-model-mgmt-api`
**Created**: 2026-04-20
**Status**: Draft
**Input**: User description: "Model Management API"

## Context

Synmetrix exposes a semantic-layer platform whose core asset is a **cube model** — a YAML or JS file describing dimensions, measures, segments, and pre-aggregations over a source table. Models live inside *dataschemas*, which are grouped into immutable *versions*, which belong to *branches* attached to a *datasource*.

External agents (notably Tychi, an AI modelling assistant) already hold FraiOS-minted JWTs and can discover catalog state through the aggregated metadata endpoint, read/write dataschemas through the GraphQL proxy, and run profiling/smart-generation through existing endpoints. A gap analysis identified four missing capabilities that block an agent from owning the full author-to-publish lifecycle without human intervention:

1. No way to validate a draft model **in the context of** sibling cubes already deployed on a branch.
2. No way to invalidate the compiled-model cache after an in-place edit — stale models keep serving until a new version is inserted.
3. No way to remove a cube; only additive writes are supported today.
4. No first-class rollback, diff, or single-cube metadata query — agents must hand-assemble these from lower-level primitives.

The Model Management API closes those gaps so an authenticated agent can author, validate, persist, publish, compare, revert, and retire semantic-layer models without operator assistance.

## Clarifications

### Session 2026-04-20

- Q: Refresh cache blast radius → A: Compiler cache only, scoped to the target branch's dataschemas. Pre-aggregation cache and user-scope caches are untouched.
- Q: Refresh execution model (sync vs async) → A: Asynchronous invalidation. The endpoint evicts cache entries and returns immediately; the next metadata or query request triggers recompilation and surfaces any compile errors on that downstream request.
- Q: Rollback blast radius → A: Dataschemas only. The new version contains cloned dataschemas; explorations, alerts, and other version-bound entities are untouched and keep pointing at their original version.
- Q: Cross-cube reference types that block deletion → A: All compiler-resolved references by cube-qualified name — joins, extends, sub_query references, measure/dimension formula references, segment inheritance, pre-aggregation rollup references, and FILTER_PARAMS.<cube>.* self-references.
- Q: Draft mode vocabulary for contextual validation → A: Keep the proposed vocabulary — append, replace, preview-delete. It describes what change the draft represents; the smart-generation mergeStrategy (merge/replace/auto) describes how to combine outputs and is a separate concern.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Contextual Validation Before Publish (Priority: P1)

A modelling agent has drafted a new or updated cube file. Before persisting it, the agent needs to know whether the draft compiles cleanly **alongside** the cubes already published on the target branch, because most compile errors arise from cross-cube references (shared joins, segment inheritance, measures that reference measures on other cubes) that a file-local syntax check cannot detect.

**Why this priority**: This is the single largest blocker to autonomous model edits. Without it every agent-authored change is gated on a human restarting the compiler service and inspecting logs. It unlocks the entire author-validate-publish loop.

**Independent Test**: Submit a draft file plus a target branch identifier; receive a deterministic pass/fail report that lists compile errors with file, line, and message. Works with the existing authenticated flow; no other new capability is required.

**Acceptance Scenarios**:

1. **Given** a syntactically valid draft that references a dimension defined in another deployed cube, **When** the agent submits it for contextual validation against the active branch, **Then** the response confirms the draft compiles successfully in that branch context.
2. **Given** a draft whose identifier collides with an existing cube in the branch, **When** the agent submits it with mode "append", **Then** the response lists the collision with the conflicting cube name and file.
3. **Given** a draft that references a dimension which does not exist on any cube in the branch, **When** the agent submits it, **Then** the response flags the unresolved reference with line and column of the offending token.

---

### User Story 2 - Force Model Refresh After Edit (Priority: P1)

An agent edits a deployed dataschema in place (same dataschema identifier, new source code). Downstream users querying the load endpoint continue to receive results from the previously compiled model because the compiler cache is keyed by dataschema identifier, not content. The agent needs a single request that guarantees subsequent queries use the updated model.

**Why this priority**: Without it, the only reliable refresh path is to insert a whole new version, which inflates version history, churns the UI, and invalidates exploration URLs that embedded the previous version identifier. Fixes a correctness issue already flagged in the Tychi skill's caveats.

**Independent Test**: After editing a cube's source-code column in the database, call the refresh endpoint for that branch; subsequent metadata and query requests must reflect the new definition within a bounded refresh interval.

**Acceptance Scenarios**:

1. **Given** a deployed cube with measure `total_revenue`, **When** the agent updates the dataschema's source code to add measure `average_revenue` and calls the refresh endpoint for that branch, **Then** the next catalog discovery response includes `average_revenue` for that cube.
2. **Given** a refresh request for a branch the caller cannot access, **When** the request is authenticated but unauthorised, **Then** the response is rejected without side effects.

---

### User Story 3 - Remove a Cube from the Active Model (Priority: P1)

Agents occasionally need to retire a cube — because it was a draft, because the source table was dropped, or because a refactor merged it into another cube. Today the only way to remove a cube is to author a new version that omits it, which forces a full-snapshot write for a deletion semantic.

**Why this priority**: Without a deletion primitive, refactor workflows balloon: renaming a cube leaves the old cube visible because the previous dataschema row is still attached to the active version. Required for the refinement passes that the Tychi skill already expects to perform.

**Independent Test**: Call the deletion endpoint for a specific dataschema; after the call, the cube no longer appears in the catalog for that branch, and a subsequent query for that cube returns "not found".

**Acceptance Scenarios**:

1. **Given** a branch with three cubes, **When** the agent deletes one dataschema by identifier, **Then** the next catalog discovery returns only the remaining two cubes on that branch.
2. **Given** a dataschema the caller has no owner or admin role over, **When** the agent attempts deletion, **Then** the request is rejected and the cube remains intact.
3. **Given** a deletion request for a dataschema that belongs to a non-active (historical) branch version, **When** the request is submitted, **Then** the historical version remains immutable and the request is rejected with an explanatory error.

---

### User Story 4 - Inspect a Single Cube's Compiled Definition (Priority: P2)

Agents reviewing or refining an existing cube frequently need only that cube's compiled metadata (measures, dimensions, segments, hierarchies, annotations). Today the only option is to fetch every cube's metadata for the datasource and filter client-side, which wastes bandwidth and forces the agent to hold state it will not use.

**Why this priority**: Quality-of-life improvement. Reduces payload by one to two orders of magnitude on large datasources and simplifies agent code. Not a blocker.

**Independent Test**: Request a specific cube by name on a specific branch; receive only that cube's compiled metadata envelope, or a "not found" response if it does not exist.

**Acceptance Scenarios**:

1. **Given** a branch containing a cube named `orders`, **When** the agent requests the single-cube metadata for `orders`, **Then** the response contains exactly the `orders` envelope with its measures, dimensions, segments, and meta block.
2. **Given** a cube name that does not exist on the branch, **When** the agent requests single-cube metadata, **Then** the response is a clean "not found" with the branch context included.

---

### User Story 5 - Diff and Roll Back Between Versions (Priority: P2)

When an agent publishes a breaking change, the user needs a way to see what changed and — if necessary — revert to the prior version without hand-copying source code. Likewise, agents want to present a diff to the user before committing as an explicit confirmation step.

**Why this priority**: Important for trust and safety of agent-driven edits, but workflows can continue without it (diff can be computed externally). Rollback is low-frequency but high-consequence.

**Independent Test**: Fetch a diff between two version identifiers on the same branch; receive an itemised list of added, removed, and modified cubes. Call rollback with a target version identifier; the branch's active version becomes the target's content.

**Acceptance Scenarios**:

1. **Given** two versions on the same branch that differ by one cube, **When** the agent requests a diff between them, **Then** the response identifies which cubes were added, removed, and modified, with the changed fields for each.
2. **Given** a branch whose current active version has introduced a regression, **When** the agent requests rollback to the prior version, **Then** a new version identical in content to the prior one is inserted and made active on the branch.

---

### Edge Cases

- Validation of a draft whose file name matches an existing dataschema but whose cube identifier differs — collision is on the file name, not the cube name; must report both facts.
- Refresh called against a branch that has never been compiled (no cached entry) — must be a successful no-op, not an error.
- Deletion of a cube currently referenced by another cube on the same branch (through any of the reference kinds enumerated in FR-008) — must reject with a dependency explanation rather than leaving a dangling reference.
- Rollback to a version that predates a source-schema migration — must reject if the referenced source columns no longer exist in the datasource.
- Single-cube metadata request where the user has partial visibility (row-level security hides some measures) — must return only the visible subset, matching the filtering applied by the aggregate metadata endpoint.
- Diff between versions on different branches — must reject; diffs are scoped to a single branch's history.
- Concurrent edit plus refresh plus query — refresh must be idempotent under concurrency and must not serve a partially compiled view.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow an authenticated agent to submit a draft model file and receive a pass/fail compile report that reflects compilation in the context of all other cubes currently published on a specified branch.
- **FR-002**: The contextual validation MUST distinguish between three draft modes — "append" (draft is a new cube not yet on the branch), "replace" (draft overwrites an existing dataschema's source code), and "preview-delete" (draft represents removal of a cube) — and MUST report any naming or reference conflicts specific to the chosen mode.
- **FR-003**: The contextual validation response MUST include a structured list of errors and warnings, each with file name, line number, column, severity, and human-readable message.
- **FR-004**: The system MUST allow an authenticated agent to force a refresh of the **compiled-model cache** entries belonging to a specific branch's dataschemas, such that subsequent metadata and query requests reflect the current database state within the bound defined in SC-002. The refresh MUST NOT invalidate the pre-aggregation cache or user-scope caches of any caller. Refresh is a cache-only operation and is NOT classified as a mutating operation for FR-016 purposes; a non-durable structured log line captures it for operational visibility.
- **FR-004a**: The refresh operation MUST be asynchronous: the endpoint evicts the relevant cache entries and returns success as soon as eviction is complete, without blocking on recompilation. The next metadata or query request for the branch triggers recompilation, and any compile failure surfaces on that downstream request — not on the refresh response itself.
- **FR-005**: The refresh operation MUST be idempotent **per (branch, schemaVersion) pair**. Two refresh calls against the same `(branch, schemaVersion)` MUST do the same work: the first evicts the cache entries for that `schemaVersion`, and the second finds nothing to evict. If the branch's dataschemas change between the two calls (new `schemaVersion`), the second call is a different logical operation and is permitted to evict the new set. Idempotence is NOT wall-clock-bound.
- **FR-006**: The system MUST allow an authenticated agent with owner or admin authority over a datasource to delete a specific dataschema, subject to FR-007 and FR-008.
- **FR-007**: The system MUST refuse deletion requests that target a dataschema attached to any version that is **not the latest version of the currently active branch**. All older versions of the active branch are immutable snapshots; all versions of any non-active branch are likewise immutable. Only dataschemas attached to the single currently-compiled version (the newest version on the active branch) are eligible for deletion.
- **FR-008**: The system MUST refuse deletion requests that would leave dangling cross-cube references. A blocking reference is any reference to the target cube by its cube-qualified name from another cube on the same branch, including: (a) `joins` entries, (b) `extends` chains, (c) `sub_query` measures/dimensions, (d) measure-to-measure and dimension-to-dimension formula references, (e) segment inheritance, (f) pre-aggregation rollup references, and (g) `FILTER_PARAMS.<cube>.*` self-references. The error response MUST identify each blocking reference by referring cube name, file, and the reference kind from this list.
- **FR-009**: The system MUST allow an authenticated agent to request the compiled metadata for a single named cube on a specific branch, and MUST return a "not found" response (not an empty list) when the cube does not exist.
- **FR-010**: The system MUST apply the same visibility and access-list filtering to single-cube metadata requests as it applies to the aggregate catalog endpoint.
- **FR-011**: The system MUST allow an authenticated agent to request a structured diff between any two versions on the same branch, identifying added, removed, and modified cubes and — for modifications — the names of the changed measures, dimensions, and segments.
- **FR-012**: The system MUST refuse diff requests spanning versions on different branches and MUST return an explanatory error.
- **FR-013**: The system MUST allow an authenticated agent with owner or admin authority to roll a branch back to a prior version by creating a new version whose dataschemas are identical in content to the target version. The newly inserted version becomes the branch's active version by virtue of being the newest version on the branch — under the platform's existing "latest version wins" semantic; no explicit activation step is required.
- **FR-013a**: Rollback MUST clone **only** the dataschemas of the target version. It MUST NOT modify, clone, or rebind other entities that reference a version identifier (explorations, alerts, or any other version-bound records). Such entities remain associated with their original version identifiers.
- **FR-014**: Rollback MUST preserve the full version history; it MUST NOT delete or modify the intervening versions.
- **FR-015**: All operations MUST accept the same authentication tokens already accepted by the existing catalog and discovery endpoints, and MUST apply the caller's team partition and access list before any action. **Every mutating operation** — `validate-in-branch` with `mode != append`, `refresh-compiler`, `delete-dataschema`, `version-rollback` — MUST additionally require **owner or admin** role on the target datasource's team. Refresh requires the same bar as delete and rollback because it affects the compiled view that every other user of the branch sees. Read-only operations (`meta/cube/:cubeName`, `version/diff`, and `validate-in-branch` with `mode == append`) require only team membership.
- **FR-016**: The system MUST persist a **durable audit record** for each attempted persistent mutating operation — delete and rollback — **on every outcome path, success and failure alike**. A record MUST be written when the operation is rejected by authorization, blocked by cross-cube references (FR-008), blocked by historical-version immutability (FR-007), rejected by source-column drift (rollback), rejected by partition gate (FR-015), or Hasura-rejected, as well as on success. Each record captures: caller user identity, action, branch identifier, datasource identifier, target identifier, outcome (`success` or `failure`), error code (non-null when `outcome = failure`), an operation-specific JSON payload, and the timestamp. The audit store MUST be queryable and retained for at least ninety days. Refresh is exempt (see FR-004) because it is a cache-only operation; refresh emits a non-durable structured log line for operational visibility only.
- **FR-017**: The system MUST return machine-readable, stable string error codes for every failure mode exposed by the API. Every code MUST appear in at least one OpenAPI contract under the feature's `contracts/` directory, and the full set of codes MUST be exposed as a single importable enumeration for client use.

### Key Entities

- **Dataschema**: A single model file authored by a user or an agent. Attributes: identifier, file name, source code, checksum, owning user, attached version.
- **Version**: An immutable snapshot of dataschemas on a branch. Attributes: identifier, parent branch, creation time, authoring user, attached dataschemas. Versions are never mutated after creation.
- **Branch**: A named workspace on a datasource. Attributes: identifier, name, status (`active` | `created` | `archived`), parent datasource. One branch per datasource carries the "active" status at a time; the other values denote non-active (historical) state.
- **Datasource**: A connected database exposed for modelling. Attributes: identifier, name, database type, owning team.
- **Compile Report**: The structured result of attempting to compile a set of dataschemas together. Attributes: validity flag, error list, warning list; each error or warning carries file, line, column, severity, code, and message.
- **Version Diff**: The structured result of comparing two versions on the same branch. Attributes: added cubes, removed cubes, modified cubes, and per-modification field-level changes.
- **Audit Record**: A durable log entry describing a persistent mutating action. Persisted in a dedicated audit store. Attributes: identifier, timestamp, action, caller user identity, branch identifier, datasource identifier, target identifier, outcome, error code (nullable), and an opaque JSON payload for operation-specific detail. Retained for at least ninety days.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An agent can take a draft cube from authored to published on an active branch — with contextual validation, refresh, and (when applicable) deletion of a predecessor cube — without a human operator touching the server, in under five minutes end-to-end for a typical single-cube change.
- **SC-002**: After any in-place dataschema edit followed by the refresh operation, the next catalog or query response reflects the new definition at least ninety-five percent of the time within ten seconds, and one hundred percent of the time within sixty seconds.
- **SC-003**: Contextual validation correctly identifies every cross-cube reference error that the full compiler would raise on deploy; the false-negative rate (validator passes but deploy fails) is zero measured over a curated corpus of known-broken drafts.
- **SC-004**: Rollback to any prior version on a branch completes in under thirty seconds and produces a version whose content is byte-identical to the target version for every dataschema.
- **SC-005**: The single-cube metadata response is at least ninety percent smaller than the aggregate metadata response on datasources carrying ten or more cubes.
- **SC-006**: Deletion of a dataschema that leaves no dangling references removes the cube from the catalog within the refresh bound defined in SC-002.
- **SC-007**: Every attempted persistent mutating operation (delete, rollback — per FR-016) produces a durable audit record on **every outcome path** (success, authorization-rejected, blocked-by-references, blocked-by-historical-version, rejected-by-partition, Hasura-rejected, source-columns-missing), uniquely identifying the caller, the target, and the outcome, with zero dropped records measured over a one-week observation window.
- **SC-008**: No caller lacking owner or admin authority succeeds in performing a mutating operation; authorisation rejection rate is one hundred percent for unauthorised callers across the combined test suite.

## Assumptions

- The existing authentication verification paths, the partition filter, and the team-role authorisation pattern already applied by the GraphQL proxy and the catalog endpoints are reused without modification.
- **Agent identity role.** Any agent (including Tychi) that intends to call a mutating endpoint — `refresh-compiler`, `delete-dataschema`, `version-rollback`, or `validate-in-branch` with `mode=replace`/`preview-delete` — MUST connect with a FraiOS identity whose resolved Synmetrix user has **owner or admin** role on the target datasource's team. Read-only calls (`meta/cube/:cubeName`, `version/diff`, `validate-in-branch` with `mode=append`, and every existing catalog endpoint) require only team membership. This is a deployment precondition; the feature enforces the gate but does not provision the role.
- **Agent discovery path.** Agents resolve cube-name → `dataschema_id` via the two new fields (`dataschema_id`, `file_name`) added to every cube summary in `/api/v1/meta-all`. Agents resolve branch-version history (for diff and rollback) via direct Hasura GraphQL against the `versions` table. No dedicated list-versions endpoint is introduced; the Hasura query is already available to every authenticated caller through the GraphQL proxy.
- **Single-cube metadata is current-version only.** `/api/v1/meta/cube/:cubeName` always returns the latest version of the requested branch. Historical-version cube introspection remains available through Cube.js's built-in `/api/v1/meta` aggregate endpoint with `x-hasura-branch-version-id`.
- **FraiOS just-in-time provisioning.** The first call from a previously-unseen FraiOS identity triggers user + team + member + role provisioning (`provisionUserFromFraiOS`). This adds roughly one to two hundred milliseconds to that one call; subsequent calls hit the in-memory identity cache.
- Dataschema, branch, and version identifiers remain universally unique and opaque to agents; agents discover them through the existing aggregated catalog and discovery endpoints.
- The compile semantics used by contextual validation match those used by the query compiler during execution; validation draws from the same compiler library rather than a heuristic parser.
- Durable audit records (delete, rollback) are written to a new `audit_logs` table introduced by this feature's Hasura migration. Existing Hasura event triggers are the transport. No new dashboard is in scope, but the table MUST be selectable via the standard Hasura admin role so operators can query it directly.
- Cache refresh latency is bounded by the underlying compiler's cold-start time, which is already acceptable in the current deployment; this specification does not impose tighter performance targets than the current baseline.
- Rollback inserts a new version rather than mutating history, matching the existing immutability invariant on the version entity.
- Deletion semantics operate at the dataschema granularity. Removing an entire branch or datasource is out of scope and remains handled by existing permissions or operator tooling.

## Out of Scope

- Any changes to the datasource connection flow or credential vault behaviour.
- Branch creation, renaming, or publishing — already supported by existing permissions.
- Fine-grained field-level row security beyond what the existing access-list mechanism already enforces.
- Backfilling audit records for past mutations.
- Real-time push notification of model changes to other connected clients; existing polling through the catalog endpoint is sufficient.
- User interface or dashboard work; this specification is scoped to the server-side capability.
