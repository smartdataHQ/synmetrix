# Phase 1 Data Model — Model Management API

Date: 2026-04-20
Branch: `011-model-mgmt-api`

This feature introduces **no new persistent tables**. It refines the permissions on an existing table (`dataschemas`), adds one nullable column (`versions.origin`), and defines several transient in-memory entities used only inside request/response envelopes.

---

## 1. Persistent entities (database)

### 1.1 `dataschemas` (existing table — modified permissions only)

| Field | Type | Existing? | Notes |
|---|---|---|---|
| `id` | uuid (PK) | existing | |
| `name` | text | existing | File name (`orders.yml`) |
| `code` | text | existing | Source code (YAML or JS) |
| `checksum` | text | existing | md5 of `code` |
| `datasource_id` | uuid | existing | FK `datasources.id` |
| `version_id` | uuid | existing | FK `versions.id` |
| `user_id` | uuid | existing | Authoring user |
| `created_at` / `updated_at` | timestamptz | existing | |

**Permission change** (new delete permission, role `user`):

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
                    - member_roles:
                        team_role:
                          _in: [owner, admin]
                    - user_id:
                        _eq: X-Hasura-User-Id
          - version:
              branch:
                status:
                  _eq: active
```

Validation rules enforced by this filter:

- Only owners and admins of the team that owns the datasource may delete.
- Only dataschemas attached to an **active-branch** version may be deleted (FR-007 — historical versions remain immutable).

### 1.2 `versions` (existing table — two new columns + one trigger)

| Field | Type | Existing? | Notes |
|---|---|---|---|
| `id` | uuid (PK) | existing | |
| `branch_id` | uuid | existing | FK `branches.id` |
| `user_id` | uuid | existing | |
| `checksum` | text | existing | |
| `markdown_doc` | text | existing | |
| `origin` | text | **NEW**, nullable, default `'user'` | CHECK (`origin IN ('user','smart_gen','rollback')`). Distinguishes rollback-origin versions for audit. |
| `is_current` | boolean | **NEW**, `NOT NULL DEFAULT true` | True for exactly one version per branch — the newest. Maintained by the `versions_flip_is_current_trg` AFTER-INSERT trigger: when a new version is inserted, the trigger flips the previous current row on the same branch to `false`. Backfilled in the migration so the current newest row per branch starts with `is_current = true` and all others start with `false`. Used by the `dataschemas.delete_permissions` filter to enforce version-level immutability (FR-007). |
| `created_at` / `updated_at` | timestamptz | existing | |

Migration file: `services/hasura/migrations/1713600000000_dataschemas_delete_permission/up.sql`. Down migration reverts the delete permission, drops the trigger and function, and drops the `origin` and `is_current` columns.

### 1.3 `branches` (existing — no schema change; vocabulary clarification only)

| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `name` | text | |
| `status` | enum (`branch_statuses`) | **Actual enum values are `active`, `created`, `archived`** — per migrations `1680871325606_insert_into_public_branch_statuses` / `1680871332169_…` / `1680871339548_…`. One branch per datasource carries `active`; all others are "non-active" (historical) for the purposes of FR-007. |
| `datasource_id` | uuid | FK `datasources.id` |
| `user_id` | uuid | |

No schema change. References in `delete_permissions` filter on `status._eq: active` and therefore work regardless of the non-active value name.

### 1.4 `datasources`, `members`, `member_roles`, `teams`

No changes.

### 1.5 `audit_logs` (NEW table — introduced by this feature)

| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | `DEFAULT gen_random_uuid()` |
| `action` | text | CHECK (`action IN ('dataschema_delete', 'version_rollback')`) |
| `user_id` | uuid | FK `users.id`, `ON DELETE CASCADE` |
| `datasource_id` | uuid (nullable) | FK `datasources.id`, `ON DELETE SET NULL` |
| `branch_id` | uuid (nullable) | FK `branches.id`, `ON DELETE SET NULL` |
| `target_id` | uuid | The deleted dataschema id or the rolled-back-from version id. |
| `outcome` | text | CHECK (`outcome IN ('success', 'failure')`) |
| `error_code` | text (nullable) | Stable FR-017 code when `outcome = 'failure'`. |
| `payload` | jsonb (nullable) | Operation-specific detail (e.g. cloned dataschema count for rollback; blocking references for a failed delete). |
| `created_at` | timestamptz | `DEFAULT now()` |

**Indexes**: `created_at DESC`, `user_id`, `action`.

**Hasura permissions**: **admin role only** for select/insert/update/delete. Role `user` has **no** permission — agents cannot read or tamper with the audit log.

**Retention**: 90 days, enforced by a daily Hasura cron trigger that runs `DELETE FROM audit_logs WHERE created_at < now() - interval '90 days'`.

**Writers**: Hasura event triggers `delete_dataschema_audit` and `version_rollback_audit` post to Actions RPC handlers that perform the INSERT using the admin secret.

---

## 2. Transient entities (request/response bodies)

These are not persisted; they exist only in handler memory and on the wire. Declared here to anchor the OpenAPI contracts in `contracts/` and the StepCI fixture structure.

### 2.1 `DraftFile`

Represents a candidate dataschema file submitted for contextual validation.

```ts
interface DraftFile {
  fileName: string;              // "orders.yml" | "orders.js"
  content: string;               // raw YAML or JS source
}
```

Validation:

- `fileName` must match `/^[A-Za-z0-9_\-.]+\.(yml|yaml|js)$/`.
- `content` must be non-empty and ≤ 1 MiB.

### 2.2 `ValidateInBranchRequest`

```ts
interface ValidateInBranchRequest {
  branchId: string;              // uuid
  mode: "append" | "replace" | "preview-delete";
  draft?: DraftFile;             // required when mode is "append" or "replace"
  targetDataschemaId?: string;   // uuid — required when mode is "replace" or "preview-delete"
}
```

Validation:

- `mode === "append"` → `draft` required, `targetDataschemaId` must be absent.
- `mode === "replace"` → both `draft` and `targetDataschemaId` required.
- `mode === "preview-delete"` → `targetDataschemaId` required, `draft` must be absent.

### 2.3 `CompileReport`

```ts
interface CompileDiagnostic {
  severity: "error" | "warning";
  message: string;
  fileName: string | null;
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
  code?: string;                 // stable error code (FR-017)
}

