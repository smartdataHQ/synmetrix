# Phase 0 Research — Model Management API

Date: 2026-04-20
Branch: `011-model-mgmt-api`

All Technical Context fields are fully specified. There are **no `NEEDS CLARIFICATION` markers** — the clarification session already resolved the ambiguities. The items below cover technical unknowns surfaced while tracing each requirement through existing code.

---

## R1 — Compiler cache identity and invalidation primitive

**Decision**: Invalidate by deleting LRU entries whose `appId` ends with the branch's current `schemaVersion` hash.

**Rationale**: `services/cubejs/index.js:45-46` defines:

```js
const contextToAppId = ({ securityContext }) =>
  `CUBEJS_APP_${securityContext?.userScope?.dataSource?.dataSourceVersion}_${securityContext?.userScope?.dataSource?.schemaVersion}}`;
```

`schemaVersion` is computed in `buildSecurityContext.js:53` as `md5(dataschemaIds)`. Two users querying the same branch share the same `schemaVersion` but may differ in `dataSourceVersion` (which includes team-properties hash). So:

- The same branch produces **one `schemaVersion`** across callers.
- Multiple cached `CompilerApi` instances may exist for one branch (one per team-properties hash).
- A content-only edit of a dataschema keeps the `schemaVersion` identical → stale cache.

`@cubejs-backend/server-core` stores `compilerCache` as a plain `LRUCache` (`server.js:107`) exposed at `cubejs.compilerCache`. `generateDataSchema.js:113` and `smartGenerate.js:822` already call `cubejs.compilerCache.purgeStale()` after writes; that only evicts TTL-expired entries, so it is insufficient for our refresh semantics.

The LRU instance exposes `.keys()`, `.delete(key)`, and `.clear()`. Deleting specific keys is O(1). Our helper iterates keys once and deletes only the matching subset.

**Implementation sketch** (`utils/compilerCacheInvalidator.js`):

```js
export function invalidateCompilerForBranch(cubejs, schemaVersion) {
  const cache = cubejs.compilerCache;
  if (!cache || typeof cache.keys !== "function") return 0;
  const suffix = `_${schemaVersion}}`;
  let evicted = 0;
  for (const key of cache.keys()) {
    if (typeof key === "string" && key.endsWith(suffix)) {
      cache.delete(key);
      evicted += 1;
    }
  }
  return evicted;
}
```

**Alternatives considered**:

- `cubejs.compilerCache.clear()` — evicts every tenant's cache. Violates Q1 (blast radius limited to target branch).
- Bump `dataSourceVersion` by mutating team settings — mutates unrelated state; violates Multi-Tenancy First.
- Insert a new version (the existing workaround) — not an invalidation; mutates history; explicitly rejected by US2's purpose.

---

## R2 — Compiler invocation for contextual validation

**Decision**: Reuse `@cubejs-backend/schema-compiler` `prepareCompiler` with an `InMemorySchemaFileRepository`, seeded with the branch's current dataschemas merged with the draft according to the selected mode (`append` / `replace` / `preview-delete`).

**Rationale**: `routes/validate.js` already uses this exact primitive for stateless file-level validation (`validate.js:7-19, 69-74`). Contextual validation simply seeds the same repository with more files.

**Mode semantics**:

- `append` — add the draft file to the repository alongside every existing dataschema. Collision on `fileName` is a validation error.
- `replace` — require `targetDataschemaId` in the request; swap that dataschema's `code` for the draft's content and keep all other dataschemas.
- `preview-delete` — require `targetDataschemaId`; build the repository excluding that dataschema and run the compiler. If compilation fails, every error is a blocking reference; report them so the caller can proceed to the delete endpoint informed.

The compiler's `errorsReport` structure (`validate.js:86-111`) already surfaces errors and warnings with file, line, column, and plain message. We reuse the mapping helpers (`mapCompilerError`, `mapSyntaxWarning`).

**Alternatives considered**:

- Custom YAML parser that statically resolves cross-cube references — reimplements the compiler; high false-positive risk; violates SC-003 (false-negative rate must be zero against the real compiler).
- Shelling out to `cubejs.apiGateway().getCompilerApi(context)` — requires a datasource-scoped security context, which forces the caller to pass `x-hasura-datasource-id`. That works but couples validation to a specific user's scope. `prepareCompiler` alone is scope-agnostic and simpler.

