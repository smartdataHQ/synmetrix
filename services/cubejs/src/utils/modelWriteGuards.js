import { verifyAndProvision } from "./directVerifyAuth.js";
import { findUser } from "./dataSourceHelpers.js";
import { fetchGraphQL } from "./graphql.js";
import { requireOwnerOrAdmin } from "./requireOwnerOrAdmin.js";
import { resolvePartitionTeamIds } from "../routes/discover.js";
import { writeAuditLog } from "./auditWriter.js";
import { ErrorCode, respondError } from "./errorCodes.js";

const RESOLVE_TARGET_QUERY = `
  query ResolveTargetDataschema($id: uuid!) {
    dataschemas_by_pk(id: $id) {
      id
      name
      code
      checksum
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

/**
 * Partition gate + owner/admin gate shared by the Model-Management write
 * routes (FR-015). On refusal writes a failure audit row via `audit`,
 * responds 403 with `code`, and returns false.
 *
 * @param {import('express').Response} res
 * @param {{user: object, partition: string|null, teamId: string, code: string,
 *          audit: (outcome:string, errorCode:string, payload:object) => Promise<unknown>}} args
 * @returns {Promise<boolean>}
 */
export async function authorizeTeamWrite(res, { user, partition, teamId, code, audit }) {
  const partitionTeamIds = resolvePartitionTeamIds(user.members, partition);
  if (partitionTeamIds && !partitionTeamIds.has(teamId)) {
    await audit("failure", code, { reason: "partition_mismatch" });
    respondError(res, 403, code, "Caller's partition does not match the datasource's team");
    return false;
  }
  if (!requireOwnerOrAdmin(user, teamId)) {
    await audit("failure", code, { reason: "insufficient_role" });
    respondError(res, 403, code, "Owner or admin role required");
    return false;
  }
  return true;
}

/**
 * Shared guard for the single-dataschema write routes
 * (DELETE / PUT /api/v1/dataschema/:dataschemaId). Enforces, in order:
 *   - authentication (FR-015 direct-verify)
 *   - partition gate (FR-015)
 *   - owner/admin role on the datasource's team (FR-015)
 *   - the dataschema is on the current version of the active branch (FR-007)
 *
 * Every rejection after the target resolves writes a durable failure audit
 * row (FR-016). Returns `null` when a response has already been sent;
 * otherwise the resolved target plus an `audit(outcome, errorCode, payload)`
 * helper bound to this request.
 *
 * @param {{action: 'dataschema_delete'|'dataschema_update',
 *          codes: {invalidRequest:string, authorization:string, historical:string}}} opts
 */
export async function resolveMutableDataschema(req, res, { action, codes }) {
  const verified = await verifyAndProvision(req);
  if (verified.error) {
    respondError(
      res,
      verified.error.status,
      verified.error.code,
      verified.error.message
    );
    return null;
  }
  const { payload, userId } = verified;

  const dataschemaId = req.params?.dataschemaId;
  if (!dataschemaId || typeof dataschemaId !== "string") {
    respondError(
      res,
      400,
      codes.invalidRequest,
      "dataschemaId path parameter is required"
    );
    return null;
  }

  // Resolve the target via admin-secret GraphQL (handler owns enforcement).
  let target;
  try {
    const r = await fetchGraphQL(RESOLVE_TARGET_QUERY, { id: dataschemaId });
    target = r?.data?.dataschemas_by_pk;
  } catch (err) {
    respondError(
      res,
      503,
      "hasura_unavailable",
      err?.message || "Hasura unavailable"
    );
    return null;
  }

  if (!target) {
    respondError(
      res,
      404,
      ErrorCode.VALIDATE_TARGET_NOT_FOUND,
      "Dataschema not found"
    );
    return null;
  }

  const version = target.version;
  const branch = version?.branch;
  const teamId = branch?.datasource?.team_id;
  const datasourceId = branch?.datasource?.id;
  const branchId = branch?.id;

  const audit = (outcome, errorCode, auditPayload) =>
    writeAuditLog({
      action,
      userId,
      datasourceId,
      branchId,
      targetId: dataschemaId,
      outcome,
      errorCode,
      payload: auditPayload,
    });

  const user = await findUser({ userId });
  const allowed = await authorizeTeamWrite(res, {
    user,
    partition: payload.partition,
    teamId,
    code: codes.authorization,
    audit,
  });
  if (!allowed) return null;

  // Version-level immutability (FR-007): only the current version of the
  // active branch may be changed (by writing a new version on top of it).
  if (version?.is_current !== true || branch?.status !== "active") {
    await audit("failure", codes.historical, {
      is_current: version?.is_current ?? null,
      branch_status: branch?.status ?? null,
    });
    respondError(
      res,
      409,
      codes.historical,
      "Dataschema is attached to a historical version — only the current version of the active branch is mutable"
    );
    return null;
  }

  return {
    payload,
    userId,
    dataschemaId,
    target,
    versionId: version.id,
    branchId,
    datasourceId,
    audit,
  };
}
