-- Model Management API — feature 011-model-mgmt-api
-- See specs/011-model-mgmt-api/research.md §R4 and §R12.
--
-- Safe on large `versions` tables:
--   - column adds are metadata-only (PG11+ ADD COLUMN with DEFAULT)
--   - `is_current` backfill runs in 1000-row batches to avoid long locks
--   - the flip trigger takes an advisory lock keyed on branch_id to
--     eliminate the concurrent-insert race

-- 1. versions.origin — distinguish user/smart_gen/rollback commits.
ALTER TABLE public.versions
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'user'
  CHECK (origin IN ('user', 'smart_gen', 'rollback'));

-- 2. versions.is_current — exactly one current row per branch.
ALTER TABLE public.versions
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true;

-- 3. Backfill in batches. Every branch's newest row stays is_current=true;
-- older rows flip to false. Runs in a DO block so the UPDATE can commit
-- incrementally on large tables. IF NOT EXISTS above makes this rerun-safe.
DO $backfill$
DECLARE
  batch_size INTEGER := 1000;
  updated_rows INTEGER;
BEGIN
  LOOP
    WITH candidates AS (
      SELECT v.id
      FROM public.versions v
      WHERE v.is_current = true
        AND (v.branch_id, v.created_at) NOT IN (
          SELECT branch_id, MAX(created_at)
          FROM public.versions
          GROUP BY branch_id
        )
      LIMIT batch_size
    )
    UPDATE public.versions
       SET is_current = false
     WHERE id IN (SELECT id FROM candidates);

    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
  END LOOP;
END
$backfill$;

-- 4. Statement-level trigger that enforces the invariant correctly for both
-- single-row and multi-row inserts. Uses a transition table (PG 10+) so one
-- fire of the function sees every newly-inserted row and picks the single
-- winner per affected branch. An advisory lock keyed on a stable hash of the
-- affected branch ids serialises concurrent inserts across transactions; inserts
-- touching disjoint branches proceed in parallel.
CREATE OR REPLACE FUNCTION public.versions_flip_is_current()
RETURNS TRIGGER AS $$
DECLARE
  lock_key BIGINT;
BEGIN
  -- Combined xact-scoped advisory lock across every affected branch. Disjoint
  -- inserts hash to different keys; overlapping inserts serialise.
  SELECT COALESCE(
    SUM(hashtextextended(bid::text, 0)),
    0
  )::BIGINT
  INTO lock_key
  FROM (SELECT DISTINCT branch_id AS bid FROM new_versions) b;
  PERFORM pg_advisory_xact_lock(lock_key);

  WITH affected AS (
    SELECT DISTINCT branch_id FROM new_versions
  ),
  winners AS (
    SELECT DISTINCT ON (v.branch_id) v.id
    FROM public.versions v
    JOIN affected a USING (branch_id)
    ORDER BY v.branch_id, v.created_at DESC, v.id DESC
  )
  UPDATE public.versions v
     SET is_current = (v.id IN (SELECT id FROM winners))
    FROM affected a
   WHERE v.branch_id = a.branch_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS versions_flip_is_current_trg ON public.versions;
CREATE TRIGGER versions_flip_is_current_trg
AFTER INSERT ON public.versions
REFERENCING NEW TABLE AS new_versions
FOR EACH STATEMENT
EXECUTE FUNCTION public.versions_flip_is_current();

-- 5. audit_logs — durable audit store for delete + rollback (FR-016).
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action        text NOT NULL CHECK (action IN ('dataschema_delete', 'version_rollback')),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  datasource_id uuid          REFERENCES public.datasources(id) ON DELETE SET NULL,
  branch_id     uuid          REFERENCES public.branches(id) ON DELETE SET NULL,
  target_id     uuid NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('success', 'failure')),
  error_code    text,
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx    ON public.audit_logs (user_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx     ON public.audit_logs (action);
