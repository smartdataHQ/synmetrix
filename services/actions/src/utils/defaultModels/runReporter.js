// reconciliation_runs row lifecycle (013). All writes go through the Hasura
// admin-secret path. Outcome appends MUST stay atomic (jsonb _append) — the
// orchestrator appends from concurrent per-team worker calls and a
// read-modify-write would lose outcomes.

import { fetchGraphQL } from "../graphql.js";

export const STALE_LEASE_MS = 10 * 60 * 1000;

const INSERT_RUN = `
  mutation ($object: reconciliation_runs_insert_input!) {
    insert_reconciliation_runs_one(object: $object) {
      id
      started_at
      heartbeat_at
      trigger
      status
      template_checksum
    }
  }
`;

const RUNNING_RUNS = `
  query {
    reconciliation_runs(
      where: { status: { _eq: "running" } }
      order_by: { started_at: desc }
      limit: 1
    ) {
      id
      started_at
      heartbeat_at
      trigger
      template_checksum
      status
    }
  }
`;

const APPEND_OUTCOME = `
  mutation ($id: uuid!, $outcome: jsonb!) {
    update_reconciliation_runs_by_pk(
      pk_columns: { id: $id }
      _append: { outcomes: $outcome }
      _set: { heartbeat_at: "now()" }
    ) {
      id
    }
  }
`;

const HEARTBEAT = `
  mutation ($id: uuid!) {
    update_reconciliation_runs_by_pk(
      pk_columns: { id: $id }
      _set: { heartbeat_at: "now()" }
    ) {
      id
    }
  }
`;

const UPDATE_COHORT_STATE = `
  mutation ($id: uuid!, $cohortState: jsonb!) {
    update_reconciliation_runs_by_pk(
      pk_columns: { id: $id }
      _set: { cohort_state: $cohortState, heartbeat_at: "now()" }
    ) {
      id
    }
  }
`;

const SET_DRIFT_SNAPSHOT = `
  mutation ($id: uuid!, $driftSnapshot: jsonb!) {
    update_reconciliation_runs_by_pk(
      pk_columns: { id: $id }
      _set: { drift_snapshot: $driftSnapshot, heartbeat_at: "now()" }
    ) {
      id
    }
  }
`;

const FINALIZE_RUN = `
  mutation ($id: uuid!, $status: String!, $totals: jsonb) {
    update_reconciliation_runs_by_pk(
      pk_columns: { id: $id }
      _set: { status: $status, totals: $totals, finished_at: "now()" }
    ) {
      id
      status
    }
  }
`;

const LATEST_COMPLETED_RUN = `
  query {
    reconciliation_runs(
      where: { status: { _in: ["completed", "halted"] } }
      order_by: { started_at: desc }
      limit: 1
    ) {
      id
      started_at
      finished_at
      template_checksum
      drift_snapshot
      status
    }
  }
`;

export const computeTotals = (outcomes) =>
  outcomes.reduce((totals, outcome) => {
    totals[outcome.result] = (totals[outcome.result] || 0) + 1;
    return totals;
  }, {});

export default function createRunReporter({ execute = fetchGraphQL } = {}) {
  const startRun = async ({
    trigger,
    templateChecksum = null,
    driftSnapshot = null,
    cohortState = null,
  }) => {
    const res = await execute(INSERT_RUN, {
      object: {
        trigger,
        template_checksum: templateChecksum,
        drift_snapshot: driftSnapshot,
        cohort_state: cohortState,
      },
    });
    return res?.data?.insert_reconciliation_runs_one;
  };

  const getRunningRun = async () => {
    const res = await execute(RUNNING_RUNS, {});
    return res?.data?.reconciliation_runs?.[0] || null;
  };

  const appendOutcome = (runId, outcome) =>
    execute(APPEND_OUTCOME, { id: runId, outcome });

  const heartbeat = (runId) => execute(HEARTBEAT, { id: runId });

  const updateCohortState = (runId, cohortState) =>
    execute(UPDATE_COHORT_STATE, { id: runId, cohortState });

  const setDriftSnapshot = (runId, driftSnapshot) =>
    execute(SET_DRIFT_SNAPSHOT, { id: runId, driftSnapshot });

  const finalizeRun = (runId, { status, totals = null }) =>
    execute(FINALIZE_RUN, { id: runId, status, totals });

  const getLatestCompletedRun = async () => {
    const res = await execute(LATEST_COMPLETED_RUN, {});
    return res?.data?.reconciliation_runs?.[0] || null;
  };

  // Concurrency guard with stale-lease takeover: a 'running' row whose
  // heartbeat is older than 10 minutes is an abandoned orchestrator — mark it
  // failed (reason stale_lease) so the new run can proceed.
  const resolveActiveRun = async ({ now = Date.now() } = {}) => {
    const run = await getRunningRun();
    if (!run) {
      return { run: null, stale: false };
    }

    const heartbeatAge = now - new Date(run.heartbeat_at).getTime();
    if (heartbeatAge > STALE_LEASE_MS) {
      await finalizeRun(run.id, {
        status: "failed",
        totals: { reason: "stale_lease" },
      });
      return { run, stale: true };
    }

    return { run, stale: false };
  };

  // Single-team run (onboarding hook / admin retry): create the row, append
  // every outcome, finalize with computed totals.
  const recordSingleTeamRun = async ({
    trigger,
    templateChecksum = null,
    outcomes = [],
  }) => {
    const run = await startRun({ trigger, templateChecksum });
    for (const outcome of outcomes) {
      await appendOutcome(run.id, outcome);
    }
    await finalizeRun(run.id, {
      status: "completed",
      totals: computeTotals(outcomes),
    });
    return { runId: run.id, outcomes };
  };

  return {
    startRun,
    getRunningRun,
    getLatestCompletedRun,
    appendOutcome,
    heartbeat,
    updateCohortState,
    setDriftSnapshot,
    finalizeRun,
    resolveActiveRun,
    recordSingleTeamRun,
  };
}
