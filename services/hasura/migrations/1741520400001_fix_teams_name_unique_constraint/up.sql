-- Fix: expression index cannot be used as Hasura on_conflict constraint target.
-- The expression index created by 1709836800001 breaks:
--   on_conflict: { constraint: teams_name_unique, update_columns: [] }
-- in the team auto-provisioning mutation (dataSourceHelpers.js).
--
-- Application code (deriveTeamName, findTeamByName) already normalizes
-- names to lower(trim(name)) before insert/lookup, so a plain constraint
-- is sufficient and Hasura-compatible.
--
-- Idempotent across every possible starting state:
--   (a) expression index teams_name_unique exists          → drop it, add constraint
--   (b) plain UNIQUE constraint teams_name_unique exists   → no-op
--   (c) neither exists                                     → add constraint
-- Required because an earlier version of this migration blindly ran
-- `DROP INDEX IF EXISTS` followed by `ADD CONSTRAINT`, which fails with
-- "cannot drop index because constraint requires it" whenever the constraint
-- had already been created (locally or via partial reruns). The pattern below
-- lets `hasura-cli migrate apply` succeed on every environment regardless of
-- prior state, including environments where a human manually added the
-- constraint after the first attempt failed.

-- Normalize any names that slipped through without lowering/trimming.
-- Skip rows whose normalized form would collide with an existing row — the
-- constraint below is case-sensitive on the exact stored string, so leaving
-- those rows un-normalized is safe: they coexist with the normalized
-- counterpart and the application only ever writes the normalized form.
-- Blindly normalising would hit a duplicate-key error on the UPDATE itself.
UPDATE public.teams t
   SET name = lower(trim(t.name))
 WHERE t.name <> lower(trim(t.name))
   AND NOT EXISTS (
     SELECT 1
       FROM public.teams u
      WHERE u.id <> t.id
        AND u.name = lower(trim(t.name))
   );

DO $$
BEGIN
  -- Case (b): constraint already present, nothing to do.
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'teams_name_unique'
       AND conrelid = 'public.teams'::regclass
  ) THEN
    RETURN;
  END IF;

  -- Case (a): expression index exists without a constraint backing it.
  -- DROP it so we can cleanly add the constraint below.
  IF EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'teams_name_unique'
  ) THEN
    EXECUTE 'DROP INDEX public.teams_name_unique';
  END IF;

  -- Cases (a) and (c): add the plain constraint.
  EXECUTE 'ALTER TABLE public.teams ADD CONSTRAINT teams_name_unique UNIQUE (name)';
END
$$;
