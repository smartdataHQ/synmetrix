-- fix/version-history-integrity
-- 1. Record which version a rollback restored. Nullable: only origin='rollback'
--    rows carry it. SET NULL so pruning an old version never blocks on a restore
--    that referenced it.
ALTER TABLE public.versions
  ADD COLUMN IF NOT EXISTS source_version_id uuid
  REFERENCES public.versions(id) ON DELETE SET NULL;

-- 2. PUT /api/v1/dataschema/:id audits under its own action.
ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_action_check
  CHECK (action IN ('dataschema_delete', 'version_rollback', 'dataschema_update'));
