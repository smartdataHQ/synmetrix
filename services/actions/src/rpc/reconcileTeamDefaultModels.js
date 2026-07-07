// Single-team default-models reconcile (013, contracts/actions-rpc.md).
// Callers: the onboarding hook (fire-and-forget) and platform admins (retry).

// apiError is imported at call time (its logger dependency chain must not
// load during unit tests)
import { loadDefaultModelsConfig } from "../utils/defaultModels/config.js";
import createRunReporter from "../utils/defaultModels/runReporter.js";
import {
  authorizeDefaultModelsRpc,
  ensureSystemUser as ensureSystemUserImpl,
  fetchPublishedTemplates,
  getTeam as getTeamImpl,
  reconcileOneTeam as reconcileOneTeamImpl,
} from "../utils/defaultModels/shared.js";

export default async (session, input, headers, deps = {}) => {
  const {
    loadConfig = loadDefaultModelsConfig,
    reporter = createRunReporter(),
    ensureSystemUser = ensureSystemUserImpl,
    fetchTemplates = fetchPublishedTemplates,
    getTeam = getTeamImpl,
    reconcileOneTeam = reconcileOneTeamImpl,
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

  // Auth gate FIRST — the /rpc dispatcher is unauthenticated.
  const denied = await authorizeDefaultModelsRpc(session, headers, config, isAdmin);
  if (denied) {
    return denied;
  }

  const { teamId, trigger = "manual" } = input || {};
  if (!teamId) {
    return { error: true, code: "invalid_input", message: "teamId is required" };
  }

  try {
    const team = await getTeam(teamId);
    if (!team) {
      return {
        error: true,
        status: 404,
        code: "team_not_found",
        message: `team ${teamId} not found`,
      };
    }

    // versions.user_id FK — bootstrap the system identity idempotently
    await ensureSystemUser(config);

    const { templateChecksum, templates } = await fetchTemplates(config);
    if (templates.length === 0) {
      return { runId: null, teamId, outcomes: [], status: "noop" };
    }

    let outcomes;
    try {
      outcomes = await reconcileOneTeam(team, templates, config, {});
    } catch (err) {
      outcomes = [
        {
          team_id: team.id,
          result: "failed",
          reason: err?.message || String(err),
        },
      ];
    }

    const { runId } = await reporter.recordSingleTeamRun({
      trigger,
      templateChecksum,
      outcomes,
    });

    return { runId, teamId, outcomes };
  } catch (err) {
    const { default: apiError } = await import("../utils/apiError.js");
    return apiError(err);
  }
};
