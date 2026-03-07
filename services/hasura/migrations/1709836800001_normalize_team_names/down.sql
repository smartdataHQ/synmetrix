DROP INDEX IF EXISTS public.teams_name_unique;
ALTER TABLE public.teams ADD CONSTRAINT teams_name_unique UNIQUE (name);
