import { verifyAndProvision } from "../utils/directVerifyAuth.js";
import { findUser } from "../utils/dataSourceHelpers.js";
import { resolvePartitionTeamIds } from "./discover.js";
import { requireOwnerOrAdmin } from "../utils/requireOwnerOrAdmin.js";
import defineUserScope from "../utils/defineUserScope.js";
import { invalidateCompilerForBranch } from "../utils/compilerCacheInvalidator.js";
import { ErrorCode } from "../utils/errorCodes.js";

function respondError(res, status, code, message) {
  return res.status(status).json({ code, message });
}

/**
 * POST /api/v1/internal/refresh-compiler
 *
 * Invalidate compiler-cache entries scoped to the caller's branch so that
 * subsequent metadata/query requests recompile from the current dataschemas
 * (FR-004). Asynchronous — the eviction happens in-memory, the response
 * returns as soon as keys are removed, recompilation happens on the next
 * downstream request (FR-004a). Idempotent per (branch, schemaVersion)
 * pair (FR-005).
 *
 * Owner/admin required (FR-015 + research.md §R14): refresh affects every
 * other caller sharing the branch, so it carries the same authorisation bar
 * as delete and rollback.
 *
 * Direct-verify auth — handler owns JWT verification; no
 * x-hasura-datasource-id header required.
 */
export default async function refreshCompiler(req, res, cubejs) {
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

  const { branchId } = req.body || {};
  if (!branchId || typeof branchId !== "string") {
    return respondError(
      res,
      400,
      "refresh_invalid_request",
      "branchId is required"
    );
  }

  const user = await findUser({ userId });
  if (!user?.dataSources?.length) {
    return respondError(
      res,
      404,
      ErrorCode.REFRESH_BRANCH_NOT_VISIBLE,
      "No datasources visible to this caller"
    );
  }

  const dataSource = user.dataSources.find((ds) =>
    (ds.branches || []).some((b) => b.id === branchId)
  );
  if (!dataSource) {
    return respondError(
      res,
      404,
      ErrorCode.REFRESH_BRANCH_NOT_VISIBLE,
      "Branch not found or not visible to this caller"
    );
  }

  const partitionTeamIds = resolvePartitionTeamIds(
    user.members,
    payload.partition
  );
  if (partitionTeamIds && !partitionTeamIds.has(dataSource.team_id)) {
    return respondError(
      res,
      403,
      ErrorCode.REFRESH_UNAUTHORIZED,
      "Caller's partition does not match the branch's team"
    );
  }

  if (!requireOwnerOrAdmin(user, dataSource.team_id)) {
    return respondError(
      res,
      403,
      ErrorCode.REFRESH_UNAUTHORIZED,
      "Owner or admin role required for refresh"
    );
  }

  let schemaVersion;
  try {
    const scope = defineUserScope(
      user.dataSources,
      user.members,
      dataSource.id,
      branchId,
      undefined
    );
    schemaVersion = scope?.dataSource?.schemaVersion;
  } catch (err) {
    const status = err?.status || 500;
    return respondError(
      res,
      status,
      ErrorCode.REFRESH_BRANCH_NOT_VISIBLE,
      err?.message || "Unable to resolve branch scope"
    );
  }

  const evicted = invalidateCompilerForBranch(cubejs, schemaVersion);

  // Non-durable observability log (FR-004 refresh is NOT a persistent mutation
  // and does not produce an audit_logs row — SC-007 scope is delete + rollback).
  console.log(
    JSON.stringify({
      level: "info",
      action: "refresh_compiler",
      userId,
      branchId,
      evicted,
      schemaVersion,
      ts: new Date().toISOString(),
    })
  );

  return res.json({ evicted, schemaVersion });
}
