import { verifyAndProvision } from "../utils/directVerifyAuth.js";
import {
  findUser,
  findVersionBranch,
  findVersionDataschemas,
} from "../utils/dataSourceHelpers.js";
import { resolvePartitionTeamIds } from "./discover.js";
import { diffVersions } from "../utils/versionDiff.js";
import { ErrorCode } from "../utils/errorCodes.js";

function respondError(res, status, code, message) {
  return res.status(status).json({ code, message });
}

/**
 * POST /api/v1/version/diff
 *
 * Body: `{fromVersionId, toVersionId}`. Both versions must belong to the same
 * branch (FR-012). Returns `VersionDiffResponse` per data-model.md §2.9.
 */
export default async function versionDiff(req, res) {
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

  const { fromVersionId, toVersionId } = req.body || {};
  if (!fromVersionId || !toVersionId) {
    return respondError(
      res,
      400,
      ErrorCode.DIFF_INVALID_REQUEST,
      "fromVersionId and toVersionId are required"
    );
  }
  if (fromVersionId === toVersionId) {
    return respondError(
      res,
      400,
      ErrorCode.DIFF_INVALID_REQUEST,
      "fromVersionId and toVersionId must differ"
    );
  }

  let fromMeta;
  let toMeta;
  try {
    [fromMeta, toMeta] = await Promise.all([
      findVersionBranch({ versionId: fromVersionId }),
      findVersionBranch({ versionId: toVersionId }),
    ]);
  } catch (err) {
    return respondError(
      res,
      503,
      "hasura_unavailable",
      err?.message || "Hasura unavailable"
    );
  }

  if (!fromMeta || !toMeta) {
    return respondError(
      res,
      404,
      ErrorCode.DIFF_INVALID_REQUEST,
      "One or both versions not found"
    );
  }

  if (fromMeta.branchId !== toMeta.branchId) {
    return respondError(
      res,
      400,
      ErrorCode.DIFF_CROSS_BRANCH,
      "Diff requires both versions on the same branch"
    );
  }

  const user = await findUser({ userId });
  const partitionTeamIds = resolvePartitionTeamIds(
    user.members,
    payload.partition
  );
  if (partitionTeamIds && !partitionTeamIds.has(toMeta.teamId)) {
    return respondError(
      res,
      403,
      ErrorCode.DIFF_INVALID_REQUEST,
      "Caller's partition does not match the branch's team"
    );
  }

  let fromRows;
  let toRows;
  try {
    [fromRows, toRows] = await Promise.all([
      findVersionDataschemas({ versionId: fromVersionId }),
      findVersionDataschemas({ versionId: toVersionId }),
    ]);
  } catch (err) {
    return respondError(
      res,
      503,
      "hasura_unavailable",
      err?.message || "Hasura unavailable"
    );
  }

  const diff = diffVersions({
    fromDataschemas: fromRows,
    toDataschemas: toRows,
  });

  return res.json({
    branchId: toMeta.branchId,
    fromVersionId,
    toVersionId,
    ...diff,
  });
}
