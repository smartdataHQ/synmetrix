-- Normalize existing team names to lowercase/trimmed
UPDATE public.teams SET name = lower(trim(name)) WHERE name != lower(trim(name));

-- Replace the plain unique constraint with a case-insensitive one
ALTER TABLE public.teams DROP CONSTRAINT IF EXISTS teams_name_unique;
CREATE UNIQUE INDEX teams_name_unique ON public.teams (lower(trim(name)));
