// Per-run default-models report for platform admins (013, FR-017/SC-008):
// "which teams are on the latest template, which are behind, and why" from a
// single run row. Cron-secret or portal-admin gated.

// apiError is imported at call time (its logger dependency chain must not
// load during unit tests)
import { fetchGraphQL } from "../utils/graphql.js";
import { loadDefaultModelsConfig } from "../utils/defaultModels/config.js";
import { authorizeDefaultModelsRpc } from "../utils/defaultModels/shared.js";

const RUN_BY_ID = `
  query ($id: uuid!) {
    reconciliation_runs_by_pk(id: $id) {
      id
      trigger
      status
      started_at
      finished_at
      template_checksum
      cohort_state
      outcomes
      totals
    }
  }
`;

const LATEST_RUN = `
  query {
    reconciliation_runs(order_by: { started_at: desc }, limit: 1) {
      id
      trigger
      status
      started_at
      finished_at
      template_checksum
      cohort_state
      outcomes
      totals
    }
  }
`;

const TEAM_NAMES = `
  query ($ids: [uuid!]!) {
    teams(where: { id: { _in: $ids } }) {
      id
      name
    }
  }
`;

// outcomes that leave a team NOT on the latest template
const BEHIND_RESULTS = new Set(["failed", "skipped_collision"]);

export default async (session, input, headers, deps = {}) => {
  const {
    loadConfig = loadDefaultModelsConfig,
    execute = fetchGraphQL,
    isAdmin,
  } = deps;

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return {
      error: true,
      status: 503,
      code: "default_models_unconfigured",
      message: err.message,
    };
  }

  const denied = await authorizeDefaultModelsRpc(session, headers, config, isAdmin);
  if (denied) {
    return denied;
  }

  const { runId } = input || {};

  try {
    let run;
    if (runId) {
      const res = await execute(RUN_BY_ID, { id: runId });
      run = res?.data?.reconciliation_runs_by_pk;
    } else {
      const res = await execute(LATEST_RUN, {});
      run = res?.data?.reconciliation_runs?.[0];
    }

    if (!run) {
      return {
        error: true,
        status: 404,
        code: "run_not_found",
        message: runId ? `run ${runId} not found` : "no reconciliation runs yet",
      };
    }

    const outcomes = Array.isArray(run.outcomes) ? run.outcomes : [];

    const teamIds = [...new Set(outcomes.map((o) => o.team_id).filter(Boolean))];
    let teamNames = new Map();
    if (teamIds.length > 0) {
      const namesRes = await execute(TEAM_NAMES, { ids: teamIds });
      teamNames = new Map(
        (namesRes?.data?.teams || []).map((t) => [t.id, t.name])
      );
    }

    const teamsBehind = outcomes
      .filter((o) => BEHIND_RESULTS.has(o.result))
      .map((o) => ({
        teamId: o.team_id,
        teamName: teamNames.get(o.team_id) || null,
        template: o.template || null,
        result: o.result,
        reason: o.reason || null,
      }));

    // SC-003 companion: members the template update removed/renamed, per team
    const breakingChanges = outcomes
      .filter((o) => Array.isArray(o.breaking) && o.breaking.length > 0)
      .map((o) => ({
        teamId: o.team_id,
        teamName: teamNames.get(o.team_id) || null,
        template: o.template || null,
        removedMembers: o.breaking,
      }));

    return {
      run: {
        id: run.id,
        trigger: run.trigger,
        status: run.status,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        templateChecksum: run.template_checksum,
        cohortState: run.cohort_state,
      },
      totals: run.totals || {},
      teamsBehind,
      breakingChanges,
    };
  } catch (err) {
    const { default: apiError } = await import("../utils/apiError.js");
    return apiError(err);
  }
};
