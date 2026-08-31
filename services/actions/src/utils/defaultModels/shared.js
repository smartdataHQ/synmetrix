// Shared plumbing for the default-models RPCs (013): auth gate, template
// catalog reads, per-team target resolution and the worker call.

import { fetchGraphQL } from "../graphql.js";
import { isPortalAdmin } from "../portalAdmin.js";

// Heavyweight modules (provisioning, JWT, cube client) are imported at call
// time: unit tests inject fakes for everything that reaches them, and the
// gate/report paths must not drag their dependency trees in.

/**
 * Auth gate for the three default-models RPCs. The /rpc dispatcher is
 * UNAUTHENTICATED — "no session" is NOT authorization. Allowed callers:
 * the cron trigger / internal hooks (x-actions-cron-secret) or a portal
 * admin. Returns null when authorized, an error object (403) otherwise.
 */
export const authorizeDefaultModelsRpc = async (
  session,
  headers,
  config,
  isAdmin = isPortalAdmin
) => {
  const provided = headers?.["x-actions-cron-secret"];
  if (config.cronSecret && provided && provided === config.cronSecret) {
    return null;
  }

  const userId = session?.["x-hasura-user-id"];
  if (userId && (await isAdmin(userId))) {
    return null;
  }

  return {
    error: true,
    status: 403,
    code: "forbidden",
    message:
      "default-models RPCs require the cron secret or portal-admin rights",
  };
};

const TEMPLATES_QUERY = `
  query ($id: uuid!) {
    datasources_by_pk(id: $id) {
      id
      branches(where: { status: { _eq: active } }, limit: 1) {
        id
        versions(limit: 1, order_by: { created_at: desc }) {
          id
          checksum
          dataschemas {
            id
            name
            code
          }
        }
      }
    }
  }
`;

/**
 * Published template set = dataschemas on the latest version of the active
 * branch of the platform-owned template datasource (research D1).
 */
export const fetchPublishedTemplates = async (config) => {
  const res = await fetchGraphQL(TEMPLATES_QUERY, {
    id: config.templateDatasourceId,
  });
  const version =
    res?.data?.datasources_by_pk?.branches?.[0]?.versions?.[0] || null;

  const templates = (version?.dataschemas || []).map((schema) => ({
    name: schema.name.replace(/\.(yml|yaml|js)$/i, ""),
    fileName: schema.name,
    code: schema.code,
    checksum: version.checksum,
  }));

  return { templateChecksum: version?.checksum || null, templates };
};

const ENSURE_SYSTEM_USER = `
  mutation ($id: uuid!) {
    insert_users_one(
      object: { id: $id, display_name: "Synmetrix System" }
      on_conflict: { constraint: users_pkey, update_columns: [] }
    ) {
      id
    }
  }
`;

/**
 * versions.user_id has an FK to users — idempotently ensure the configured
 * system identity exists before the first publish (research D10).
 */
export const ensureSystemUser = async (config) => {
  await fetchGraphQL(ENSURE_SYSTEM_USER, { id: config.systemUserId });
};

const ALL_TEAMS_QUERY = `
  query {
    teams(order_by: { created_at: asc }) {
      id
      name
      settings
    }
  }
`;

export const listAllTeams = async () => {
  const res = await fetchGraphQL(ALL_TEAMS_QUERY, {});
  return res?.data?.teams || [];
};

const TEAM_QUERY = `
  query ($id: uuid!) {
    teams_by_pk(id: $id) {
      id
      name
      settings
    }
  }
`;

export const getTeam = async (teamId) => {
  const res = await fetchGraphQL(TEAM_QUERY, { id: teamId });
  return res?.data?.teams_by_pk || null;
};

const TEAM_TARGET_QUERY = `
  query ($teamId: uuid!, $name: String!) {
    datasources(
      where: { team_id: { _eq: $teamId }, name: { _eq: $name } }
      limit: 1
    ) {
      id
      branches(where: { status: { _eq: active } }, limit: 1) {
        id
      }
    }
  }
`;

