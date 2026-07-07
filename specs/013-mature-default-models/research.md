# Phase 0 Research: Mature Default Models

**Date**: 2026-07-06 | **Spec**: [spec.md](./spec.md)

All unknowns resolved. Findings below were verified directly against the codebase and the installed Cube.js packages during design research (file:line citations are to the current working tree). No NEEDS CLARIFICATION markers remain — the three spec-level policy questions (conflict, opt-out, day-one rules) were resolved with the product owner on 2026-07-06 and are encoded in spec FR-012/FR-013/FR-016.

## Verified platform facts the design rests on

- **Schema loading**: per-request compilation fetches dataschema rows by the ID list carried in the security context — `repositoryFactory.js:16-21` → `findDataSchemasByIds`. File contents are never embedded in the context.
- **Cache keying**: compiler-cache appId = `CUBEJS_APP_${dataSourceVersion}_${schemaVersion}}` where `schemaVersion = md5(dataschema row IDs)` (`buildSecurityContext.js:45-53`, `index.js:45-49`). New version ⇒ new row IDs ⇒ new key. Per-team caching of derived models is therefore automatic; no invalidator changes needed.
- **Gateway order** (decisive for the pre-processor): in `@cubejs-backend/api-gateway/dist/src/gateway.js:898-952`, `normalizeQuery` (Joi structural validation) runs **before** `applyRowLevelSecurity` → `queryRewrite` → second `normalizeQuery`; member-existence validation happens later in `getSql`. `queryRewrite` therefore cannot transform a query "before validation".
- **Middleware mount point**: custom routes mount at `services/cubejs/index.js:100`, **before** `cubejs.initApp(app)` at `:102`, with JSON body parsing already applied (`:37`). Express middleware there sees `/api/v1/load|dry-run|sql` requests before the gateway.
- **Generation pipeline**: multi-pass ClickHouse profiler (`smart-generation/profiler.js`), cube building with baked partition scoping (`cubeBuilder.js:251-252`), YAML output, merge with user-content preservation (`diffModels.js:52-153`, `merger.js`), checksum no-op guard (`smartGenerate.js:824-860`), persistence as new immutable version with nested dataschemas (`dataSourceHelpers.js:179-187, 287-298`).
- **Default datasource seeding**: `provisionDefaultDatasources.js` creates per-team datasources **matched by name** from `/etc/synmetrix/default-datasources.json` (skip-by-name `:66-71`), with `db_params` from config and password from env (`:73-87`).
- **Scheduling**: Hasura cron triggers → `POST {{ACTIONS_URL}}/rpc/<method>` (`cron_triggers.yaml`); Actions dispatches `rpc/<method>.js` dynamically (`actions/index.js:50-81`). Cron posts have no user session; internal writes use the Hasura admin-secret path (pattern: `recalculateDataschemas.js`, `smartGenerate.js:282-284`).
- **Query rewrite rules**: `query_rewrite_rules` table keyed by **source table name**; injects per-team property filters and hard-blocks when a required property/dimension is missing (`queryRewrite.js:180-265`); applies to REST **and** SQL-API cube queries; owner tampering with rule-linked team settings is already prevented (`updateTeamSettings.js:74-87`).
- **ClickHouse partition pruning** on per-account probes: confirmed acceptable by the platform owner ("ClickHouse handles this perfectly").

## Decisions

### D1. Template store — platform-owned datasource, templates as ordinary models
**Decision**: Global templates live as normal dataschemas on the active branch of an fftech.is-owned "Global Templates" datasource, identified by env config (`DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID`). "Publish" = saving a new version (existing flow). Template identity = cube name; template version = the version row's `checksum`.
**Rationale**: platform admins get the full existing authoring experience (editor, validation, versioning, diff, rollback — FR-001) with zero new UI or storage.
**Alternatives**: files in repo/config (no UI, deploy per edit); new `templates` table (duplicate of the versioning machinery — YAGNI).

### D2. Derived-model home — team's existing default datasource, matched by name
**Decision**: derived models are written to the team's platform-provisioned datasource, resolved by the configured name (same name used by `provisionDefaultDatasources.js`). If missing, provision it first via the existing function.
**Rationale**: the seeding mechanism this feature "matures" already establishes name-as-identity per team; the datasource already carries working ClickHouse credentials.
**Alternatives**: new marker column on `datasources` (migration for something a config string already gives); connection fingerprint matching (fragile).

