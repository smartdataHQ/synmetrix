ALTER TABLE auth.accounts ADD COLUMN IF NOT EXISTS workos_user_id text;
ALTER TABLE auth.accounts ADD CONSTRAINT accounts_workos_user_id_unique UNIQUE (workos_user_id);

ALTER TABLE public.teams DROP CONSTRAINT IF EXISTS teams_user_id_name_key;
ALTER TABLE public.teams ADD CONSTRAINT teams_name_unique UNIQUE (name);
