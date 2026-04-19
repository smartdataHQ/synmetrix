import YAML from "yaml";

import { detectTokenType, verifyWorkOSToken, verifyFraiOSToken } from "../utils/workosAuth.js";
import { findUser, provisionUserFromWorkOS, provisionUserFromFraiOS } from "../utils/dataSourceHelpers.js";
import { parseCubesFromJs } from "../utils/smart-generation/diffModels.js";

/**
 * Extract cube name + description from a dataschema file.
 * Supports YAML (.yml/.yaml) and JS (.js) model formats.
 */
export function extractCubes(schema) {
  const code = schema.code;
  const name = schema.name || "";

  const isYaml = name.endsWith(".yml") || name.endsWith(".yaml");

  if (!code) return [];

  let cubes;
  if (isYaml) {
    try {
      const parsed = YAML.parse(code);
      cubes = parsed?.cubes;
    } catch {
      return [];
    }
  } else {
    cubes = parseCubesFromJs(code);
  }

  if (!Array.isArray(cubes)) return [];

  return cubes.map((c) => ({
    name: c.name,
    description: c.description || null,
  }));
}

/**
 * Build a set of team IDs whose partition matches the JWT partition claim.
 */
export function resolvePartitionTeamIds(members, partition) {
  if (!partition) return null; // no filtering if no partition in token
  const ids = new Set();
  for (const member of members) {
    if (member.team?.settings?.partition === partition) {
      ids.add(member.team_id);
    }
  }
  return ids;
}

/**
 * Build the datasources response from findUser result.
 * When partitionTeamIds is provided, only include datasources from those teams.
 */
export function buildDiscoverResponse(dataSources, partitionTeamIds) {
  const filtered = partitionTeamIds
    ? dataSources.filter((ds) => partitionTeamIds.has(ds.team_id))
    : dataSources;
  return filtered.map((ds) => {
    const activeBranch =
      ds.branches?.find((b) => b.status === "active") || ds.branches?.[0];
    const latestVersion = activeBranch?.versions?.[0] || null;
    const schemas = latestVersion?.dataschemas || [];

    const cubes = schemas.flatMap(extractCubes);

    return {
      id: ds.id,
      name: ds.name,
      db_type: ds.db_type,
      team_id: ds.team_id,
      branch_id: activeBranch?.id || null,
      version_id: latestVersion?.id || null,
      cubes,
    };
  });
}

/**
 * GET /api/v1/discover
 *
 * Returns all datasources and cubes available to the authenticated user.
 * Requires a WorkOS or FraiOS Bearer token. The user is auto-provisioned (JIT) if
 * this is their first request.
 *
 * Response:
 * {
 *   datasources: [
 *     {
 *       id, name, db_type, team_id, branch_id, version_id,
 *       cubes: [{ name, description }]
 *     }
 *   ]
 * }
 */
export default async function discover(req, res) {
  try {
    // --- Auth: WorkOS or FraiOS JWT ---
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(403).json({ error: "Authorization header required" });
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    if (!token) {
      return res.status(403).json({ error: "Bearer token required" });
    }

    const tokenType = detectTokenType(token);
    let payload, userId;

    if (tokenType === "workos") {
      payload = await verifyWorkOSToken(token);
      userId = await provisionUserFromWorkOS(payload);
    } else if (tokenType === "fraios") {
      payload = await verifyFraiOSToken(token);
      userId = await provisionUserFromFraiOS(payload);
    } else {
      return res.status(403).json({ error: "WorkOS or FraiOS token required" });
    }

    // --- Fetch user's datasources across all team memberships ---
    const user = await findUser({ userId });

    if (!user.dataSources?.length) {
      return res.json({ datasources: [] });
    }

    // Only return datasources from the team matching the JWT partition claim
    const partitionTeamIds = resolvePartitionTeamIds(
      user.members,
      payload.partition
    );

    res.json({
      datasources: buildDiscoverResponse(user.dataSources, partitionTeamIds),
      usage: {
        description:
          "All /api/v1/* endpoints (except /discover and /version) require these headers for datasource context.",
        required_headers: {
          Authorization: "Bearer <token>",
          "x-hasura-datasource-id":
            "The datasource 'id' from this response",
          "x-hasura-branch-id":
            "The 'branch_id' from this response (optional — defaults to active branch)",
          "x-hasura-branch-version-id":
            "The 'version_id' from this response (optional — defaults to latest version)",
        },
        endpoints: {
          "GET  /api/v1/discover":
            "This endpoint. Lists datasources and cubes available to the authenticated user. No datasource headers required.",
          "ALL  /v1/graphql":
            "GraphQL API (proxied to Hasura). Accepts WorkOS, FraiOS, and legacy Hasura tokens. No datasource headers required.",
          "ALL  /v1/ws":
            "WebSocket endpoint for GraphQL subscriptions (proxied to Hasura). Same auth as /v1/graphql.",
          "GET  /api/v1/meta":
            "Cube metadata — lists all cubes, measures, dimensions, and segments for the selected datasource.",
          "GET  /api/v1/meta-all":
            "Aggregated cube summaries across every visible datasource. No datasource headers required. Returns cube name/title/description, measure/dimension/segment names, and cube-level meta.",
          "POST /api/v1/load":
            "Run a Cube.js query. Supports format=csv|jsonstat|arrow|json (default json).",
          "GET  /api/v1/sql":
            "Preview the generated SQL for a Cube.js query without executing it.",
          "POST /api/v1/run-sql":
            "Execute raw SQL against the datasource.",
          "GET  /api/v1/test":
            "Test the datasource connection.",
          "GET  /api/v1/get-schema":
            "Retrieve the Cube.js data model schema.",
          "POST /api/v1/generate-models":
            "Auto-generate Cube.js models from database tables.",
          "POST /api/v1/smart-generate":
            "AI-assisted model generation.",
          "POST /api/v1/profile-table":
            "Profile a database table (column stats).",
          "POST /api/v1/column-values":
            "Fetch distinct values for a column.",
          "POST /api/v1/discover-nested":
            "Discover nested/array columns in a datasource.",
          "POST /api/v1/validate":
            "Validate a Cube.js model file.",
          "GET  /api/v1/pre-aggregations":
            "List pre-aggregations for the datasource.",
          "POST /api/v1/pre-aggregation-preview":
            "Preview pre-aggregation results.",
          "POST /api/v1/cubesql":
            "Execute SQL against the semantic layer (streaming JSONL response).",
          "GET  /api/v1/version":
            "Schema-compiler version (public, no auth required).",
        },
      },
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      console.error("discover error:", err);
    }
    res.status(status).json({
      error: status >= 500 ? "Internal server error" : err.message,
    });
  }
}
