# Deployment Runbook — Model Management API (011-model-mgmt-api)

## Artefacts shipped

- **`services/cubejs`**: 6 new routes, 10 new utilities, refactored `metaAll.js`. Image: `quicklookup/synmetrix-cube`.
- **`services/actions`**: 3 new RPC handlers (`auditDataschemaDelete`, `auditVersionRollback`, `auditLogsRetention`). Image: `quicklookup/synmetrix-actions`.
- **`services/hasura`**: one new migration (`1713600000000_dataschemas_delete_permission`) + metadata changes (delete_permissions, event triggers, audit_logs table, cron trigger). Image: `quicklookup/synmetrix-hasura-migrations`.

## Order of operations

Use the Kustomize overlay flow in the `cxs` repo. **Deploy Hasura migrations image + metadata apply before the cube/actions rollouts** — routes assume `audit_logs` exists and `versions.origin` / `versions.is_current` columns are present.

1. Merge this branch to `main` in `synmetrix`. CI builds the three images under tags `{short-sha}`, `{branch}-{short-sha}`, `{branch}`, `latest`.
2. In `cxs` repo, bump `newTag` for all three images in `data/synmetrix/overlays/staging/kustomization.yaml`. Apply to staging first. Watch the `hasura-migrations` job log for the backfill line count.
3. Smoke-check staging (see [Post-deploy checks](#post-deploy-checks)).
4. Promote to production by bumping the same tags in `data/synmetrix/overlays/production/kustomization.yaml`.

## Pre-deploy risk checks

Run against the **target** database before bumping tags:

```sql
-- A. How much data will the backfill touch?
SELECT count(*) AS total_versions,
       count(DISTINCT branch_id) AS branches,
       max(ct) AS max_per_branch
  FROM (SELECT branch_id, count(*) ct FROM versions GROUP BY branch_id) q;

-- B. Storage budget for audit_logs (90-day retention at current delete/rollback cadence)
SELECT count(*) FILTER (
  WHERE NOT (origin = 'rollback')
) AS rollback_candidates FROM versions;
```

If `total_versions > 100 000`: run the backfill in a low-traffic window. The DO-block in `up.sql` already batches at 1 000 rows, but the whole thing still takes one long migration and metadata is applied at the end.

## Migration details

The migration (`services/hasura/migrations/1713600000000_dataschemas_delete_permission/up.sql`):

- Adds `versions.origin text NOT NULL DEFAULT 'user'` with CHECK `('user','smart_gen','rollback')`.
- Adds `versions.is_current boolean NOT NULL DEFAULT true`.
- Backfills `is_current = false` on older versions **in batches of 1 000**.
- Installs a **statement-level** `versions_flip_is_current_trg` trigger using a NEW TABLE transition table, which handles bulk inserts correctly (row-level triggers would break the invariant on multi-row inserts — verified).
- The trigger takes a transaction-scoped advisory lock summing the hashes of affected branches, so concurrent inserts on the same branch serialise; different branches still insert in parallel. **Verified under concurrent 10×2 bulk inserts on the same branch — invariant held.**
- Creates `audit_logs` with three indexes.

The corresponding metadata changes land in `services/hasura/metadata/tables.yaml` and `services/hasura/metadata/cron_triggers.yaml`.

## Post-deploy checks

Run after each environment's rollout.

### 1. Migration applied + invariant holds

```sql
SELECT branch_id, count(*) FILTER (WHERE is_current) AS c
  FROM versions GROUP BY branch_id
 HAVING count(*) FILTER (WHERE is_current) <> 1;
-- expect 0 rows
```

### 2. Event triggers reachable

Trigger a delete and confirm the audit row appears within a few seconds:

```bash
# Where $DS_ID owns $TARGET via an owner/admin caller
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://$HOST/api/v1/dataschema/$TARGET
# Expect 200 with {deleted: true, dataschemaId: $TARGET}

# Wait 2 s then:
```
```sql
SELECT * FROM audit_logs
  WHERE action = 'dataschema_delete'
    AND target_id = '<TARGET>'
  ORDER BY created_at DESC LIMIT 1;
-- outcome = success, error_code = NULL, created_at within the last minute
```

### 3. Refresh + meta-all latency baseline

```bash
curl -s -w "refresh: %{time_total}s\n" -o /dev/null -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"branchId\":\"$BRANCH\"}" \
  https://$HOST/api/v1/internal/refresh-compiler

curl -s -w "meta-all: %{time_total}s (bytes %{size_download})\n" -o /dev/null \
  -H "Authorization: Bearer $TOKEN" https://$HOST/api/v1/meta-all
```

On the local dev stack (15 datasources, 17 cubes total) `/meta-all` averages ~40 ms warm. A production tenant will be higher — flag if it exceeds 2 s.

### 4. Client-v2 regression

Exercise at least:
- `/v1/graphql` proxy (any GraphQL query the frontend runs — `users(limit:1)` is enough).
- Model editor load → save → re-open (exercises `versions.insert` → new trigger → audit trigger for origin='rollback' case is skipped, generateDataSchema sets origin='user').
- Data source switch → catalog load (`/api/v1/meta-all`).

Expect identical UI behaviour. The two new cube-envelope fields (`dataschema_id`, `file_name`) are additive; existing code ignores unknown fields.

## Rollback

```bash
./cli.sh hasura cli "migrate apply --version 1713600000000 --type down"
./cli.sh hasura cli "metadata apply"  # after reverting metadata files
```

`down.sql` drops, in order: `audit_logs` indexes and table (data loss), the trigger + function, the `is_current` and `origin` columns.

Rolling back the Hasura migration **only** (leaving the cube/actions image rolled forward) will cause `delete`, `rollback`, `validate-in-branch replace/preview-delete` to fail with 503/hasura_unavailable — the handlers assume the new columns exist. Roll cube + actions back in the same sweep.

## Deferred items (not blocking deploy)

- Tychi skill doc in `cxs-agents` repo (T013i + T048) — separate PR.
- `rollback_source_columns_missing` check in `versionRollback.js` — driver round-trip; Hasura errors surface via `hasura_rejected` in the interim.
- StepCI `model-management/` folder is not yet wired into `tests/stepci/workflow.yml`'s `include:` list — operator runs it standalone for now.

## Risk summary

| Risk | Severity | Mitigated by |
|---|---|---|
| Long backfill on large `versions` table | Medium | Batched at 1 000 rows; staging rehearsal recommended for >100k |
| Trigger write amplification per version insert | Low | Statement-level, one UPDATE per affected branch, indexed; measured O(branch size) |
| Concurrent-insert race on `is_current` | Resolved | Advisory lock keyed on affected-branch hash sum; stress-tested 2×10 concurrent bulk inserts |
| Multi-row INSERT breaks invariant | Resolved | Statement-level trigger with transition table |
| `audit_logs` unbounded growth | Low | Daily cron enforces 90-day retention (`audit_logs_retention` RPC) |
| Actions RPC handlers fail to load | Low | Tests load all three with HASURA unreachable; handlers return `{ok:false}` rather than crash |
| `/meta-all` extra CPU per call (per-schema YAML parse) | Low | Local baseline 36–48 ms warm; watch `p95` on staging before promoting |
| `dataschema_id` / `file_name` on cube summaries | Low | Purely additive; unit-tested; no downstream consumer breaks |
