ALTER TABLE public.teams DROP CONSTRAINT IF EXISTS teams_name_unique;
ALTER TABLE public.teams ADD CONSTRAINT teams_user_id_name_key UNIQUE (user_id, name);

ALTER TABLE auth.accounts DROP CONSTRAINT IF EXISTS accounts_workos_user_id_unique;
ALTER TABLE auth.accounts DROP COLUMN IF EXISTS workos_user_id;