---

## R3 — Cross-cube reference detection for FR-008

**Decision**: A hybrid approach — parse each other cube into its AST/YAML structure once per delete request and scan for seven reference kinds by textual pattern on the cube's source, then fall back to a compiler probe (same primitive as R2's `preview-delete` mode) as an additional safety net.

**Rationale**: The seven reference kinds enumerated in FR-008 are:

| # | Kind | Detection |
|---|---|---|
| a | `joins` entries | YAML `joins[*].sql` or `joins[*].name` referencing `TARGET.`/`${TARGET}` |
| b | `extends` chains | YAML `extends: TARGET` or JS `cube('X', { extends: TARGET, ... })` |
| c | `sub_query` measures/dimensions | YAML `sub_query: true` with a formula referencing `TARGET.` |
| d | Measure/dimension formula references | `sql` bodies containing `TARGET.<field>` or `${TARGET}.<field>` |
| e | Segment inheritance | YAML `segments[*].sql` referencing `TARGET.` |
| f | Pre-aggregation rollup references | YAML `pre_aggregations[*].measureReferences[*]` / `dimensionReferences[*]` / `timeDimensionReference` / `rollups[*]` containing `TARGET.<field>` |
| g | `FILTER_PARAMS.<cube>.*` | Regex `FILTER_PARAMS\.TARGET\.` in any `sql` body |

