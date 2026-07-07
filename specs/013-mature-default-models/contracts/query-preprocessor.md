# Contract: Query Pre-processor (FR-015, FR-016)

**Service**: CubeJS | **Placement**: Express middleware mounted BEFORE `cubejs.initApp(app)` (`services/cubejs/index.js:100-102`), therefore before ALL gateway processing — including Joi structural validation (`normalizeQuery`), row-level security, `queryRewrite`, and member validation. This ordering is the contract's reason for existing (verified against `@cubejs-backend/api-gateway/dist/src/gateway.js:898-952`).

## Intercepted requests

| Path | Methods | Query location |
|------|---------|----------------|
| `/api/v1/load` | GET, POST | `req.query.query` (JSON string) / `req.body.query` |
| `/api/v1/dry-run` | GET, POST | same |
| `/api/v1/sql` | GET, POST | same |

Single queries and arrays (blending/compare-date-range) are both handled; each element is processed independently. All other paths (including `/api/v1/meta`, custom routes, SQL-API wire ports) are untouched.

## Scope detection

A query is **in scope** iff BOTH hold: (a) the request's `x-hasura-datasource-id` header equals the team's resolved **target datasource id** (the one holding its derived models — resolved in step 2 below), and (b) at least one referenced member (`Cube.member` in measures/dimensions/segments/filters/timeDimensions) belongs to a cube with `meta.default_model: true` in that datasource's compiled meta. Condition (a) prevents mutating a query aimed at a DIFFERENT datasource that happens to contain same-named cubes/members. Additionally, requests carrying an `x-hasura-branch-id` or `x-hasura-branch-version-id` header (branch/version preview — supported by `checkAuth.js:29-31`) MUST pass through untouched: the middleware only resolves active-branch/latest-version meta, and transforming a preview query against that would target the wrong model set. Queries failing any of these conditions MUST pass through **byte-identical** (spec US5 #3).

**Identity & member-map resolution** (the middleware runs BEFORE gateway auth, so no security context exists yet — it resolves everything itself, read-only, via admin-secret GraphQL, all cached):
1. Team identity: JWT `partition` claim. **Legacy-JWT fallback**: when the claim is absent (hasura-backend-plus tokens), resolve via the `x-hasura-user-id` claim → membership → `team.settings.partition` (cached per userId). Still unresolved → pass through untouched (guarantee 3).
2. Member map: partition → team → datasource named `DEFAULT_MODELS_TARGET_DATASOURCE_NAME` → active branch → latest version. The version's dataschema ID set yields the schemaVersion (same md5 as `buildSecurityContext`), which keys the cache (partition + schemaVersion, TTL ≤ 30s). The member map itself is built by **parsing the raw dataschema files** (YAML / `parseCubesFromJs`) for `meta.default_model` cubes and their dimension/measure/segment names — the exact precedent of `queryRewrite.js`'s `buildCubeToTableMap` (`:99-151`). Deliberately NOT the compiled meta: a compiler-based lookup (`metaForBranch`) would risk a 15-30s cold compile inside the middleware; file parsing is milliseconds and needs one Hasura fetch per cache miss.

## Fixed rule set (day one, in code — `defaultModelRules.js`)

Applied in order to in-scope queries:

**R1 — Canonical-reference translation.** Canonical member names (as published by the templates) are mapped to the executing team's variant members. The mapping source is the diff between the published template set and the team's compiled meta; since template-owned members converge with identical names per team, R1's day-one work is the absent-member handling below — the rename map starts empty and exists as the extension point. References to a default-model member absent from the team's variant:
- if a defined adaptation exists (rename/equivalent member) → rewritten;
- otherwise → **deterministic rejection**: HTTP 400 with
  ```jsonc
  { "error": "Default model member unavailable",
    "code": "DEFAULT_MODEL_MEMBER_UNAVAILABLE",
    "member": "SemanticEvents.checkout_step",
    "template": "semantic_events" }
  ```
  This MUST fire before gateway validation so callers get a specific, stable error instead of a generic unknown-member failure (spec US5 #2, SC-005). Error code is added to the canonical error-code enum (`errorCodes.js` + lint script).

**R2 — Account-scoping enforcement.** Verify/inject the canonical scope filter (`<Cube>.partition equals <team partition>`) on every in-scope cube that exposes the scope dimension. This is belt-and-braces on top of the scoping baked into each derived model (FR-005) and MUST NOT be treated as the primary isolation mechanism.

## Guarantees

1. **Ordering**: transformations complete before any gateway code runs for that request.
2. **Exclusivity**: no mutation of out-of-scope queries (byte-identical pass-through).
3. **Fail-open to gateway auth**: on ANY internal failure (unparseable query, missing/invalid JWT, meta-cache resolution failure), the middleware passes the ORIGINAL request through untouched. The gateway then authenticates/validates exactly as today. The middleware never authorizes, never mints credentials, never blocks on its own availability. (Rejection R1 is the sole deliberate 400.)
4. **Idempotence**: pre-processing an already-processed query is a no-op (translation targets canonical names; scope filter injection deduplicates).
5. **Performance**: ≤ 10ms p95 added latency (cached meta; no network calls on the hot path after warm-up).

## Known limitation (documented, accepted)

The SQL API (`cubesql` wire-protocol ports) bypasses Express: R1 translation does not apply there. R2's security intent is covered on that path by the seeded `query_rewrite_rules` scoping row (research D13), which also hard-blocks queries that drop the scope dimension. Canonical translation for SQL API is out of scope for this feature.
