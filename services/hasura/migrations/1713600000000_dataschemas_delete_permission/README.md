# Migration `1713600000000_dataschemas_delete_permission`

Feature: `011-model-mgmt-api`.

## What it does

SQL (in `up.sql`):
1. Adds `versions.origin TEXT NOT NULL DEFAULT 'user'` with a CHECK constraint on `('user','smart_gen','rollback')`.
2. Adds `versions.is_current BOOLEAN NOT NULL DEFAULT true`.
3. **Backfills** `versions.is_current = false` for every version that is not the newest of its branch. The backfill runs in 1 000-row batches inside a `DO` block so a large table does not hold a long row-level lock.
4. Installs the `versions_flip_is_current()` trigger function and the `versions_flip_is_current_trg` AFTER-INSERT trigger. The function takes a transaction-scoped advisory lock keyed on `hashtextextended(NEW.branch_id::text, 0)`, which serialises concurrent inserts **on the same branch** and eliminates the race where two inserts could both leave `is_current = true`. Inserts on different branches still proceed in parallel.
5. Creates `audit_logs` table + three indexes (`created_at DESC`, `user_id`, `action`).

Hasura metadata (in `services/hasura/metadata/tables.yaml`):
- `dataschemas.delete_permissions` for role `user`: allowed only when the caller is owner/admin on the datasource's team AND the version is `is_current = true` AND the branch is `status = active`.
- `versions.event_triggers` adds `version_rollback_audit` → `{{ACTIONS_URL}}/rpc/audit_version_rollback`.
- `dataschemas.event_triggers` adds `delete_dataschema_audit` → `{{ACTIONS_URL}}/rpc/audit_dataschema_delete`.
- `audit_logs` table definition with admin-only permissions and FK object relationships.

Cron (in `services/hasura/metadata/cron_triggers.yaml`):
- `audit_logs_retention_90d` fires daily, POSTs to `{{ACTIONS_URL}}/rpc/audit_logs_retention`. The RPC handler in `services/actions/src/rpc/auditLogsRetention.js` deletes rows older than 90 days.

## Applying

```bash
./cli.sh hasura cli "migrate apply"
./cli.sh hasura cli "metadata apply"
```

Metadata apply must run **after** the SQL migration — it references the new `versions.is_current` column in the delete permission filter.

## Size / duration expectations

The migration touches three rows per version row in the worst case (column add × 2 + backfill update). Rough guidance on a typical PG 14 instance with `versions` indexed by `(branch_id, created_at DESC)`:

| `versions` row count | Backfill wall-clock (approx.) |
|---|---|
| 1 000 | < 1 s |
| 10 000 | a few seconds |
| 100 000 | seconds to low tens of seconds |
| 1 000 000+ | measure on staging first; consider a maintenance window |

The backfill's batching bounds the worst-case lock held on individual rows, not the total wall-clock. On a busy writer workload, the total duration can still be longer than a single-batch estimate.

## Rolling back

```bash
./cli.sh hasura cli "migrate apply --down 1"
```

`down.sql` drops, in order:
- `audit_logs` indexes and table (data loss — audit records for the retention window are discarded);
- the `versions_flip_is_current_trg` trigger and its function;
- the `versions.is_current` and `versions.origin` columns.

Metadata will diverge from the migrated state after a down; run `./cli.sh hasura cli "metadata apply"` once the baseline metadata (pre-feature) is checked out.

## Pre-flight checklist

- [ ] `SELECT count(*) FROM versions;` — if > 100 000, run the backfill in a maintenance window or accept a short write pause.
- [ ] Actions container is up and reachable on `ACTIONS_URL`. The event triggers start firing the instant metadata is applied; if Actions is unreachable, Hasura retries three times per the `retry_conf`, then silently logs the failure.
- [ ] The `hasura-migrations` container image must be rebuilt to include this migration directory. Kustomize: bump the image tag in `data/synmetrix/overlays/<env>/kustomization.yaml`.
- [ ] Client-v2 needs **no** changes — this migration is strictly additive. Existing GraphQL queries continue to work; `origin` and `is_current` are additional selectable columns, not required arguments on any existing mutation.

## Post-flight checks

```sql
-- Every branch has exactly one current version.
SELECT branch_id, count(*) FILTER (WHERE is_current) AS c, count(*) t
FROM versions GROUP BY branch_id HAVING count(*) FILTER (WHERE is_current) <> 1;
-- (expect 0 rows)

-- Audit writer is reachable.
SELECT count(*) FROM audit_logs WHERE created_at > now() - interval '1 hour';
-- (non-zero after the first delete or rollback)
```