interface CompileReport {
  valid: boolean;
  errors: CompileDiagnostic[];
  warnings: CompileDiagnostic[];
  blockingReferences?: BlockingReference[]; // present only for preview-delete when valid=false
}
```

### 2.4 `BlockingReference`

Emitted by `preview-delete` and `DELETE /api/v1/dataschema/:id`.

```ts
interface BlockingReference {
  referringCube: string;         // cube identifier, e.g. "order_items"
  file: string;                  // dataschema fileName
  referenceKind:
    | "joins"
    | "extends"
    | "sub_query"
    | "formula"
    | "segment"
    | "pre_aggregation"
    | "filter_params";
  line: number | null;           // 1-based
}
```

### 2.5 `RefreshCompilerRequest`

```ts
interface RefreshCompilerRequest {
  branchId: string;              // uuid
}
```

### 2.6 `RefreshCompilerResponse`

```ts
interface RefreshCompilerResponse {
  evicted: number;               // count of LRU entries removed
  schemaVersion: string;         // the hash whose cache entries were targeted
}
```

### 2.7 `DeleteDataschemaResponse`

```ts
interface DeleteDataschemaResponse {
  deleted: boolean;
  dataschemaId: string;
}
```

Error response (FR-008 blocking refs):

```ts
interface DeleteBlockedResponse {
  code: "delete_blocked_by_references";
  message: string;
  blockingReferences: BlockingReference[];
}
```

### 2.8 `SingleCubeMeta`

```ts
interface SingleCubeMeta {
  cube: {
    name: string;
    title: string | null;
    description: string | null;
    public: boolean;
    measures: MeasureMeta[];
    dimensions: DimensionMeta[];
    segments: SegmentMeta[];
    hierarchies?: HierarchyMeta[];
    meta: Record<string, unknown> | null;
  };
  datasourceId: string;
  branchId: string;
  versionId: string;
}
```

(Shapes of `MeasureMeta`, `DimensionMeta`, `SegmentMeta`, `HierarchyMeta` mirror the envelopes Cube.js already returns from `/api/v1/meta` — no new shape is invented.)

### 2.9 `VersionDiff`

```ts
interface CubeFieldChange {
  field: "measures" | "dimensions" | "segments" | "meta";
  added: string[];               // field names
  removed: string[];
  modified: string[];            // field names whose `sql` or type changed
}

interface CubeChange {
  cubeName: string;
  file: string;
  changes: CubeFieldChange[];
}

