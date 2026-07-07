# Data Model: Mature Default Models

**Date**: 2026-07-06 | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

Design principle: reuse the existing versioning entities wherever possible. This feature adds **one** new table, **one** new `team.settings` key, and a set of `meta` conventions carried inside model files. Everything else is existing rows with new meaning.

## Existing entities, reused

### Global Template (= dataschemas on the template datasource)
- **Storage**: `dataschemas` rows on the latest version of the active branch of the platform-owned template datasource (`DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID`).
- **Identity**: cube name within the file; file name for matching.
- **Version**: the owning `versions.checksum` — NOT NULL, **application-computed** (md5 over concatenated file codes, `createMd5Hex` pattern from `smartGenerate.js:819-822`); only the per-dataschema checksum is trigger-computed. Every writer of `versions` rows must supply it, and MUST sort files by `name` before concatenating — both when computing and when comparing for the no-op guard — since GraphQL row order is not stable and order-sensitive checksums would cause false version churn (SC-007).
- **Lifecycle**: published = present on the latest active-branch version; retired = removed from it. No new state columns.

### Derived Model (= dataschemas in the team's default datasource)
- **Storage**: ordinary `dataschemas` rows on new `versions` of the team's default datasource's active branch. Owned by the team; all existing permissions, versioning, rollback apply unchanged.
- **Attribution**: reconciliation-authored versions have `versions.user_id = DEFAULT_MODELS_SYSTEM_USER_ID` (FR-014).
- **Provenance**: carried in cube `meta` (below), not in DB columns.

### Team Data Profile (transient)
- Output of the existing profiler for one team's partition slice. Not persisted; regenerated per reconciliation. (The fleet-wide change-detection snapshot — partition → {row count, max event time} — is persisted per run on `reconciliation_runs.drift_snapshot` to make "changed since last run" computable.)

## Meta conventions (inside model files)

```yaml
cubes:
  - name: SemanticEvents          # cube-level provenance (on every derived model)
    meta:
      default_model: true
      template: semantic_events        # template cube name
      template_checksum: "ab12..."     # versions.checksum of the template version applied
      default_model_unmanaged: true    # only present after template retirement (FR-020)
    dimensions:
      - name: partition
        meta:
          from_template: true          # template-owned field → converges on update (FR-012)
      - name: my_custom_field          # team-added → no from_template → preserved (FR-011)
```

- `from_template: true` marks template-owned fields; `templateMerger.js` converges these to the template.
- Probe-derived fields keep the existing `meta.auto_generated: true` marker and regenerate each reconciliation.
- Fields with neither marker are team-added and are always preserved.

## New: `reconciliation_runs` table

```sql
CREATE TABLE public.reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),  -- orchestrator refreshes periodically; stale (>10 min) 'running' rows are abandoned

  trigger text NOT NULL,                  -- 'schedule' | 'template_publish' | 'team_created' | 'manual'
  status text NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'halted' | 'failed'
  template_checksum text,                 -- template version this run converges toward
  drift_snapshot jsonb,                   -- partition -> {row_count, max_event_time} (D7)
  cohort_state jsonb,                     -- {current_cohort, cohorts_total, canary_team_ids, halt_threshold, failure_rate}
  outcomes jsonb NOT NULL DEFAULT '[]',   -- [{team_id, datasource_id, result, reason, version_id, breaking?}] — append ONLY via Hasura jsonb `_append` (atomic; concurrent workers must never read-modify-write)
  totals jsonb                            -- {updated, skipped_no_change, skipped_opt_out, skipped_collision, failed}
);
CREATE INDEX reconciliation_runs_started_at_idx ON public.reconciliation_runs (started_at DESC);
```

**Outcome `result` values**: `updated` | `updated_skeleton` | `skipped_no_change` | `skipped_opt_out` | `skipped_collision` | `failed`. (`updated_skeleton` WRITES a version — template structure only, empty partition — hence "updated", not "skipped".)

