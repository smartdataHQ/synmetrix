import { randomUUID } from "crypto";

import {
  detectTokenType,
  verifyWorkOSToken,
  verifyFraiOSToken,
} from "../utils/workosAuth.js";
import {
  findUser,
  provisionUserFromWorkOS,
  provisionUserFromFraiOS,
} from "../utils/dataSourceHelpers.js";
import { compileMetaForBranch } from "../utils/metaForBranch.js";
import { extractCubes, resolvePartitionTeamIds } from "./discover.js";

function getRequestId(req) {
  return (
    req.get?.("x-request-id") ||
    req.get?.("traceparent") ||
    `${randomUUID()}-span-1`
  );
}

/**
 * Summarize one compiled cube for the aggregate catalog response.
 *
 * `dataschemaByCubeName` maps each defined cube name to its source
 * dataschema row `{id, name}` (the `name` column stores the file name).
 * Cube.js v1.6's `metaConfig` does NOT carry `fileName`, so the lookup is by
 * cube name rather than file name.
 *
 * Cubes without a matching dataschema (synthetic / injected cubes) receive
 * `null` for both `dataschema_id` and `file_name`.
 */
function summarizeCube(cube, ds, branchId, versionId, dataschemaByCubeName) {
  const node = cube?.config || cube || {};
  const cubeName = node.name;
  const match =
    cubeName && dataschemaByCubeName
      ? dataschemaByCubeName.get(cubeName) || null
      : null;
  const dataschemaId = match?.id || null;
  const fileName = match?.name || null;
  return {
    datasource_id: ds.id,
    datasource_name: ds.name,
    db_type: ds.db_type,
    team_id: ds.team_id,
    branch_id: branchId,
    version_id: versionId,
    name: node.name,
    title: node.title || null,
    description: node.description || null,
    public: node.public !== false,
    measures: (node.measures || []).map((m) => m.name),
    dimensions: (node.dimensions || []).map((d) => d.name),
    segments: (node.segments || []).map((s) => s.name),
    meta: node.meta || null,
    dataschema_id: dataschemaId,
    file_name: fileName,
  };
}

async function metaForDatasource(
  apiGateway,
  req,
  userId,
  authToken,
  ds,
  allMembers
) {
  const activeBranch =
    ds.branches?.find((b) => b.status === "active") || ds.branches?.[0];
  if (!activeBranch) {
    throw Object.assign(new Error("no active branch"), { status: 400 });
  }
  const latestVersion = activeBranch.versions?.[0] || null;

  // Map cube-name → dataschema row. Cube.js metaConfig output omits file
  // provenance, so resolve via the source YAML/JS of each dataschema
  // (spec Assumption L171).
  const dataschemaByCubeName = new Map();
  for (const schema of latestVersion?.dataschemas || []) {
    if (!schema?.id) continue;
    const declared = extractCubes(schema);
    for (const decl of declared) {
      if (decl?.name) {
        dataschemaByCubeName.set(decl.name, {
          id: schema.id,
          name: schema.name,
        });
      }
    }
  }

  const { metaConfig } = await compileMetaForBranch({
    apiGateway,
    req,
    userId,
    authToken,
    dataSource: ds,
    branchId: activeBranch.id,
    versionId: latestVersion?.id,
    allMembers,
    requestId: getRequestId(req),
  });

  const cubes = (metaConfig || []).map((entry) =>
    summarizeCube(
      entry,
      ds,
      activeBranch.id,
      latestVersion?.id || null,
      dataschemaByCubeName
    )
  );

  return {
    datasource_id: ds.id,
    datasource_name: ds.name,
    db_type: ds.db_type,
    team_id: ds.team_id,
    branch_id: activeBranch.id,
    version_id: latestVersion?.id || null,
    cubes,
  };
}

/**
 * GET /api/v1/meta-all
 *
 * Aggregated cube catalog across every datasource the caller can see.
 * One request walks all partition-filtered datasources, resolves their
 * active branch + latest version, compiles each, and returns a summary
 * per cube (name, title, description, measures, dimensions, segments, meta,
 * `dataschema_id`, `file_name`).
 *
 * Auth: WorkOS RS256 or FraiOS HS256 Bearer token (same as /discover).
 *
 * Response:
 * {
 *   datasources: [
 *     {
 *       datasource_id, datasource_name, db_type, team_id,
 *       branch_id, version_id,
 *       cubes: [{ datasource_id, ..., name, title, description, public,
 *                 measures: string[], dimensions: string[], segments: string[],
 *                 meta: object | null,
 *                 dataschema_id: uuid | null,
 *                 file_name: string | null }]
 *     }
 *   ],
 *   errors?: [{ datasource_id, error }]
 * }
 */
export default async function metaAll(req, res, cubejs) {
  try {
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
    let payload;
    let userId;

    if (tokenType === "workos") {
      payload = await verifyWorkOSToken(token);
      userId = await provisionUserFromWorkOS(payload);
    } else if (tokenType === "fraios") {
      payload = await verifyFraiOSToken(token);
      userId = await provisionUserFromFraiOS(payload);
    } else {
      return res
        .status(403)
        .json({ error: "WorkOS or FraiOS token required" });
    }

    const user = await findUser({ userId });
    if (!user.dataSources?.length) {
      return res.json({ datasources: [] });
    }

    const partitionTeamIds = resolvePartitionTeamIds(
      user.members,
      payload.partition
    );
    const filtered = partitionTeamIds
      ? user.dataSources.filter((ds) => partitionTeamIds.has(ds.team_id))
      : user.dataSources;

    const apiGateway = cubejs.apiGateway();

    const settled = await Promise.allSettled(
      filtered.map((ds) =>
        metaForDatasource(apiGateway, req, userId, token, ds, user.members)
      )
    );

    const datasources = [];
    const errors = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        datasources.push(r.value);
      } else {
        errors.push({
          datasource_id: filtered[i].id,
          error: r.reason?.message || "unknown error",
        });
      }
    });

    const body = { datasources };
    if (errors.length) body.errors = errors;
    res.json(body);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      console.error("meta-all error:", err);
    }
    res.status(status).json({
      error: status >= 500 ? "Internal server error" : err.message,
    });
  }
}

// Exposed for unit testing and for validation contexts that need to assemble
// their own summaries.
export { summarizeCube, metaForDatasource };
