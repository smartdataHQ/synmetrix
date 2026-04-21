# Quickstart — Model Management API

Date: 2026-04-20
Branch: `011-model-mgmt-api`

This quickstart walks through the full agent lifecycle: author → contextual-validate → persist → refresh → diff → rollback → delete. Every call uses a FraiOS JWT (HS256, `accountId` claim present) obtained from cxs2.

## 0. Prerequisites

- Docker stack running: `./cli.sh compose up`
- Agent holds a FraiOS token in `$TOKEN` (set below each snippet implicitly).
- Datasource id and branch id are discoverable via `GET /api/v1/meta-all`.

```bash
# Catalog discovery (no datasource header needed)
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/v1/meta-all \
  | jq '.datasources[] | {datasource_id, datasource_name, branch_id, version_id,
                          cubes: [.cubes[] | {name, dataschema_id, file_name}]}'
```

Every cube summary now carries **`dataschema_id`** and **`file_name`** alongside `name`. Use them to resolve cube name → dataschema id in a single round-trip when calling `validate-in-branch` (mode=replace/preview-delete) or `DELETE /api/v1/dataschema/:id`.

Set for the rest of this guide:

```bash
DS=$(curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/v1/meta-all \
  | jq -r '.datasources[0].datasource_id')
BR=$(curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/v1/meta-all \
  | jq -r '.datasources[0].branch_id')

# Resolve a dataschema id by cube name for the first datasource:
ORDERS_DSID=$(curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/v1/meta-all \
  | jq -r '.datasources[0].cubes[] | select(.name == "orders") | .dataschema_id')
```

> **Listing branch versions** (for diff / rollback): query Hasura directly via the proxied GraphQL endpoint:
> ```graphql
> query($b: uuid!) {
>   versions(where: {branch_id: {_eq: $b}}, order_by: {created_at: desc}) {
>     id created_at origin is_current
>   }
> }
> ```
> The FraiOS token is minted-to-Hasura server-side by `/v1/graphql`, so Tychi forwards the same token it uses for `/api/v1/*`.

## 1. Contextual validation of a draft (US1, FR-001..FR-003)

Validate a new cube file against the branch's deployed cubes:

```bash
curl -sS -X POST http://localhost:4000/api/v1/validate-in-branch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @- <<JSON | jq
{
  "branchId": "$BR",
  "mode": "append",
  "draft": {
    "fileName": "orders.yml",
    "content": "cubes:\n  - name: orders\n    sql_table: public.orders\n    dimensions:\n      - name: id\n        sql: id\n        type: number\n        primary_key: true\n    measures:\n      - name: count\n        type: count\n"
  }
}
JSON
```

Expected response (happy path):

```json
{ "valid": true, "errors": [], "warnings": [] }
```

Replace an existing dataschema's code instead:

```bash
curl -sS -X POST http://localhost:4000/api/v1/validate-in-branch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "branchId": "'"$BR"'",
    "mode": "replace",
    "targetDataschemaId": "<uuid-of-existing-dataschema>",
    "draft": {
      "fileName": "orders.yml",
      "content": "<new-yaml>"
    }
  }'
```

Simulate a deletion and see the blocking references:

```bash
curl -sS -X POST http://localhost:4000/api/v1/validate-in-branch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "branchId": "'"$BR"'",
    "mode": "preview-delete",
    "targetDataschemaId": "<uuid-of-orders>"
  }' | jq '.blockingReferences'
```

## 2. Persist the new draft (existing Hasura GraphQL proxy)