Textual scan is fast and deterministic; compiler probe catches anything the enumeration misses (the spec's SC-003 target). Running both is cheap: we compile the branch anyway inside `preview-delete`, and the textual scan lets us produce a richer error response (`referring_cube`, `file`, `reference_kind`, `line`) that the compiler's raw error report does not directly emit.

**Implementation sketch** (`utils/referenceScanner.js`):

```js
const REFERENCE_PATTERNS = [
  { kind: "filter_params", re: (t) => new RegExp(`FILTER_PARAMS\\.${t}\\.`) },
  { kind: "cube_reference", re: (t) => new RegExp(`(?:\\$\\{${t}\\}|\\b${t})\\.[a-zA-Z_][a-zA-Z0-9_]*`) },
  { kind: "extends", re: (t) => new RegExp(`extends:\\s*["']?${t}["']?`) },
  // …
];

export function scanCrossCubeReferences(targetCubeName, otherCubes) {
  const hits = [];
  for (const cube of otherCubes) {
    for (const { kind, re } of REFERENCE_PATTERNS) {
      const pattern = re(targetCubeName);
      const match = pattern.exec(cube.code);
      if (match) {
        hits.push({
          referring_cube: cube.cubeName,
          file: cube.fileName,
          reference_kind: kind,
          line: lineOf(cube.code, match.index),
        });
      }
    }
  }
  return hits;
}
```

**Alternatives considered**:

- Pure compiler probe (no textual scan) — works but produces opaque error strings like "Cube A references dimension B" without a structured `reference_kind`. Tychi needs structured errors per FR-017.
- Full AST parse per cube — overkill; YAML structure is already accessible via `YAML.parse` from `routes/discover.js:22`; a textual pattern on the `sql` strings inside the parsed cube is sufficient and far simpler.

---

## R4 — Hasura permission model for deletion (version-level immutability)

**Decision**: Add a trigger-maintained boolean column `versions.is_current` (defaulting to `true` on insert, with the previous `is_current=true` row on the same branch flipped to `false` atomically). Delete permission on `dataschemas` then requires **owner/admin role + active branch + `version.is_current = true`**. The handler (T028) additionally re-checks the invariant in application code before firing the mutation, so the check lives at two layers.

**Rationale**: Versions are immutable snapshots within a branch. The runtime compiles only the newest version (`metaAll.js:50` selects `activeBranch.versions?.[0]` under `order_by: {created_at: desc}` from `dataSourceHelpers.js:110-117`). "Historical" therefore means **not-the-latest-version-of-the-active-branch**, including older versions of the currently-active branch — not merely "on a non-active branch". A permission filter keyed only on `branch.status = active` would still allow deleting a dataschema attached to v5 when v7 is the compiled version.

Hasura row-level permissions cannot express "the row belongs to the maximum-created_at version of its branch" natively without a computed field or a derived column. A trigger-maintained column is the simplest durable primitive:

```sql
ALTER TABLE versions ADD COLUMN is_current boolean NOT NULL DEFAULT true;

-- Backfill: for each branch, the newest version keeps is_current=true; older rows flip to false.
UPDATE versions v SET is_current = false
WHERE v.id NOT IN (
  SELECT DISTINCT ON (branch_id) id FROM versions ORDER BY branch_id, created_at DESC
);

CREATE OR REPLACE FUNCTION versions_flip_is_current()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE versions SET is_current = false
  WHERE branch_id = NEW.branch_id AND id <> NEW.id AND is_current = true;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER versions_flip_is_current_trg
AFTER INSERT ON versions
FOR EACH ROW EXECUTE FUNCTION versions_flip_is_current();
```

Resulting `delete_permissions` on `dataschemas`:

```yaml
delete_permissions:
  - role: user
    permission:
      filter:
        _and:
          - datasource:
              team:
                members:
                  _and:
                    - member_roles: { team_role: { _in: [owner, admin] } }
                    - user_id: { _eq: X-Hasura-User-Id }
          - version:
              is_current: { _eq: true }
              branch:
                status: { _eq: active }
```

Handler (T028) ALSO queries the target row's `version.is_current` and `version.branch.status` and returns `delete_blocked_historical_version` early if either fails, so agents get a structured error rather than the opaque Hasura permission rejection.

**Migration**: the schema change, backfill, and trigger all land in `services/hasura/migrations/1713600000000_dataschemas_delete_permission/up.sql`. Down migration drops the trigger, the function, and the column.

**Alternatives considered**:

- Hasura **computed field** returning the latest-version-id per branch — works, but adds a SELECT subquery to every permission check. A trigger-maintained column is O(1) to read.
- Handler-only enforcement with no DB-level constraint — fragile; any future caller that reaches Hasura directly (admin-secret RPC, manual SQL) could bypass the invariant.
- Soft-delete column on `dataschemas` — keeps history; introduces a new filter condition everywhere. Violates YAGNI and doesn't match the user's "truly remove this cube" expectation.

---

## R5 — Rollback as new-version insertion

**Decision**: A rollback request loads the target version's dataschemas (`findDataSchemasByIds`), strips their identifiers, inserts a new `versions` row with the cloned dataschemas (`createDataSchema`), and returns the new version identifier. No existing record is mutated.

**Rationale**: `createDataSchema` already takes `{ branch_id, dataschemas: { data: [...] } }` and inserts an `insert_versions_one` — matches the snapshot semantic. FR-013a requires dataschema-only cloning; we do **not** touch `explorations`, `alerts`, or any other table.

Activation of the new version is automatic: `findUser` returns the latest version per branch (`dataSourceHelpers.js:110-117`, `versions(limit: 1, order_by: {created_at: desc})`), so inserting the new row makes it the effective active version without a status update.

**Idempotency**: Rollback is naturally non-idempotent at the HTTP layer (each call inserts a new version). The idempotency concern in FR-005 applies only to refresh; rollback carries no such constraint.

**Alternatives considered**:

- Update the branch's active version pointer to the target — breaks the "versions always ordered by `created_at`" invariant used by `findUser`.
- Hard-copy via SQL — bypasses Hasura permissions; violates Security by Default.

---

## R6 — Single-cube metadata path

**Decision**: Extract a new `compileMetaForBranch` helper that returns the **raw** `metaConfig` output (full cube envelopes, not summarized), with configurable branch/version selection. Use it from both `/api/v1/meta-all` (which still summarizes post-call) and the new `/api/v1/meta/cube/:cubeName` (which filters by name and returns the unmodified envelope).

**Rationale**: The existing `metaForDatasource` helper in `metaAll.js` is unfit for direct reuse for two reasons:

1. **It summarizes.** `summarizeCube` (`metaAll.js:24-42`) flattens each cube to `{measures: string[], dimensions: string[], segments: string[]}` — just names. The single-cube contract needs the full compiled member objects (`{name, title, type, sql, format, meta, ...}`) so the agent can inspect members without a second round-trip.
2. **It always picks the active branch.** `metaForDatasource` (`metaAll.js:44-50`) does `ds.branches?.find((b) => b.status === "active")`. The single-cube contract accepts an optional `x-hasura-branch-id` header; honouring it is the whole point of the endpoint.

**New helper contract** (`services/cubejs/src/utils/metaForBranch.js`):

```js
export async function compileMetaForBranch({ apiGateway, req, userId, authToken, dataSource, branchId, versionId, allMembers }) {
  // Resolve the requested branch (or active branch if branchId omitted).
  // Resolve the requested version (or latest if versionId omitted).
  // Build securityContext via defineUserScope, just like metaAll.
  // Return { branchId, versionId, metaConfig } — raw, visibility-filtered, not summarized.
}
```

- `metaAll.js` continues to call `compileMetaForBranch` for every datasource and then applies its own `summarizeCube` post-processing.
- `metaSingleCube.js` calls `compileMetaForBranch` once, filters by `name === req.params.cubeName`, and returns the full envelope (`SingleCubeMeta` per data-model §2.8). 404 with `cube_not_found` if absent.

**Alternatives considered**:

- Reuse `metaForDatasource` and teach the single-cube route to unsummarize — impossible, the summarized output discards the data we need.
- Accept summarized output as sufficient for the single-cube contract — violates the stated utility ("inspect members without a second round-trip"); reduces the endpoint to a name-lookup that the caller could already do from `/meta-all`.

---

## R7 — Version diff uses a new `diffVersions` adapter over `diffModels`

**Decision**: Write a new helper `services/cubejs/src/utils/versionDiff.js` that produces the `{addedCubes, removedCubes, modifiedCubes}` shape the contract demands. Internally it iterates matched-by-name cube pairs across the two versions and delegates the **per-cube** field-level diff to the existing `diffModels.js` helper. `diffModels` alone does not match the contract.

**Rationale**: Inspection of `services/cubejs/src/utils/smart-generation/diffModels.js:399` confirms the function:

- Takes **two model documents** (existing + new) and a `mergeStrategy` — it is a *merge-preview* helper, not a *version-diff* helper.
- Returns `{fields_added, fields_updated, fields_removed, fields_preserved, blocks_preserved, ai_metrics_*, summary}` — a **flat field inventory across all cubes**, not the per-cube structure `addedCubes / removedCubes / modifiedCubes` required by FR-011 and contracts/version-diff.yaml.
- Has bespoke merge semantics (auto/merge/replace, AI-field preservation, user-content preservation) that are irrelevant to a version-to-version diff.

Adapter algorithm (in `versionDiff.js`):

```js
export async function diffVersions({ fromDataschemas, toDataschemas }) {
  const fromByFile = indexBy(fromDataschemas, "name");
  const toByFile   = indexBy(toDataschemas,   "name");

  const addedCubes = [], removedCubes = [], modifiedCubes = [];

  for (const [file, toRow] of toByFile) {
    if (!fromByFile.has(file)) {
      for (const cube of parseCubes(toRow.code)) addedCubes.push({ cubeName: cube.name, file });
      continue;
    }
    const fromRow = fromByFile.get(file);
    if (fromRow.checksum === toRow.checksum) continue;      // byte-identical, skip

    // Per-file cube-level diff. diffModels gives field-level; we collapse per cube.
    const perCube = diffModelsToPerCube(fromRow.code, toRow.code);
    for (const cube of perCube) {
      if (cube.status === "modified") modifiedCubes.push(cube);
    }
  }
  for (const [file, fromRow] of fromByFile) {
    if (!toByFile.has(file)) {
      for (const cube of parseCubes(fromRow.code)) removedCubes.push({ cubeName: cube.name, file });
    }
  }
  return { addedCubes, removedCubes, modifiedCubes };
}
```

`diffModelsToPerCube` runs `diffModels(fromRow.code, toRow.code, "replace")` once per file pair and re-groups its flat `fields_added` / `fields_updated` / `fields_removed` arrays back into per-cube `CubeFieldChange` records (grouping by the `cube` attribute that every entry already carries — see `diffModels.js:118`).

Both versions must belong to the same branch (FR-012). Before running the adapter, a single GraphQL query resolves `branch_id` for both version ids; mismatch → 400 with `diff_cross_branch`.

**Alternatives considered**:

- Use `diffModels` directly and reshape the flat output in the handler — same adapter work, but hides the logic inside the route file where it is untestable in isolation.
- Write a bespoke version differ that ignores `diffModels` — duplicates the YAML/JS parsing logic already in `diffModels.js` and `parseCubesFromJs`.
- Change the contract to expose the flat `fields_added / fields_updated / fields_removed` shape directly — rejected by FR-011 ("identifying added, removed, and modified cubes").

---

## R8 — Audit record emission

**Decision**: Rely on Hasura's existing event triggers. Add trigger definitions for `dataschemas.delete` and `versions.insert (rollback origin)` mirroring the current `generate_dataschemas_docs` trigger on `versions`.

**Rationale**: Constitution §IV (Security by Default) requires audit for mutating operations, and `tables.yaml` already uses event triggers for generation, cron task creation, and doc generation. Our additions:

- `dataschemas.delete` trigger → `POST {ACTIONS_URL}/rpc/audit_dataschema_delete` (a trivial RPC handler in `services/actions/src/rpc/auditDataschemaDelete.js` that logs the event with `session_variables`, `data.old`, and a timestamp).
- `versions.insert` existing trigger (`generate_dataschemas_docs`) already fires on insert; we extend the Actions handler to distinguish rollback-origin inserts by checking for a new column `versions.origin` (values: `user`, `smart_gen`, `rollback`). Migration adds the column with default `user`.

The **refresh** endpoint is not persisted in Hasura (cache invalidation is in-memory), so its audit record is emitted directly from the handler via a `fetchGraphQL` insert into an existing `audit_logs` collection (already present if any) or `console.log` structured line (if no audit table exists). Phase 1 design confirms which path applies.

**Alternatives considered**:

- New `audit_logs` table — introduces a new table; violates YAGNI given Hasura event triggers already capture the two DB-backed mutations.
- Log-only via stdout — acceptable for refresh (no DB row changes), not acceptable for delete/rollback per constitution.

---

## R9 — StepCI test corpus for SC-003 (zero false-negative rate)

**Decision**: Build a fixture directory at `tests/stepci/workflows/model-management/fixtures/` with six seed scenarios:

1. **valid-append** — new cube that compiles cleanly alongside a simple two-cube branch.
2. **dangling-join** — draft references a cube that does not exist.
3. **circular-extends** — `extends: A` while A already extends the draft.
4. **measure-to-measure-typo** — `{CUBE}.total` where the target measure is `totals`.
5. **preagg-reference-break** — existing pre-aggregation references `TARGET.metric`; submitting `preview-delete` for TARGET should surface this.
6. **filter-params-orphan** — `FILTER_PARAMS.TARGET.dim` in another cube; deletion of TARGET must be blocked.

Each fixture ships as a pair of files (branch-seed + draft) plus the expected error-code and `reference_kind`. The workflow loads the branch through Hasura, calls the endpoint, and asserts the response shape.

**Rationale**: SC-003 demands zero false-negatives against a curated corpus; this corpus is the corpus. It also exercises every reference kind enumerated in FR-008.

---

## R10 — Auth routing: branch-scoped vs datasource-scoped

**Decision**: Route the branch-scoped endpoints through a **direct-verify** handler-local auth path (mirroring `metaAll.js:127-141` / `discover.js:114-125`). Keep `checkAuthMiddleware` only for endpoints that genuinely need a datasource header.

**Rationale**: `services/cubejs/src/utils/checkAuth.js:72-79` hard-throws 400 when `x-hasura-datasource-id` is absent:

```js
if (!dataSourceId) {
  const error = new Error("400: No x-hasura-datasource-id provided, …");
  error.status = 400; throw error;
}
```

None of the branch-scoped endpoints require a datasource header on their request contract:

| Endpoint | Contract header | Auth mechanism |
|---|---|---|
| `POST /api/v1/validate-in-branch` | branchId in body | **direct-verify** (no middleware) |
| `POST /api/v1/internal/refresh-compiler` | branchId in body | **direct-verify** |
| `DELETE /api/v1/dataschema/:id` | dataschemaId in path | **direct-verify** + server-side lookup of datasource/branch from the dataschema |
| `GET /api/v1/meta/cube/:cubeName` | datasourceId + optional branchId headers | `checkAuthMiddleware` **(keeps working because the contract mandates the datasource header)** |
| `POST /api/v1/version/diff` | version ids in body | **direct-verify** + server-side resolution of branch |
| `POST /api/v1/version/rollback` | branchId + versionId in body | **direct-verify** + server-side resolution of datasource |

The direct-verify path each handler runs:

```js
const token = req.headers.authorization?.replace(/^Bearer /, "");
const tokenType = detectTokenType(token);
let payload, userId;
if (tokenType === "workos")   { payload = await verifyWorkOSToken(token); userId = await provisionUserFromWorkOS(payload); }
else if (tokenType === "fraios") { payload = await verifyFraiOSToken(token); userId = await provisionUserFromFraiOS(payload); }
else { /* HS256 Hasura fallback for legacy frontend calls */ }
const user = await findUser({ userId });
// resolve datasource/branch from the request-specific key (branchId, dataschemaId, versionId)
// enforce partition via resolvePartitionTeamIds(user.members, payload.partition)
```

This is the same pattern `metaAll.js` and `discover.js` already use. No new middleware.

**Alternatives considered**:

- Relax `checkAuthMiddleware` to make the datasource header optional — unacceptable: every existing datasource-scoped route relies on the 400 as a precondition for `defineUserScope`, and loosening it would compromise Multi-Tenancy First (Constitution §II).
- Require agents to pass `x-hasura-datasource-id` on every branch-scoped route — pushes a lookup onto the client that the server already has to do itself (dataschema→version→branch→datasource). Also fails for `validate-in-branch` (datasource context is irrelevant to pure compile).

---

## R11 — `fetchGraphQL` error collapsing and granular status codes

**Decision**: Add an opt-in `{ preserveErrors: true }` mode to `services/cubejs/src/utils/graphql.js` `fetchGraphQL`. In that mode the helper returns `{ data, errors, status }` without throwing, exposing Hasura's original error codes and HTTP status so routes that need FR-017-compliant mapping can surface `delete_blocked_authorization`, `cube_not_found`, etc.

**Rationale**: The current helper (`graphql.js:27-31`) collapses every GraphQL-level `errors[]` into a generic 503:

```js
if (res.errors) {
  const error = new Error(JSON.stringify(res.errors));
  error.status = 503;
  throw error;
}
```

`503` conflates three distinct failures — Hasura is down, the caller lacks permission, the row doesn't exist — and FR-017 mandates stable codes for each. Under the existing helper, `deleteDataschema` cannot distinguish "caller unauthorized" (should emit `delete_blocked_authorization`) from "Hasura unreachable" (should propagate as 503).

Extension sketch:

```js
export const fetchGraphQL = async (query, variables, authToken, { preserveErrors = false } = {}) => {
  // … existing logic …
  if (res.errors) {
    if (preserveErrors) return { data: res.data ?? null, errors: res.errors, status: result.status };
    const error = new Error(JSON.stringify(res.errors));
    error.status = 503;
    throw error;
  }
  return res;
};
```

Callers that need granular mapping opt in; every existing call site keeps the old throwing behaviour. Handlers using the new mode inspect `errors[0].extensions.code` — Hasura emits `permission-error`, `not-exists`, `constraint-violation`, etc., which map cleanly to our stable codes via a small `mapHasuraErrorCode()` lookup.

**Alternatives considered**:

- Bypass `fetchGraphQL` and call Hasura via `fetch` directly in every route that needs granular errors — duplicates the auth-header handling and `HASURA_ENDPOINT` resolution already centralised in the helper.
- Rewrite `fetchGraphQL` to always return structured errors — would break every existing caller that relies on the throw-on-error contract. Opt-in is the constitution-friendly change.

---

## R12 — Durable audit store

**Decision**: Add a new `audit_logs` table to the Hasura PostgreSQL schema. Delete and rollback record rows into it via Hasura event triggers that call existing Actions RPC handlers (one per operation). Ninety-day retention enforced by a scheduled cleanup job (new Hasura cron trigger in the same migration).

**Schema**:

```sql
CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action        text NOT NULL CHECK (action IN ('dataschema_delete', 'version_rollback')),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  datasource_id uuid          REFERENCES datasources(id) ON DELETE SET NULL,
  branch_id     uuid          REFERENCES branches(id) ON DELETE SET NULL,
  target_id     uuid NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('success', 'failure')),
  error_code    text,
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_user_id_idx   ON audit_logs (user_id);
CREATE INDEX audit_logs_action_idx    ON audit_logs (action);
```

**Two-path write model** (consequence of FR-016's success-and-failure requirement):

1. **Success path — Hasura event trigger.** When a mutation commits (`dataschemas.delete` succeeds, or `versions.insert with origin='rollback'` succeeds), Hasura's existing event-trigger infrastructure fires a webhook to an Actions RPC handler that writes `outcome='success'` into `audit_logs`. This path survives handler crashes between the mutation and the HTTP response — Hasura guarantees the trigger fires as long as the row committed.
2. **Failure path — direct handler write.** Every rejection branch inside the handlers (authorization denied, blocked-by-references, blocked-by-historical-version, source-columns-missing, partition mismatch, Hasura permission-error) calls a new in-process helper `writeAuditLog({action, userId, branchId, datasourceId, targetId, outcome:'failure', errorCode, payload})`. The helper performs an admin-secret INSERT into `audit_logs`. Two-path coverage is required because Hasura event triggers only fire on **committed** row changes — a rejected delete never reaches the trigger, a blocked rollback never inserts a `versions` row, and every non-Hasura rejection (FR-008 blocked refs, partition gate, `rollback_source_columns_missing`) is pure handler logic. Without the failure-path write, SC-007's zero-dropped-records claim fails immediately on the first blocked request.

**Hasura metadata**:

- Add `audit_logs` to `tables.yaml` with **no** `user` role permissions (admin-only). Agents cannot read or write the audit log directly.
- Add event triggers `delete_dataschema_audit` on `dataschemas.delete` and `version_rollback_audit` on `versions.insert where origin = 'rollback'`. Both point at Actions RPC handlers that INSERT with `outcome='success'`.

**Retention**: A cron trigger fires daily: `DELETE FROM audit_logs WHERE created_at < now() - interval '90 days'`.

**Rationale**:

- Gives FR-016/SC-007 a concrete, queryable sink — "zero dropped records over a week" is testable against row count.
- Reuses the existing Hasura event-trigger + Actions RPC pattern already used by `generate_dataschemas_docs` and `create_cron_task_by_alert`; no new transport.
- Admin-only permission prevents agents from tampering or mining the audit log.
- Two-path model survives both handler crashes (success still recorded via trigger) and Hasura unavailability (failure attempts still recorded via handler, with `outcome='failure'` and `error_code='hasura_unavailable'` when the handler's own admin-secret write fails its retry loop).

**Alternatives considered**:

- Success-only recording via triggers — does not satisfy FR-016's "each attempted operation" requirement. Zero authorisation-failure visibility. Rejected.
- Failure-only recording in handlers — loses the crash-survival property that event triggers give for commits. Rejected.
- Emit structured stdout lines and scrape with the existing log aggregator — non-durable, not queryable, no retention guarantees.
- Reuse an existing table — none exists with the needed shape.

---

## R13 — Single `ErrorCode` enum across all contracts (FR-017 enforcement)

**Decision**: Every contract file under `contracts/` declares an identical `ErrorCode` schema as an `enum` with the full 13-code list. Every `code` field in every response body `$ref`s `#/components/schemas/ErrorCode`. Every non-2xx response declares an explicit schema with `{code: ErrorCode, message: string}` — no free-form strings, no schemaless error responses. Cross-contract consistency is enforced by a build-time lint task (T050) that diffs the `ErrorCode.enum` list across the six contract files and fails CI on drift.

