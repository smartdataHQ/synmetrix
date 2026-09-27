DELETE FROM public.audit_logs WHERE action = 'dataschema_update';
ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_action_check
  CHECK (action IN ('dataschema_delete', 'version_rollback'));

ALTER TABLE public.versions DROP COLUMN IF EXISTS source_version_id;