### D3. Tailoring — existing smart-gen profiler, partition-scoped, scoping baked
**Decision**: per-team generation reuses `profileTable`/`buildCubes` scoped to the team's partition; the `partition = '<team>'` literal stays baked into generated SQL exactly as today (`cubeBuilder.js:251-252`) — correct because each copy is team-owned.
**Rationale**: FR-004/FR-005 with zero new probe code; baked scoping is stronger than runtime-only injection.
**Alternatives**: shared model + runtime-only partition injection (rejected earlier design iteration — weaker isolation, single blast radius across all teams).

### D4. Merge/conflict — template-provenance class, template wins
**Decision**: new `templateMerger.js` extends the diff/merge engine with a third provenance class: **template-owned** fields converge to the template on every reconciliation; **probe-derived** (`meta.auto_generated`) fields regenerate; **team-added** fields persist (existing user-content preservation). Team edits to template-owned fields are overwritten (FR-012), visibly, as a system-authored version.
**Rationale**: matches the resolved conflict policy; smallest extension to an engine that already does field-level classing (`diffModels.js:95-153`).
**Alternatives**: full replace (destroys team content — violates FR-011); flag-and-hold (creates an ops queue that grows with team count — rejected by product owner).

### D5. Provenance metadata
**Decision**: cube-level `meta: { default_model: true, template: <name>, template_checksum: <hash> }`; template-owned fields carry `meta.from_template: true`. Drives reconciliation matching, pre-processor scoping, collision detection, UI badge (later), and "which teams are behind" reporting.
**Rationale**: `meta` flows through generation, YAML, and compiled metaConfig already; no schema changes.
**Alternatives**: naming convention only (breaks on rename; can't carry checksum); DB join table (state duplicated outside the model files, drifts).

### D6. Triggers — cron detection + onboarding hook; no Hasura event trigger
**Decision**: a `reconcile_default_models` cron (every 15 min) runs the orchestrator; it compares the template branch's latest version checksum against the last completed run (template-publish detection) and runs data-drift refresh on its schedule. Team creation fires a single-team reconcile (fire-and-forget from `provision.js`) to meet SC-001's 10-minute bound.
**Rationale**: FR-007's three triggers with one cron + one call-site touch; 15-min detection is far inside SC-002's 24h.
**Alternatives**: Hasura event trigger on `versions` insert (extra moving part, needs filtering to one datasource, YAGNI given cron cadence).

### D7. Change detection — one fleet-wide probe + checksums
**Decision**: per run: (a) template checksum vs last run (template change), (b) one `SELECT partition, count(), max(<timeColumn>) ... GROUP BY partition` per configured drift target (`DEFAULT_MODELS_DRIFT_PROBES`: JSON `[{table, timeColumn}]`) — data drift for ALL teams in one query per table, (c) the existing per-team no-op checksum guard as the final gate. Teams with no change are skipped before any per-team probing.
**Rationale**: SC-006/SC-007 — full-fleet cost stays near-zero when nothing changed; expensive multi-pass profiling runs only for changed teams.
**Alternatives**: always re-profile every team (hours per run, version churn risk); per-team change probes (N queries where one suffices).

### D8. Rollout staging — deterministic cohorts, canary-first, halt threshold
**Decision**: cohort = hash(team_id) mod N (deterministic across runs); canary cohort = fftech.is's own team plus configured team IDs; rollout proceeds cohort-by-cohort and halts when per-cohort failure rate exceeds a configured threshold (default 20%). State lives on the `reconciliation_runs` row.
**Rationale**: FR-010/SC-003; deterministic assignment makes reruns and debugging predictable.
**Alternatives**: random cohorts (non-reproducible); all-at-once with validation only (validation catches compile breakage but not systematic template mistakes that validate yet mislead — canary adds a human window).

### D9. Validation gate — in-memory compile before publish, per team
**Decision**: before writing a team's new version, compile the candidate file set in-memory (the `validateInBranch.js` `prepareCompiler` pattern). Failure ⇒ previous version stays live, outcome recorded `failed`, run continues (FR-009, FR-018).
**Rationale**: existing, proven validation path; per-team blast radius containment.
**Alternatives**: publish-then-verify (a team would be broken between publish and verify — violates SC-003).

### D10. System identity
**Decision**: a dedicated system user (env `DEFAULT_MODELS_SYSTEM_USER_ID`) owns all reconciliation-authored versions (`versions.user_id`), satisfying FR-014 attribution in existing version history UI.
**Rationale**: `versions.user_id` already exists and is displayed; no schema change.
**Alternatives**: NULL user_id (breaks FK/history display); per-run pseudo-users (noise).

### D11. Opt-out storage — `team.settings.default_models.opt_out`
**Decision**: per-template opt-out stored as `team.settings.default_models = { opt_out: ["<template name>", ...] }`, editable by team owners via the existing `updateTeamSettings` RPC (the key is not rule-linked, so it is not stripped by `updateTeamSettings.js:74-87`). Reconciliation skips opted-out templates; deletion without opt-out ⇒ recreated (FR-013).
**Rationale**: matches resolved policy; zero migration; existing owner-gated write path.
**Alternatives**: new table (migration + permissions for one array); member-level opt-out (opt-out is a team decision).

### D12. Pre-processor placement and behavior
**Decision**: Express middleware (`queryPreprocessor.js`) mounted before `cubejs.initApp(app)` (verified mount point `index.js:100-102`), intercepting GET/POST `/api/v1/load`, `/api/v1/dry-run`, `/api/v1/sql`, handling single and array (blending) queries and the GET JSON-string form. Team identity from the JWT `partition` claim (legacy hasura-backend-plus tokens lack it — fall back to `x-hasura-user-id` → membership → `team.settings.partition`, cached; unresolvable ⇒ pass through). The team's derived-model member map comes from `defaultModelMeta.js`: an admin-secret, read-only resolution partition → team → target datasource (by configured name) → active branch → latest version, whose dataschema ID set yields the schemaVersion for the cache key (partition + schemaVersion, TTL ≤ 30s, same md5 as `buildSecurityContext`); the map is built by parsing the raw dataschema files (the `buildCubeToTableMap` precedent, `queryRewrite.js:99-151`) — NOT via compiled meta, which would risk a 15-30s cold compile on the query path. Rules (`defaultModelRules.js`, fixed in code per FR-016): (a) **scoping enforcement** — verify the query targets only default-model members compatible with the team scope and inject the canonical scope filter as belt-and-braces; (b) **canonical translation** — map canonical member names to the team's variant; references to members absent from the variant produce a deterministic 400 with a specific error code (or a defined adaptation) **before gateway validation**. Queries touching no default-model cube pass through byte-identical. Any resolution failure (bad/missing JWT, cache miss failure) ⇒ pass through untouched; the gateway's own auth/validation then applies as today.
**Rationale**: the only placement that satisfies FR-015 given the verified gateway order; fail-open-to-gateway keeps the middleware from ever becoming an auth bypass or an availability risk.
**Alternatives**: `queryRewrite` (runs post-validation — cannot satisfy FR-015); forking the gateway (unmaintainable against Cube upgrades).

### D13. SQL API backstop
**Decision**: ensure a `query_rewrite_rules` row exists per common source table (dimension = partition, `property_source: "team"`, `property_key: "partition"`, operator `equals`) so SQL-API cube queries — which bypass Express — still get scoping enforcement via `queryRewrite`. **Already largely in place**: migration `1741520400000` seeds `semantic_events`, `data_points`, `entities` (UNIQUE constraint on the rule tuple) — only tables beyond those need an idempotent top-up (`ON CONFLICT DO NOTHING`). Canonical translation is REST-only day one; documented limitation.
**Rationale**: the scoping rule is the security-relevant one; the rules engine already covers the SQL API path and blocks on missing dimension/property.
**Alternatives**: wire-protocol interception for SQL (large, out of scope); no backstop (leaves the most sensitive rule uncovered on one path).

### D14. Run reporting — `reconciliation_runs` table
**Decision**: one new Hasura-tracked table storing run lifecycle + per-team outcomes (see data-model.md); written by the orchestrator, read via an admin-gated RPC. No `user`-role Hasura permissions.
**Rationale**: FR-017/SC-008 need durable, queryable state; also carries cohort/halt state for FR-010.
**Alternatives**: rejected in plan Complexity Tracking (logs; audit_logs reuse).

### D15. `queryRewrite` cube→table map cache bump
**Decision**: raise `CUBE_TABLE_MAP_MAX_SIZE` (`queryRewrite.js:20`) from 50 to 1000.
**Rationale**: with per-team schemaVersions and the D13 backstop rule active, >50 concurrently active teams would thrash the map, re-fetching and re-parsing every dataschema on the query path. Entries are small Maps; 1000 is cheap.
**Alternatives**: leave at 50 (measurable query-path regression at fleet scale).

### D16. Collisions, skeletons, retirement
**Decision**: (a) a team-authored model (no provenance meta) whose cube/file name matches a template ⇒ that template is skipped for that team and reported (`skipped_collision`) — team content is never overwritten (FR-019). (b) Empty partition ⇒ skeleton derived model: template structure, no probe-derived fields, still valid and queryable (spec US1 #4). (c) Retired template (removed from the template branch) ⇒ existing derived models keep working, get `meta.default_model_unmanaged: true` on the next reconciliation, and receive no further updates (FR-020).
**Rationale**: all three follow directly from resolved spec policies with no additional machinery.

## Addendum (2026-07-07): dynamic Map/JSON field access research → feature 014

Post-implementation research for `Cube.dimensions.<key>` dynamic access (full detail + decisions in `specs/014-dynamic-map-json-access/`). Findings verified against installed Cube v1.6.37 (code-cited) and the live ClickHouse 26.6 cluster:

- **Member `sql:` is verbatim passthrough** — any ClickHouse expression (map element access, JSON subcolumns) works *iff the member is declared*. Unknown members throw in `CubeEvaluator.byPath` at getSql time; `queryRewrite` cannot add members.
- **Member expressions (ad-hoc SQL members) are SQL-API-only**: REST `/load` hardcodes `memberExpressions=false` (gateway.js:1418 → throw :923); only the cubesql bridge enables them (sql-server.js:195,223). Enabling them on REST = arbitrary-SQL surface — permanently rejected. `subqueryJoins` is likewise member-expression-gated.
- **`public: false` members are fully queryable on `/load`** — visibility filters `/meta` only (CubeToMetaTransformer is the sole reader). Hidden-fat-cube + curated view is a supported pattern; folders exist as meta-level grouping.
- **FILTER_PARAMS**: resolved per-member independently (parallel key slots work); absent filter renders literal `1 = 1` (the pre-processor closes this hole by always injecting the key filter). Cube's official "passing dynamic parameters" recipe is exactly this parameter-dimension pattern (Looker `parameter`/liquid analog; upstream true-params ask: cube-js #481).
- **ClickHouse JSON is GA** (25.3+; cluster runs 26.6; `cst.semantic_events.properties` is native JSON). Per-path Dynamic subcolumns, typed access (`.: String`), `JSONAllPaths()`. Cube's driver has zero Map/JSON/Dynamic/Variant type mapping and a hydration bug corrupting whole-map selects (`"[object Object]"`) — always element-access + CAST (scalar results are safe; current generation already complies).
- **Empirics (elko.is)**: per-EVENT key sets are tiny (≤6 map keys, ≤12 JSON paths; 13/16 keys exclusive to one event). Mega-cube complexity is a flattening artifact — the basis for 014's event-scoped explicit models.
- **Rejected alternatives**: lazy member materialization (implicit member growth, per-row map heterogeneity → unusable models — product owner decision), REST member expressions (security), jinja/COMPILE_CONTEXT registry compile (equals reconciliation with more fragility), securityContext-carried keys (per-session, not per-query).

**Accepted direction (014)**: event-scoped template cubes + editorial key/path registries (explicit-over-implicit), declared parameter-slot members (FILTER_PARAMS) behind the 013 pre-processor's `Cube.<map>.<key>` rewrite, a filter-scoped **dynamic property discovery endpoint** returning a cube-meta-shaped directory (short-TTL cached) for dashboards/query composer, JSON via registry + typed-path hints only, SQL API documented as the fully-dynamic explicit-SQL surface.

## Scale ceiling and escape hatch (documented for future reference)

The materialize-per-team design is sized for ~500 teams (SC-006) and holds to roughly 1,000 with the D7 change-detection and D15 cache bump in place. Beyond that, generation should move from materialize-ahead to on-demand compile-time expansion (per-team profile store + templated model via `COMPILE_CONTEXT`), trading away per-team version history for O(1) storage. Not built now (YAGNI); recorded so the ceiling is a known quantity, not a surprise.
