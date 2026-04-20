import YAML from "yaml";

import { verifyAndProvision } from "../utils/directVerifyAuth.js";
import { findUser } from "../utils/dataSourceHelpers.js";
import { fetchGraphQL } from "../utils/graphql.js";
import { mintHasuraToken } from "../utils/mintHasuraToken.js";
import { mintedTokenCache } from "../utils/mintedTokenCache.js";
import { requireOwnerOrAdmin } from "../utils/requireOwnerOrAdmin.js";
import { resolvePartitionTeamIds } from "./discover.js";
import { scanCrossCubeReferences } from "../utils/referenceScanner.js";
import { writeAuditLog } from "../utils/auditWriter.js";
import { mapHasuraErrorCode } from "../utils/mapHasuraErrorCode.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { parseCubesFromJs } from "../utils/smart-generation/diffModels.js";

const RESOLVE_TARGET_QUERY = `
  query ResolveTargetDataschema($id: uuid!) {
    dataschemas_by_pk(id: $id) {
      id
      name
      code
      version_id
      version {
        id
        is_current
        branch {
          id
          status
          datasource {
            id
            team_id
          }
        }
      }
    }
  }
`;

const SIBLINGS_QUERY = `
  query Siblings($versionId: uuid!, $excludeId: uuid!) {
    dataschemas(
      where: {
        version_id: {_eq: $versionId}
        id: {_neq: $excludeId}
      }
    ) {
      id
      name
      code
    }
  }
`;

const DELETE_MUTATION = `
  mutation DeleteDataschema($id: uuid!) {
    delete_dataschemas_by_pk(id: $id) {
      id
    }
  }
`;

function parseCubes(name, code) {
  if (!code) return [];
  const isYaml = name?.endsWith(".yml") || name?.endsWith(".yaml");
  try {
    if (isYaml) {
      const parsed = YAML.parse(code);
      return Array.isArray(parsed?.cubes) ? parsed.cubes : [];
    }
    const cubes = parseCubesFromJs(code);
    return Array.isArray(cubes) ? cubes : [];
  } catch {
    return [];
  }
}

async function ensureHasuraTokenForUser(userId) {
  let tok = mintedTokenCache.get(userId);
  if (tok) return tok;
  tok = await mintHasuraToken(userId);
  const decoded = JSON.parse(
    Buffer.from(tok.split(".")[1], "base64url").toString()
  );
  mintedTokenCache.set(userId, tok, decoded.exp);
  return tok;
}

function respondError(res, status, code, message, extra = {}) {
  return res.status(status).json({ code, message, ...extra });
}

/**
 * DELETE /api/v1/dataschema/:dataschemaId
 *
 * Remove a dataschema row from the currently-active version of its branch.
 * Enforces, in order:
 *   - authentication (FR-015 direct-verify)
 *   - partition gate (FR-015)
 *   - owner/admin role on the datasource's team (FR-015)
 *   - version-level immutability via `is_current=true` + `branch.status=active` (FR-007)
 *   - cross-cube reference scan (FR-008, seven kinds)
 *
 * Every rejection path emits a durable audit row with `outcome='failure'` via
 * `writeAuditLog` (FR-016). Successful deletes are captured by the
 * `delete_dataschema_audit` Hasura event trigger.
 */
