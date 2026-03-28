-- Revert to expression index (note: this will re-break Hasura on_conflict)
ALTER TABLE public.teams DROP CONSTRAINT IF EXISTS teams_name_unique;
CREATE UNIQUE INDEX teams_name_unique ON public.teams (lower(trim(name)));
