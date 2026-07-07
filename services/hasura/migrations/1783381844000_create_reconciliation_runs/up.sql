-- Default-models reconciliation run lifecycle + per-team outcomes (013, FR-017/SC-008).
-- Written only via the Actions orchestrator (admin secret); read via getDefaultModelsReport RPC.
CREATE TABLE public.reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- orchestrator refreshes periodically; 'running' rows with a heartbeat older
  -- than 10 minutes are abandoned (stale-lease takeover)
  heartbeat_at timestamptz NOT NULL DEFAULT now(),

  trigger text NOT NULL,                  -- 'schedule' | 'template_publish' | 'team_created' | 'manual'
  status text NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'halted' | 'failed'
  template_checksum text,                 -- template version this run converges toward
  drift_snapshot jsonb,                   -- partition -> {row_count, max_event_time}
  cohort_state jsonb,                     -- {current_cohort, cohorts_total, canary_team_ids, halt_threshold, failure_rate}
  -- [{team_id, datasource_id, result, reason, version_id, breaking?}]
  -- append ONLY via Hasura jsonb _append (atomic; never read-modify-write)
  outcomes jsonb NOT NULL DEFAULT '[]',
  totals jsonb                            -- {updated, skipped_no_change, skipped_opt_out, skipped_collision, failed}
);

CREATE INDEX reconciliation_runs_started_at_idx
  ON public.reconciliation_runs (started_at DESC);
