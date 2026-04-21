-- Reverse of up.sql for feature 011-model-mgmt-api.
DROP INDEX IF EXISTS public.audit_logs_action_idx;
DROP INDEX IF EXISTS public.audit_logs_user_id_idx;
DROP INDEX IF EXISTS public.audit_logs_created_at_idx;
DROP TABLE IF EXISTS public.audit_logs;

DROP TRIGGER IF EXISTS versions_flip_is_current_trg ON public.versions;
DROP FUNCTION IF EXISTS public.versions_flip_is_current();

ALTER TABLE public.versions DROP COLUMN IF EXISTS is_current;
ALTER TABLE public.versions DROP COLUMN IF EXISTS origin;
