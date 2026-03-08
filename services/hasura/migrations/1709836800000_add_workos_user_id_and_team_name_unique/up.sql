ALTER TABLE auth.accounts ADD COLUMN IF NOT EXISTS workos_user_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_workos_user_id_unique') THEN
    ALTER TABLE auth.accounts ADD CONSTRAINT accounts_workos_user_id_unique UNIQUE (workos_user_id);
  END IF;
END $$;

-- Deduplicate team names before adding unique constraint:
-- append user_id suffix to duplicates, keeping the oldest row unchanged
UPDATE public.teams t
SET name = t.name || '-' || LEFT(t.user_id::text, 8)
WHERE t.id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at ASC) AS rn
    FROM public.teams
  ) sub WHERE sub.rn > 1
);

ALTER TABLE public.teams DROP CONSTRAINT IF EXISTS teams_user_id_name_key;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_name_unique') THEN
    ALTER TABLE public.teams ADD CONSTRAINT teams_name_unique UNIQUE (name);
  END IF;
END $$;