interface VersionDiffResponse {
  branchId: string;
  fromVersionId: string;
  toVersionId: string;
  addedCubes: { cubeName: string; file: string }[];
  removedCubes: { cubeName: string; file: string }[];
  modifiedCubes: CubeChange[];
}
```

### 2.10 `RollbackRequest`

```ts
interface RollbackRequest {
  branchId: string;              // uuid
  toVersionId: string;           // uuid — must belong to branchId
}
```

### 2.11 `RollbackResponse`

```ts
interface RollbackResponse {
  newVersionId: string;          // uuid of the freshly inserted version
  clonedDataschemaCount: number; // sanity-check for the caller
}
```

---

## 3. State transitions

### 3.1 Dataschema lifecycle

```
          ┌──────────────┐                         ┌──────────────┐
          │  not exist   │  insert_versions_one    │  attached    │
          │              │───────────────────────▶ │  to version  │
          └──────────────┘                         └──────┬───────┘
                                                          │
                                                          │ update (code / name)
                                                          ▼
                                                   ┌──────────────┐
                                                   │  attached,   │
                                                   │  mutated     │
                                                   └──────┬───────┘
                                                          │ delete_dataschemas_by_pk
                                                          │ (only if branch.status = active
                                                          │  and no blocking references)
                                                          ▼
                                                   ┌──────────────┐
                                                   │  removed     │
                                                   └──────────────┘
```

### 3.2 Version lifecycle

```
┌──────────────┐       insert_versions_one       ┌──────────────┐
│  not exist   │ ──────────────────────────────▶ │  active /    │
│              │   (origin in {user, smart_gen,  │  historical  │
└──────────────┘       rollback})                │  (immutable) │
                                                  └──────────────┘
```

Versions never leave the "immutable" state. Rollback does not mutate existing versions; it inserts a new one with `origin = 'rollback'`.

### 3.3 Compiler cache entry lifecycle

```
┌──────────────┐   first query on branch    ┌────────────┐
│  not cached  │ ─────────────────────────▶ │  cached    │
│              │   (LRU.set on appId)       │            │
└──────────────┘                             └─────┬──────┘
       ▲                                           │
       │                                           │ POST /api/v1/internal/refresh-compiler
       │                                           │   OR LRU eviction (TTL/size)
       └───────────────────────────────────────────┘
```

No intermediate state; the cache is strictly in-memory.

---

## 4. Relationships

```
datasources ─1─∞→ branches ─1─∞→ versions ─1─∞→ dataschemas
    ▲                                ▲
    └── team_id ──→ teams            │
                     ▲               │
                  members ─── member_roles

audit_logs ─── user_id ──→ users
           ─── datasource_id ──→ datasources (nullable)
           ─── branch_id ──→ branches (nullable)
```

Three new foreign keys: `audit_logs.user_id`, `audit_logs.datasource_id`, `audit_logs.branch_id`.

---

## 5. Validation rules summary

| Rule | Source | Enforced by |
|---|---|---|
| Only owners/admins of team can delete a dataschema. | FR-006 | Hasura `delete_permissions` filter + handler re-check |
| Only dataschemas on the **latest version of the active branch** can be deleted. | FR-007 | Hasura `delete_permissions` filter on `version.is_current._eq: true AND version.branch.status._eq: active` + handler re-check that returns `delete_blocked_historical_version` |
| Deletion blocked by cross-cube reference. | FR-008 | `utils/referenceScanner.js` in handler, before calling Hasura mutation |
| Owner/admin role required for every mutating operation (delete, rollback, refresh, validate-in-branch replace/preview-delete). | FR-015 | Handler checks `user.members[].member_roles.team_role` contains `owner` or `admin` for the target team |
| Diff rejects cross-branch pairs. | FR-012 | Handler pre-check (single GraphQL query of `branch_id` for both versions) |
| Rollback only clones dataschemas, not dependents. | FR-013a | Handler implementation (R5) |
| Refresh evicts only branch-scoped cache entries. | FR-004 | `utils/compilerCacheInvalidator.js` iterates and filters by `schemaVersion` suffix |
| Refresh is idempotent per (branch, schemaVersion) pair. | FR-005 | Second eviction of same `schemaVersion` finds nothing to evict |
| Single-cube metadata respects access-list visibility. | FR-010 | Handler reuses `apiGateway.filterVisibleItemsInMeta` |
| Audit records cover every outcome path (success + all failures). | FR-016, SC-007 | Hasura event trigger for success commits + in-handler `writeAuditLog` for every failure branch |

---

All entities, shapes, transitions, and validations are now specified. Proceed to contracts.