export default async function deleteDataschema(req, res) {
  const verified = await verifyAndProvision(req);
  if (verified.error) {
    return respondError(
      res,
      verified.error.status,
      verified.error.code,
      verified.error.message
    );
  }
  const { payload, userId } = verified;

  const dataschemaId = req.params?.dataschemaId;
  if (!dataschemaId || typeof dataschemaId !== "string") {
    return respondError(
      res,
      400,
      "delete_invalid_request",
      "dataschemaId path parameter is required"
    );
  }

  // Resolve the target via admin-secret GraphQL (handler owns enforcement).
  let targetRow;
  try {
    const r = await fetchGraphQL(RESOLVE_TARGET_QUERY, { id: dataschemaId });
    targetRow = r?.data?.dataschemas_by_pk;
  } catch (err) {
    return respondError(
      res,
      503,
      "hasura_unavailable",
      err?.message || "Hasura unavailable"
    );
  }

  if (!targetRow) {
    return respondError(
      res,
      404,
      ErrorCode.VALIDATE_TARGET_NOT_FOUND,
      "Dataschema not found"
    );
  }

  const version = targetRow.version;
  const branch = version?.branch;
  const datasource = branch?.datasource;
  const teamId = datasource?.team_id;
  const datasourceId = datasource?.id;
  const branchId = branch?.id;

  const user = await findUser({ userId });

  // Partition gate.
  const partitionTeamIds = resolvePartitionTeamIds(
    user.members,
    payload.partition
  );
  if (partitionTeamIds && !partitionTeamIds.has(teamId)) {
    await writeAuditLog({
      action: "dataschema_delete",
      userId,
      datasourceId,
      branchId,
      targetId: dataschemaId,
      outcome: "failure",
      errorCode: ErrorCode.DELETE_BLOCKED_AUTHORIZATION,
      payload: { reason: "partition_mismatch" },
    });
    return respondError(
      res,
      403,
      ErrorCode.DELETE_BLOCKED_AUTHORIZATION,
      "Caller's partition does not match the datasource's team"
    );
  }

  // Owner/admin gate.
  if (!requireOwnerOrAdmin(user, teamId)) {
    await writeAuditLog({
      action: "dataschema_delete",
      userId,
      datasourceId,
      branchId,
      targetId: dataschemaId,
      outcome: "failure",
      errorCode: ErrorCode.DELETE_BLOCKED_AUTHORIZATION,
      payload: { reason: "insufficient_role" },
    });
    return respondError(
      res,
      403,
      ErrorCode.DELETE_BLOCKED_AUTHORIZATION,
      "Owner or admin role required"
    );
  }

  // Version-level immutability (FR-007): only the current version of the
  // active branch may be edited.
  if (version?.is_current !== true || branch?.status !== "active") {
    await writeAuditLog({
      action: "dataschema_delete",
      userId,
      datasourceId,
      branchId,
      targetId: dataschemaId,
      outcome: "failure",
      errorCode: ErrorCode.DELETE_BLOCKED_HISTORICAL_VERSION,
      payload: {
        is_current: version?.is_current ?? null,
        branch_status: branch?.status ?? null,
      },
    });
    return respondError(
      res,
      409,
      ErrorCode.DELETE_BLOCKED_HISTORICAL_VERSION,
      "Dataschema is attached to a historical version — only the current version of the active branch is mutable"
    );
  }

  // Cross-cube reference scan (FR-008).
  let siblings;
  try {
    const r = await fetchGraphQL(SIBLINGS_QUERY, {
      versionId: version.id,
      excludeId: dataschemaId,
    });
    siblings = r?.data?.dataschemas || [];
  } catch (err) {
    return respondError(
      res,
      503,
      "hasura_unavailable",
      err?.message || "Hasura unavailable"
    );
  }

  const targetCubeNames = parseCubes(targetRow.name, targetRow.code).map(
    (c) => c.name
  );
  const otherCubes = siblings.flatMap((row) =>
    parseCubes(row.name, row.code).map((c) => ({
      cubeName: c.name,
      fileName: row.name,
      code: row.code,
    }))
  );

  const blockingReferences = [];
  for (const name of targetCubeNames) {
    for (const ref of scanCrossCubeReferences(name, otherCubes)) {
      blockingReferences.push(ref);
    }
  }

  if (blockingReferences.length > 0) {
    await writeAuditLog({
      action: "dataschema_delete",
      userId,
      datasourceId,
      branchId,
      targetId: dataschemaId,
      outcome: "failure",
      errorCode: ErrorCode.DELETE_BLOCKED_BY_REFERENCES,
      payload: { blockingReferences },
    });
    return respondError(
      res,
      409,
      ErrorCode.DELETE_BLOCKED_BY_REFERENCES,
      "Cube is referenced by another cube on the same branch",
      { blockingReferences }
    );
  }

  // Fire the actual delete with the caller's minted Hasura token so the
  // user-role delete_permissions filter applies at the DB layer too (two-layer
  // defence per research R4).
  let hasuraToken;
  try {
    hasuraToken = await ensureHasuraTokenForUser(userId);
  } catch {
    return respondError(
      res,
      503,
      "auth_unavailable",
      "Unable to mint Hasura token"
    );
  }

  let del;
  try {
    del = await fetchGraphQL(
      DELETE_MUTATION,
      { id: dataschemaId },
      hasuraToken,
      { preserveErrors: true }
    );
  } catch (err) {
    return respondError(
      res,
      503,
      "hasura_unavailable",
      err?.message || "Hasura unavailable"
    );
  }

  if (del?.errors) {
    const mapped = mapHasuraErrorCode(del.errors, { action: "delete" });
    if (mapped === ErrorCode.DELETE_BLOCKED_AUTHORIZATION) {
      await writeAuditLog({
        action: "dataschema_delete",
        userId,
        datasourceId,
        branchId,
        targetId: dataschemaId,
        outcome: "failure",
        errorCode: mapped,
        payload: { hasura_code: del.errors?.[0]?.extensions?.code || null },
      });
      return respondError(
        res,
        403,
        mapped,
        "Hasura rejected the delete (permission-error)"
      );
    }
    await writeAuditLog({
      action: "dataschema_delete",
      userId,
      datasourceId,
      branchId,
      targetId: dataschemaId,
      outcome: "failure",
      errorCode: "hasura_rejected",
      payload: { errors: del.errors },
    });
    return respondError(
      res,
      503,
      "hasura_unavailable",
      "Hasura rejected the delete"
    );
  }

  if (!del?.data?.delete_dataschemas_by_pk?.id) {
    // Row vanished concurrently — treat as not-found and audit for visibility.
    await writeAuditLog({
      action: "dataschema_delete",
      userId,
      datasourceId,
      branchId,
      targetId: dataschemaId,
      outcome: "failure",
      errorCode: ErrorCode.VALIDATE_TARGET_NOT_FOUND,
      payload: { reason: "row_not_found_at_delete" },
    });
    return respondError(
      res,
      404,
      ErrorCode.VALIDATE_TARGET_NOT_FOUND,
      "Dataschema not found at delete time"
    );
  }

  // Success path: the Hasura delete event trigger `delete_dataschema_audit`
  // writes the outcome='success' audit row. Handler does not duplicate.
  return res.json({ deleted: true, dataschemaId });
}
