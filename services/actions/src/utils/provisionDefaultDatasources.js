import { readFileSync } from "fs";
import { fetchGraphQL } from "./graphql.js";
import logger from "./logger.js";

const CONFIG_PATH =
  process.env.DEFAULT_DATASOURCES_CONFIG ||
  "/etc/synmetrix/default-datasources.json";

let cachedConfig = null;

function loadConfig() {
  if (cachedConfig) return cachedConfig;

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    cachedConfig = JSON.parse(raw);
    logger.log(
      `[ProvisionDS] Loaded ${cachedConfig.length} default datasource template(s)`
    );
    return cachedConfig;
  } catch (err) {
    if (err.code === "ENOENT") {
      logger.log("[ProvisionDS] No config file found, skipping provisioning");
    } else {
      logger.warn(`[ProvisionDS] Failed to load config: ${err.message}`);
    }
    return [];
  }
}

const existingDatasourcesQuery = `
  query ExistingDatasources($teamId: uuid!) {
    datasources(where: { team_id: { _eq: $teamId } }) {
      name
    }
  }
`;

const insertDatasourceMutation = `
  mutation InsertDatasource($object: datasources_insert_input!) {
    insert_datasources_one(object: $object) {
      id
      name
    }
  }
`;

export async function provisionDefaultDatasources({ teamId, userId }) {
  const templates = loadConfig();
  if (!templates.length) return [];

  let existing;
  try {
    const res = await fetchGraphQL(existingDatasourcesQuery, { teamId });
    existing = new Set(res.data?.datasources?.map((d) => d.name) || []);
  } catch (err) {
    logger.warn(
      `[ProvisionDS] Failed to check existing datasources for team ${teamId}: ${err.message}`
    );
    return [];
  }

  const created = [];

  for (const template of templates) {
    if (existing.has(template.name)) {
      logger.log(
        `[ProvisionDS] Skipping "${template.name}" for team ${teamId} (already exists)`
      );
      continue;
    }

    const password = template.secret_key
      ? process.env[template.secret_key]
      : undefined;

    if (template.secret_key && !password) {
      logger.warn(
        `[ProvisionDS] No env var "${template.secret_key}" for "${template.name}", skipping`
      );
      continue;
    }

    const dbParams = { ...template.db_params };
    if (password) {
      dbParams.password = password;
    }

    try {
      const res = await fetchGraphQL(insertDatasourceMutation, {
        object: {
          name: template.name,
          db_type: template.db_type,
          db_params: dbParams,
          team_id: teamId,
          user_id: userId,
          branches: {
            data: [{ status: "active", user_id: userId, name: "main" }],
          },
        },
      });

      const ds = res.data?.insert_datasources_one;
      if (ds) {
        created.push(ds.name);
        logger.log(
          `[ProvisionDS] Created "${ds.name}" (${ds.id}) for team ${teamId}`
        );
      }
    } catch (err) {
      logger.warn(
        `[ProvisionDS] Failed to create "${template.name}" for team ${teamId}: ${err.message}`
      );
    }
  }

  return created;
}
