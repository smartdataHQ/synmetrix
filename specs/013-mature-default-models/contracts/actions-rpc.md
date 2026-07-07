# Contract: Actions RPCs — Default Models

**Service**: Actions (`services/actions`) | **Pattern**: `POST /rpc/{method}` (existing dynamic dispatcher)
All three methods are **not** exposed as Hasura actions day one; callers are the Hasura cron trigger, the provisioning hook, and platform admins.

## POST /rpc/reconcileDefaultModels — fleet orchestrator

**Callers**: Hasura cron `reconcile_default_models` (every 15 min); platform admin (manual).
**Auth (applies to all three RPCs in this contract)**: the `/rpc/:method` dispatcher is UNAUTHENTICATED at the route layer (`services/actions/index.js:50`) — "no session" MUST NOT be treated as authorization. Each handler requires **either** the `x-actions-cron-secret` header matching `ACTIONS_CRON_SECRET` (sent by the cron trigger and internal callers) **or** a portal-admin caller (`isPortalAdmin` on the session user). Anything else → 403 before any work.

Portal-admin caveat: `isPortalAdmin` (`services/actions/src/utils/portalAdmin.js`) is hardcoded to `@snjallgogn.is` emails resolved via `auth_accounts` — this is a DIFFERENT concept from the fftech.is template-owner team. Do not assume fftech.is team membership grants RPC access; the cron-secret header is the primary path.

Note on status codes: the dispatcher currently coerces every `{error}` return to HTTP 400 (`services/actions/index.js:67-72`). Implementing 403 requires the additive dispatcher change of honoring an optional numeric `status` field on error returns (`res.status(data.status || 400)`) — backward-compatible, since no existing handler sets `status`.

Request:
```jsonc
{
  "trigger": "schedule",        // 'schedule' | 'manual'; internal re-entry uses 'template_publish'
  "dryRun": false,               // optional: compute outcomes, write nothing
  "cohortLimit": null            // optional: stop after N cohorts (manual canary inspection)
}
```

Response `200`:
```jsonc
{
  "runId": "uuid",
  "status": "completed",         // 'completed' | 'halted' | 'failed' | 'noop'
  "templateChecksum": "ab12...",
  "totals": { "updated": 12, "skipped_no_change": 480, "skipped_opt_out": 3,
               "skipped_collision": 1, "updated_skeleton": 2, "failed": 2 }
}
```

Traceability note: `dryRun` and `cohortLimit` are operational aids for FR-010 staged rollouts (inspect a canary's outcomes before letting the fleet proceed); they serve no other feature and MUST NOT grow further options.

Semantics:
- Detects template publish by comparing the template branch's latest `versions.checksum` with the last completed run.
- Runs fleet-wide drift detection (single `GROUP BY partition` probe), then processes only changed/new/behind teams, cohort by cohort (canary first).
- Halts when a cohort's failure rate exceeds `DEFAULT_MODELS_HALT_THRESHOLD`; status `halted`, remaining teams untouched.
- `noop` when neither template nor any team's data changed.
- Concurrency guard: while another run has `status='running'`, responds HTTP 200 `{"status": "already_running", "runId": "<running run>"}` — deliberately not an error, so overlapping 15-min cron ticks during a long fleet run don't register as webhook failures. **Stale-lease takeover**: a `running` row whose `heartbeat_at` is older than 10 minutes is abandoned (orchestrator crash) — it is marked `failed` (reason `stale_lease`) and the new run proceeds.
- Per-team outcomes are appended **atomically** via Hasura's jsonb `_append` update operator — never read-modify-write — so the concurrent per-team worker calls cannot lose outcomes.
- Errors follow the existing Actions `apiError` shape.

## POST /rpc/reconcileTeamDefaultModels — single team

**Callers**: `provision.js` after team creation (fire-and-forget); platform admin (retry after fixing a failure).
**Auth**: same as above (cron-secret header or portal admin).

Request:
```jsonc
{ "teamId": "uuid", "trigger": "team_created" }   // 'team_created' | 'manual'
```

Response `200`:
```jsonc
{
  "runId": "uuid",              // a single-team reconciliation_runs row
  "teamId": "uuid",
  "outcomes": [ { "template": "semantic_events", "result": "updated", "versionId": "uuid" } ]
}
```

Semantics: idempotently ensures the system user row exists (first-run bootstrap — `versions.user_id` FK), provisions the target datasource if absent (existing `provisionDefaultDatasources`), then reconciles all published templates for this one team. When the target datasource is absent AND unprovisionable (no `default-datasources.json` entry or missing secret env), the outcome is `failed` with reason `target_datasource_unavailable` — recorded, not thrown. Never staged (single team). Failure of the fire-and-forget call at onboarding is recovered by the next scheduled run (FR-002 backfill).

## POST /rpc/getDefaultModelsReport — admin report (FR-017, SC-008)

**Auth**: same as above (cron-secret header or portal admin). Others → 403.

Request:
```jsonc
{ "runId": "uuid" }              // optional; omitted = latest run
```

Response `200`:
```jsonc
{
  "run": { "id": "...", "trigger": "schedule", "status": "completed",
            "startedAt": "...", "finishedAt": "...", "templateChecksum": "ab12...",
            "cohortState": { "currentCohort": 4, "cohortsTotal": 4 } },
  "totals": { "updated": 12, "skipped_no_change": 480, "failed": 2, "...": 0 },
  "teamsBehind": [               // answers SC-008 directly
    { "teamId": "uuid", "teamName": "acme.is", "result": "failed",
      "reason": "validation: Unknown dimension 'foo' in cube 'SemanticEvents'" }
  ],
  "breakingChanges": [           // SC-003 companion: members the template update REMOVED/renamed
    { "teamId": "uuid", "template": "semantic_events",
      "removedMembers": ["SemanticEvents.checkout_step"] }   // computed via existing versionDiff
  ]
}
```

## Hasura cron trigger (metadata addition)

```yaml
- name: reconcile_default_models
  webhook: '{{ACTIONS_URL}}/rpc/reconcileDefaultModels'
  schedule: '*/15 * * * *'
  payload: { trigger: schedule }
  headers:
    - name: x-actions-cron-secret
      value_from_env: ACTIONS_CRON_SECRET
  include_in_metadata: true
```
