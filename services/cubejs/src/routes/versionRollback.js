import { verifyAndProvision } from "../utils/directVerifyAuth.js";
import {
  findUser,
  findVersionBranch,
  rollbackVersion as rollbackHelper,
} from "../utils/dataSourceHelpers.js";
import { requireOwnerOrAdmin } from "../utils/requireOwnerOrAdmin.js";
import { resolvePartitionTeamIds } from "./discover.js";
import { writeAuditLog } from "../utils/auditWriter.js";
import { mapHasuraErrorCode } from "../utils/mapHasuraErrorCode.js";
import { mintHasuraToken } from "../utils/mintHasuraToken.js";
import { mintedTokenCache } from "../utils/mintedTokenCache.js";
import { ErrorCode } from "../utils/errorCodes.js";

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
 * POST /api/v1/version/rollback
 *
 * Body: `{branchId, toVersionId}`. Creates a new version on `branchId` whose
 * dataschemas are byte-identical clones of `toVersionId`'s dataschemas
 * (FR-013). The trigger `versions_flip_is_current_trg` switches the new row
 * to `is_current=true` atomically. Owner/admin required (FR-015).
 *
 * Every failure branch writes an audit row with `outcome='failure'`; success
 * is captured by the `version_rollback_audit` event trigger (FR-016).
 *
 * Note: source-column drift check (spec Edge Case L115) is not implemented
 * in this first cut — it requires a driver round-trip per cube, and the
 * insert's permission / constraint errors surface via the Hasura path.
 * This is tracked as a follow-up; handler intentionally returns the
 * Hasura-mapped failure code rather than silently succeeding.
 */
export default async function versionRollback(req, res, cubejs) {
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

  const { branchId, toVersionId } = req.body || {};
  if (!branchId || !toVersionId) {
    return respondError(
      res,
      400,
      ErrorCode.ROLLBACK_INVALID_REQUEST,
      "branchId and toVersionId are required"
    );
  }

  const meta = await findVersionBranch({ versionId: toVersionId });
  if (!meta) {
    return respondError(
      res,
      404,
      ErrorCode.ROLLBACK_VERSION_NOT_ON_BRANCH,
      "Target version not found"
    );
  }
  if (meta.branchId !== branchId) {
    await writeAuditLog({
      action: "version_rollback",
      userId,
      datasourceId: meta.datasourceId,
      branchId,
      targetId: toVersionId,
      outcome: "failure",
      errorCode: ErrorCode.ROLLBACK_VERSION_NOT_ON_BRANCH,
      payload: { resolvedBranchId: meta.branchId },
    });
    return respondError(
      res,
      400,
      ErrorCode.ROLLBACK_VERSION_NOT_ON_BRANCH,
      "toVersionId does not belong to the requested branch"
    );
  }

  const user = await findUser({ userId });
  const partitionTeamIds = resolvePartitionTeamIds(
    user.members,
    payload.partition
  );
  if (partitionTeamIds && !partitionTeamIds.has(meta.teamId)) {
    await writeAuditLog({
      action: "version_rollback",
      userId,
      datasourceId: meta.datasourceId,
      branchId,
      targetId: toVersionId,
      outcome: "failure",
      errorCode: ErrorCode.ROLLBACK_BLOCKED_AUTHORIZATION,
      payload: { reason: "partition_mismatch" },
    });
    return respondError(
      res,
      403,
      ErrorCode.ROLLBACK_BLOCKED_AUTHORIZATION,
      "Caller's partition does not match the branch's team"
    );
  }
  if (!requireOwnerOrAdmin(user, meta.teamId)) {
    await writeAuditLog({
      action: "version_rollback",
      userId,
      datasourceId: meta.datasourceId,
      branchId,
      targetId: toVersionId,
      outcome: "failure",
      errorCode: ErrorCode.ROLLBACK_BLOCKED_AUTHORIZATION,
      payload: { reason: "insufficient_role" },
    });
    return respondError(
      res,
      403,
      ErrorCode.ROLLBACK_BLOCKED_AUTHORIZATION,
      "Owner or admin role required"
    );
  }

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

  let result;
  try {
    result = await rollbackHelper({
      branchId,
      toVersionId,
      userId,
      datasourceId: meta.datasourceId,
      authToken: hasuraToken,
    });
  } catch (err) {
    return respondError(
      res,
      503,
      "hasura_unavailable",
      err?.message || "Hasura unavailable"
    );
  }

  if (result?.errors) {
    const mapped = mapHasuraErrorCode(result.errors, { action: "rollback" });
    const errorCode = mapped || "hasura_rejected";
    await writeAuditLog({
      action: "version_rollback",
      userId,
      datasourceId: meta.datasourceId,
      branchId,
      targetId: toVersionId,
      outcome: "failure",
      errorCode,
      payload: { errors: result.errors },
    });
    if (mapped === ErrorCode.ROLLBACK_BLOCKED_AUTHORIZATION) {
      return respondError(
        res,
        403,
        mapped,
        "Hasura rejected the rollback (permission-error)"
      );
    }
    return respondError(
      res,
      503,
      "hasura_unavailable",
      "Hasura rejected the rollback"
    );
  }

  return res.json({
    newVersionId: result.newVersionId,
    clonedDataschemaCount: result.clonedDataschemaCount,
  });
}
