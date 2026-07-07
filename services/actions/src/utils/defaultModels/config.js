// Default-models (013) configuration: reads and validates the DEFAULT_MODELS_*
// env keys. Required keys throw with an explicit list so a misconfigured
// deployment fails at the first RPC call, not deep inside a reconcile run.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REQUIRED_KEYS = [
  "DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID",
  "DEFAULT_MODELS_SYSTEM_USER_ID",
  "DEFAULT_MODELS_TARGET_DATASOURCE_NAME",
];

const fail = (message) => {
  throw new Error(`default-models config: ${message}`);
};

const parseDriftProbes = (raw) => {
  if (!raw || !raw.trim()) {
    // empty = no drift probes configured — treat all teams as changed
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`DEFAULT_MODELS_DRIFT_PROBES is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    fail("DEFAULT_MODELS_DRIFT_PROBES must be a JSON array");
  }

  for (const probe of parsed) {
    if (
      !probe ||
      typeof probe.table !== "string" ||
      !probe.table.trim() ||
      typeof probe.timeColumn !== "string" ||
      !probe.timeColumn.trim()
    ) {
      fail(
        "DEFAULT_MODELS_DRIFT_PROBES entries must be {table, timeColumn} strings"
      );
    }
  }

  return parsed.map(({ table, timeColumn }) => ({ table, timeColumn }));
};

export const loadDefaultModelsConfig = (env = process.env) => {
  const missing = REQUIRED_KEYS.filter((key) => !env[key] || !env[key].trim());
  if (missing.length > 0) {
    fail(`missing required env keys: ${missing.join(", ")}`);
  }

  const templateDatasourceId = env.DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID.trim();
  const systemUserId = env.DEFAULT_MODELS_SYSTEM_USER_ID.trim();
  if (!UUID_RE.test(templateDatasourceId)) {
    fail("DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID must be a UUID");
  }
  if (!UUID_RE.test(systemUserId)) {
    fail("DEFAULT_MODELS_SYSTEM_USER_ID must be a UUID");
  }

  const haltThreshold = env.DEFAULT_MODELS_HALT_THRESHOLD
    ? Number(env.DEFAULT_MODELS_HALT_THRESHOLD)
    : 0.2;
  if (!Number.isFinite(haltThreshold) || haltThreshold <= 0 || haltThreshold > 1) {
    fail("DEFAULT_MODELS_HALT_THRESHOLD must be a number in (0, 1]");
  }

  const cohorts = env.DEFAULT_MODELS_COHORTS
    ? Number(env.DEFAULT_MODELS_COHORTS)
    : 4;
  if (!Number.isInteger(cohorts) || cohorts < 1) {
    fail("DEFAULT_MODELS_COHORTS must be a positive integer");
  }

  const canaryTeamIds = (env.DEFAULT_MODELS_CANARY_TEAM_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return {
    templateDatasourceId,
    systemUserId,
    targetDatasourceName: env.DEFAULT_MODELS_TARGET_DATASOURCE_NAME.trim(),
    canaryTeamIds,
    haltThreshold,
    cohorts,
    driftProbes: parseDriftProbes(env.DEFAULT_MODELS_DRIFT_PROBES),
    cronSecret: env.ACTIONS_CRON_SECRET || null,
  };
};

export default loadDefaultModelsConfig;