/**
 * Resolve the team's target datasource (matched by configured name, D2),
 * provisioning it via the existing seeding mechanism when absent. Returns
 * { datasourceId, branchId } or null when unprovisionable (no config entry
 * or missing secret env — recorded as target_datasource_unavailable).
 */
export const resolveTeamTarget = async (team, config) => {
  const lookup = async () => {
    const res = await fetchGraphQL(TEAM_TARGET_QUERY, {
      teamId: team.id,
      name: config.targetDatasourceName,
    });
    const ds = res?.data?.datasources?.[0];
    if (!ds || !ds.branches?.[0]) return null;
    return { datasourceId: ds.id, branchId: ds.branches[0].id };
  };

  let target = await lookup();
  if (target) return target;

  const { provisionDefaultDatasources } = await import(
    "../provisionDefaultDatasources.js"
  );
  await provisionDefaultDatasources({
    teamId: team.id,
    userId: config.systemUserId,
  });
  target = await lookup();
  return target;
};

/**
 * Call the CubeJS per-team worker with a system-user JWT
 * (contracts/cubejs-internal.md).
 */
export const callWorker = async (
  { team, datasourceId, branchId, templates, optOut, dryRun },
  config
) => {
  const { default: generateUserAccessToken } = await import("../jwt.js");
  const { default: cubejsApi } = await import("../cubejsApi.js");

  const token = await generateUserAccessToken(config.systemUserId);
  if (!token) {
    throw new Error("failed to mint system-user token");
  }
  const api = cubejsApi({
    dataSourceId: datasourceId,
    branchId,
    authToken: token,
  });
  const res = await api.reconcileTeam({
    teamId: team.id,
    datasourceId,
    branchId,
    partition: team.settings.partition,
    templates,
    optOut,
    dryRun,
  });
  return res?.outcomes || [];
};

/**
 * Reconcile one team end-to-end: opt-out read, target resolution
 * (provision-if-missing), worker call. Never throws for per-team faults —
 * they come back as `failed` outcomes so one team can never affect another
 * (FR-018).
 */
export const reconcileOneTeam = async (team, templates, config, options = {}) => {
  const {
    resolveTarget = resolveTeamTarget,
    worker = callWorker,
  } = options.deps || {};

  const settings = team.settings || {};
  const optOut = settings.default_models?.opt_out || [];

  if (!settings.partition) {
    return [
      { team_id: team.id, result: "failed", reason: "no_partition" },
    ];
  }

  let target;
  try {
    target = await resolveTarget(team, config);
  } catch (err) {
    target = null;
  }
  if (!target) {
    return [
      {
        team_id: team.id,
        result: "failed",
        reason: "target_datasource_unavailable",
      },
    ];
  }

  try {
    const outcomes = await worker(
      {
        team,
        datasourceId: target.datasourceId,
        branchId: target.branchId,
        templates,
        optOut,
        dryRun: options.dryRun || false,
      },
      config
    );
    return outcomes.map((outcome) => ({
      team_id: team.id,
      datasource_id: target.datasourceId,
      ...outcome,
    }));
  } catch (err) {
    return [
      {
        team_id: team.id,
        datasource_id: target.datasourceId,
        result: "failed",
        reason: err?.message || JSON.stringify(err),
      },
    ];
  }
};

/**
 * Fire-and-forget onboarding hook (FR-002, SC-001): called after team
 * creation from BOTH creation paths. Detached — a failure here is recovered
 * by the scheduled backfill and must never break provisioning.
 */
export const fireTeamReconcileHook = (teamId) => {
  import("../../rpc/reconcileTeamDefaultModels.js")
    .then(({ default: reconcile }) =>
      reconcile(
        null,
        { teamId, trigger: "team_created" },
        { "x-actions-cron-secret": process.env.ACTIONS_CRON_SECRET || "" }
      )
    )
    .then((res) => {
      if (res?.error) {
        console.warn(
          `[DefaultModels] onboarding reconcile for team ${teamId} skipped: ${res.message}`
        );
      }
    })
    .catch((err) => {
      console.warn(
        `[DefaultModels] onboarding reconcile for team ${teamId} failed: ${err?.message || err}`
      );
    });
};