Write the draft into a new version on the branch (the skill's existing Hasura mutation path). This uses the `/v1/graphql` proxy, which accepts the FraiOS token unchanged:

```bash
curl -sS -X POST http://localhost:4000/v1/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation($o: versions_insert_input!) { insert_versions_one(object: $o) { id } }",
    "variables": {
      "o": {
        "branch_id": "'"$BR"'",
        "dataschemas": { "data": [{ "name": "orders.yml", "code": "<yaml>", "datasource_id": "'"$DS"'" }] }
      }
    }
  }' | jq
```

## 3. Force compiler refresh after an in-place edit (US2, FR-004..FR-005)

If you used `update_dataschemas_by_pk` to edit `code` in place (rather than inserting a new version), the compiler cache still serves the old model until you refresh:

```bash
curl -sS -X POST http://localhost:4000/api/v1/internal/refresh-compiler \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"branchId": "'"$BR"'"}' | jq
# -> { "evicted": 3, "schemaVersion": "ab12…" }
```

Subsequent metadata/load requests for the branch will recompile on first hit and surface any compile errors on *that* response (asynchronous model — FR-004a).

> **Authorisation**: refresh requires **owner or admin** role on the datasource's team (FR-015, research.md §R14). A member-only caller receives `403 {"code":"refresh_unauthorized"}`. Refresh is gated at the same bar as delete and rollback because it affects the compiled view that every user of the branch sees.
>
> **Idempotence**: idempotence is per `(branchId, schemaVersion)` pair, not wall-clock. A second call with no intervening edit returns `evicted: 0`. If the dataschemas change between calls, the new `schemaVersion` makes the second call a different logical operation and it evicts the new hash's entries.

## 4. Single-cube metadata (US4, FR-009..FR-010)

Fetch compiled metadata for one cube without pulling the whole catalog:

```bash
curl -sS http://localhost:4000/api/v1/meta/cube/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-hasura-datasource-id: $DS" \
  -H "x-hasura-branch-id: $BR" | jq
```

> The path is `/api/v1/meta/cube/{cubeName}` — a dedicated segment (`/cube/`) prevents collision with Cube.js's built-in `GET /api/v1/meta` aggregate endpoint.
>
> **Historical meta**: this endpoint always compiles the **latest version** of the requested branch. If you need a cube's compiled metadata as it looked on a historical version (for audit or diff-preview purposes), fall back to Cube.js's built-in `GET /api/v1/meta` with `x-hasura-branch-id` + `x-hasura-branch-version-id` headers, then filter client-side by cube name. That endpoint is unchanged by this feature.

Cube not found → 404 with `code: "cube_not_found"`.

## 5. Diff between versions (US5, FR-011..FR-012)

```bash
# fromVersionId = version before the change, toVersionId = current active version
curl -sS -X POST http://localhost:4000/api/v1/version/diff \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fromVersionId": "<uuid>",
    "toVersionId": "<uuid>"
  }' | jq
```

Response lists `addedCubes`, `removedCubes`, and `modifiedCubes` with per-field deltas.

## 6. Rollback (US5, FR-013..FR-014)

Regret the last change? Roll back:

```bash
curl -sS -X POST http://localhost:4000/api/v1/version/rollback \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "branchId": "'"$BR"'",
    "toVersionId": "<uuid-of-target-version>"
  }' | jq
# -> { "newVersionId": "…", "clonedDataschemaCount": 7 }
```

The branch's active version is now the freshly inserted clone. Explorations and alerts bound to older versions are untouched (FR-013a).

## 7. Delete a cube (US3, FR-006..FR-008)

Preview first to see any blocking references:

```bash
curl -sS -X POST http://localhost:4000/api/v1/validate-in-branch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"branchId":"'"$BR"'","mode":"preview-delete","targetDataschemaId":"<uuid>"}' | jq
```

If `blockingReferences` is empty, delete:

```bash
curl -sS -X DELETE http://localhost:4000/api/v1/dataschema/<uuid> \
  -H "Authorization: Bearer $TOKEN" | jq
# -> { "deleted": true, "dataschemaId": "<uuid>" }
```

On 409 with `code: "delete_blocked_by_references"`, the `blockingReferences` list tells you which other cubes need updating first.

## 8. End-to-end acceptance (SC-001)

A single agent session can run steps 1 → 7 in under five minutes on a branch with ten cubes. StepCI workflow `tests/stepci/workflows/model-management/end-to-end.yml` exercises this path in CI.

## Error codes reference

Authoritative enumeration — matches the `ErrorCode` schema in every contract and the `errorCodes.js` export (FR-017).

| Code | Endpoint | HTTP | Meaning |
|---|---|---|---|
| `validate_invalid_mode` | validate-in-branch | 400 | Mode/field combination invalid. |
| `validate_target_not_found` | validate-in-branch | 404 | `targetDataschemaId` does not belong to branch. |
| `validate_unresolved_reference` | validate-in-branch | 200 (in CompileReport.errors[].code) | Draft references a cube/field not present in the branch. |
| `refresh_branch_not_visible` | refresh-compiler | 404 | Caller cannot see the branch. |
| `refresh_unauthorized` | refresh-compiler | 403 | Caller lacks owner/admin role on the datasource team. |
| `delete_blocked_by_references` | dataschema DELETE | 409 | FR-008 blocking refs. Response carries `blockingReferences[]`. |
| `delete_blocked_historical_version` | dataschema DELETE | 409 | Target is **not on the latest version of the active branch** — including older versions of the active branch. |
| `delete_blocked_authorization` | dataschema DELETE | 403 | Caller lacks owner/admin role on the datasource team. |
| `cube_not_found` | meta-single | 404 | Cube not present on the branch's latest version. |
| `diff_cross_branch` | version-diff | 400 | Versions belong to different branches. |
| `diff_invalid_request` | version-diff | 400 | Malformed request body. |
| `rollback_version_not_on_branch` | version-rollback | 400 | `toVersionId` not attached to `branchId`. |
| `rollback_invalid_request` | version-rollback | 400 | Malformed request body. |
| `rollback_source_columns_missing` | version-rollback | 400 | Target version references source columns that no longer exist. |

Every non-2xx response body carries `{code: ErrorCode, message: string}` for programmatic handling. The `ErrorCode` component is declared identically in every contract file; CI task `lint:error-codes` (T013f/T051) prevents drift.