**Rationale**: FR-017 requires "a single importable enumeration." Prior draft had three mismatches:

1. `validate-in-branch.yaml` declared `code: {type: string}` with no `enum` — any typo passes OpenAPI validation.
2. Some non-2xx responses (e.g. delete-dataschema 403) carried a prose description but **no schema**, so the wire contract for that failure code is undocumented.
3. `delete_blocked_authorization` lived in the 409 `enum` even though its semantic (missing owner/admin role) is a 403 concern — it was both in the 403 prose and the 409 `enum`. Two codes for one condition.

New layout (per contract file):

```yaml
components:
  schemas:
    ErrorCode:
      type: string
      enum:
        - validate_invalid_mode
        - validate_target_not_found
        - validate_unresolved_reference
        - refresh_branch_not_visible
        - refresh_unauthorized
        - delete_blocked_by_references
        - delete_blocked_historical_version
        - delete_blocked_authorization
        - cube_not_found
        - diff_cross_branch
        - diff_invalid_request
        - rollback_version_not_on_branch
        - rollback_invalid_request
        - rollback_source_columns_missing
    ErrorResponse:
      type: object
      required: [code, message]
      properties:
        code: { $ref: '#/components/schemas/ErrorCode' }
        message: { type: string }
```

Then every non-2xx response references `ErrorResponse`:

