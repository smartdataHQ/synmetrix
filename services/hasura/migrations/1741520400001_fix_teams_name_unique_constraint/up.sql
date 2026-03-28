-- Fix: expression index cannot be used as Hasura on_conflict constraint target.
-- The expression index created by 1709836800001 breaks:
--   on_conflict: { constraint: teams_name_unique, update_columns: [] }
-- in the team auto-provisioning mutation (dataSourceHelpers.js).
--
-- Application code (deriveTeamName, findTeamByName) already normalizes
-- names to lower(trim(name)) before insert/lookup, so a plain constraint
-- is sufficient and Hasura-compatible.

-- Normalize any names that slipped through without lowering/trimming
UPDATE public.teams SET name = lower(trim(name)) WHERE name != lower(trim(name));

-- Drop the expression index and replace with a plain unique constraint
DROP INDEX IF EXISTS public.teams_name_unique;
ALTER TABLE public.teams ADD CONSTRAINT teams_name_unique UNIQUE (name);