**Hasura permissions**: tracked, **no permissions for role `user`** (deny-by-default). All reads go through the admin-gated `getDefaultModelsReport` RPC (see contracts/actions-rpc.md). Writes use the admin-secret path from the Actions orchestrator only.

**Retention**: none initially; rows are small (one per run + outcomes array). Revisit if run cadence changes.

## New: `team.settings` key (no migration)

```jsonc
{
  "partition": "elko.is",                 // existing
  "internal_tables": ["semantic_events"], // existing
  "default_models": {
    "opt_out": ["order_metrics"]          // template names this team declined (FR-013)
  }
}
```

Owner-writable via the existing `updateTeamSettings` RPC (key is not rule-linked, so not stripped by its security filter). Reconciliation reads it per team; opted-out templates are neither created, recreated, nor updated.

## Configuration (env / config file — not DB)

| Key | Purpose |
|-----|---------|
| `DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID` | The platform-owned template datasource (D1) |
| `DEFAULT_MODELS_SYSTEM_USER_ID` | System identity for reconciliation-authored versions (D10). `versions.user_id` has an FK to `users` — the orchestrator idempotently ensures this user row exists before the first publish (see T013) |
| `DEFAULT_MODELS_TARGET_DATASOURCE_NAME` | Name matching the team datasource created by `provisionDefaultDatasources` (D2) |
| `DEFAULT_MODELS_CANARY_TEAM_IDS` | Extra canary cohort members beyond the fftech.is team (D8) |
| `DEFAULT_MODELS_HALT_THRESHOLD` | Cohort failure-rate halt threshold, default `0.2` (D8) |
| `DEFAULT_MODELS_COHORTS` | Number of rollout cohorts, default `4` (D8) |
| `DEFAULT_MODELS_DRIFT_PROBES` | JSON array `[{"table": "cst.semantic_events", "timeColumn": "timestamp"}]` — one drift probe per entry (D7). Assumes each table exposes a `partition` column (platform convention for the common store) |
| `ACTIONS_CRON_SECRET` | Shared secret for the unauthenticated `/rpc` dispatcher: cron trigger + internal callers send it as `x-actions-cron-secret`; the three default-models RPCs require it (or portal admin). MUST be set on the **hasura** container too — the cron header's `value_from_env` resolves there |

## State machines

### Reconciliation run
```
running ──all cohorts done──▶ completed
running ──failure rate > threshold in a cohort──▶ halted   (remaining teams untouched)
running ──orchestrator crash / fatal error──▶ failed        (per-team outcomes retained)
running ──heartbeat_at > 10 min old, next run starts──▶ failed (reason: stale_lease; new run takes over)
```

### Derived model (per team × template)
```
absent ──team has data──▶ tailored ──team adds fields──▶ customized
absent ──empty partition──▶ skeleton ──data arrives──▶ tailored
tailored/customized ──template update──▶ (validated) updated | (validation fails) unchanged + reported
tailored/customized ──team opts out──▶ frozen (never touched; deletion sticks)
tailored/customized ──team deletes, no opt-out──▶ recreated next run
tailored/customized ──template retired──▶ unmanaged (meta flag; no further updates)
```

## Validation rules (traceability)

| Rule | Enforced by | FR |
|------|-------------|-----|
| Derived model set exists per team per published template | orchestrator convergence loop | FR-002 |
| Only team's-own data reachable | baked partition literal (generation) + backstop rewrite rule | FR-005 |
| Template-owned content converges | `templateMerger.js` provenance classing | FR-012 |
| Team-added content preserved | existing user-content preservation + classing | FR-011 |
| No publish without compile validation | in-memory compile gate before version write | FR-009 |
| No-op runs write nothing | drift snapshot diff + existing checksum guard | FR-008 |
| Collision never overwrites team model | provenance-meta check before write | FR-019 |
| System changes attributed | `versions.user_id` = system user | FR-014 |