```yaml
"403":
  description: Authorization or authentication failure.
  content:
    application/json:
      schema: { $ref: '#/components/schemas/ErrorResponse' }
```

**Rehoming of `delete_blocked_authorization`**: it moves to **403 only**. The 409 enum for `delete-dataschema` is narrowed to `[delete_blocked_by_references, delete_blocked_historical_version]`. The code is not dropped — it still appears in the shared `ErrorCode` enum and is returned on the 403 response body.

**Alternatives considered**:

- External `$ref` to a single `common-errors.yaml` — cleaner in theory, but OpenAPI tooling across the project (the skill's YAML loader included) varies in cross-file `$ref` support. Duplicating the enum per file with a CI lint is more portable.
- Derive the enum from `errorCodes.js` at build time via a codegen step — premature. The enum has 14 entries and changes infrequently.

---

## R14 — Refresh authorization bar

**Decision**: Refresh requires **owner or admin** role on the target datasource's team, the same bar as delete and rollback. Team membership alone is insufficient.

**Rationale**: Refresh evicts the compiler-cache entries that **every other user** of the branch relies on. The next compile hits happen on the next query, and the cost is paid by whoever issues that query — including end-users querying dashboards who did not request the refresh. A team member with read-only access who calls refresh in a tight loop effectively DoSes the compile path for the whole team.

Symmetry with other mutating operations:

| Operation | Affects | Current bar |
|---|---|---|
| `delete-dataschema` | DB row (persistent) | owner/admin |
| `version-rollback` | DB rows (persistent) | owner/admin |
| `refresh-compiler` | **other users' compiled view** (transient but observable) | owner/admin (this decision) |
| `validate-in-branch` (append) | nothing | member |
| `validate-in-branch` (replace / preview-delete) | nothing persistent, but signals intent | owner/admin |
| `version-diff` | nothing | member |
| `meta/cube/:cubeName` | nothing | member |

Enforced in the handler (T022) by checking that `user.members` contains an entry for the resolved datasource's team with `member_roles.team_role IN (owner, admin)` — the same helper used by delete and rollback handlers.

**Alternatives considered**:

- Keep the team-member bar — symmetry argument fails: refresh is the only "mutating" operation that would accept a lower bar.
- Rate-limit refresh instead of raising the bar — adds a rate-limiter dependency; owner/admin gate is a zero-dependency solution.

---

## Summary of resolutions

| Area | Resolution | Spec anchor |
|---|---|---|
| R1 — cache invalidation | LRU-scoped delete by `schemaVersion` suffix | FR-004, Clarification Q1 |
| R2 — contextual validate | `prepareCompiler` + in-memory repo, three modes | FR-001–FR-003 |
| R3 — reference scan | Textual patterns + compiler probe hybrid | FR-008 |
| R4 — delete permission | Trigger-maintained `versions.is_current` + owner/admin filter; handler re-checks | FR-006, FR-007 |
| R5 — rollback | Clone dataschemas into new version; no cascade | FR-013, FR-013a |
| R6 — single-cube meta | New `compileMetaForBranch` helper; full envelope, honours branch header | FR-009, FR-010 |
| R7 — diff | New `diffVersions` adapter wrapping `diffModels` per file pair | FR-011, FR-012 |
| R8 — audit | Two-path (trigger for success, handler for failure) → `audit_logs` | FR-016 |
| R9 — test corpus | Six fixtures under `tests/stepci/workflows/model-management/fixtures/` | SC-003 |
| R10 — auth routing | Direct-verify for branch-scoped endpoints; middleware only for datasource-scoped | FR-015 |
| R11 — `fetchGraphQL` mode | Opt-in `preserveErrors` for granular FR-017 status mapping | FR-017 |
| R12 — `audit_logs` table | New admin-only table with 90-day retention via cron; success + failure writers | FR-016, SC-007 |
| R13 — shared `ErrorCode` enum | All contracts reference one enum; all non-2xx responses have schemas; `delete_blocked_authorization` rehomed to 403 | FR-017 |
| R14 — refresh auth bar | Owner/admin (symmetric with delete + rollback) | FR-015 |

All open technical unknowns resolved. Phase 1 design may proceed.
