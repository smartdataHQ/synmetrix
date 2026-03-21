import YAML from "yaml";

import { verifyWorkOSToken } from "../utils/workosAuth.js";
import { findUser, provisionUserFromWorkOS } from "../utils/dataSourceHelpers.js";
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
 * Build the datasources response from findUser result.
 */
export function buildDiscoverResponse(dataSources) {
  return dataSources.map((ds) => {
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
 * Requires a WorkOS Bearer token. The user is auto-provisioned (JIT) if
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
    // --- Auth: WorkOS JWT only ---
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

    const payload = await verifyWorkOSToken(token);
    const userId = await provisionUserFromWorkOS(payload);

    // --- Fetch user's datasources across all team memberships ---
    const user = await findUser({ userId });

    if (!user.dataSources?.length) {
      return res.json({ datasources: [] });
    }

    res.json({ datasources: buildDiscoverResponse(user.dataSources) });
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
