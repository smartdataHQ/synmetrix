# Contract: CubeJS internal route — per-team reconcile worker

**Service**: CubeJS (`services/cubejs`) | **Route**: `POST /api/v1/internal/reconcile-team`
**Caller**: Actions orchestrator only (service-to-service). Not reachable through the client proxy paths.

## Auth & scope construction

Service-to-service. The Actions caller sends a JWT minted for the system user (existing `generateUserAccessToken` pattern); the route verifies the signature AND that the subject equals `DEFAULT_MODELS_SYSTEM_USER_ID`. Any other identity → 403.

**Important — no membership-based `checkAuth`**: the standard auth path resolves datasources through the caller's own team memberships, and the system user is a member of no team, so it would 404 every datasource. This route therefore does its own resolution: fetch the datasource row by `datasourceId` via admin-secret GraphQL, verify it belongs to `teamId` and matches `DEFAULT_MODELS_TARGET_DATASOURCE_NAME`, then construct the security scope with `defineUserScope([dataSource], syntheticMembers, datasourceId, branchId)` — the same single-datasource pattern `metaForBranch.js` uses. This keeps datasource/branch resolution flowing through `defineUserScope`/`buildSecurityContext` (constitution Principle II) without granting the system user memberships.

## Request

```jsonc
{
  "teamId": "uuid",
  "datasourceId": "uuid",             // team's target datasource (resolved by orchestrator, D2)
  "branchId": "uuid",                 // its active branch
  "partition": "elko.is",             // team scope for probes + baked literal
  "templates": [                       // published template set (orchestrator reads them once per run)
    { "name": "semantic_events", "fileName": "semantic_events.yml",
      "code": "cubes: ...", "checksum": "ab12..." }
  ],
  "optOut": ["order_metrics"],        // from team.settings (orchestrator passes it; worker double-checks)
  "dryRun": false
}
```

## Response `200`

```jsonc
{
  "teamId": "uuid",
  "outcomes": [
    { "template": "semantic_events", "result": "updated",
      "versionId": "uuid", "checksum": "cd34..." },
    { "template": "order_metrics",  "result": "skipped_opt_out" },
    { "template": "page_metrics",   "result": "skipped_collision",
      "reason": "team-authored model 'PageMetrics' exists without provenance meta" },
    { "template": "empty_case",     "result": "updated_skeleton",
      "versionId": "uuid" }
  ]
}
```

`result` enum matches `reconciliation_runs.outcomes` (see data-model.md). A worker-level failure for one template records `{"result":"failed","reason":...}` and continues with remaining templates; HTTP is still 200 (per-template outcomes carry the failures). 5xx only for request-level faults (bad payload, datasource unreachable before any work).

## Worker pipeline (behavioral contract)

1. **Probe** the team's partition slice (existing profiler, partition-scoped WHERE). Empty slice ⇒ skeleton mode.
2. **Generate** candidate cubes from template + profile; bake `partition = '<partition>'`; stamp provenance meta (`default_model`, `template`, `template_checksum`; `from_template` on template-owned fields).
3. **Merge** against the team's current file (templateMerger): template-owned converges, probe fields regenerate, team-added preserved.
4. **Retirement sweep** (FR-020): any current derived model whose `meta.template` is NOT in the request's `templates` list is marked `meta.default_model_unmanaged: true` in the candidate set and receives no content updates — derivable worker-side from provenance meta; no extra request field needed.
5. **Collision check**: same cube/file name without provenance meta ⇒ `skipped_collision`, no write.
6. **No-op guard**: candidate checksum == current checksum ⇒ `skipped_no_change`, no write. Both checksums computed over files **sorted by name** (GraphQL row order is unstable; unsorted comparison causes false churn).
7. **Validate**: in-memory compile of the FULL candidate file set for the branch. Failure ⇒ `failed`, previous version stays live.
8. **Publish**: new version (`user_id` = system user, `checksum` = md5 over concatenated file codes — `versions.checksum` is NOT NULL and **application-computed**, there is no DB trigger for it) with nested dataschemas; `compilerCache.purgeStale()`; fire-and-forget metaConfig pre-warm. Also compute the removed-members diff vs the previous version (existing versionDiff util) and return it per outcome (`breaking`) for the run report.

Idempotency: same inputs ⇒ step 5 short-circuits; safe to re-run any team any time.

## Timeouts

Orchestrator calls with a 120s per-team budget (probe-dominated). The worker enforces its own probe timeout; exceeding it yields `failed` outcomes with `reason: "probe timeout"` rather than a hung request.
