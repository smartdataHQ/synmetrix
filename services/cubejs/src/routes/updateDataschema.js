import {
  commitVersionFiles,
  findVersionDataschemas,
} from "../utils/dataSourceHelpers.js";
import { resolveMutableDataschema } from "../utils/modelWriteGuards.js";
import { hasuraTokenForUser } from "../utils/mintHasuraToken.js";
import { mapHasuraErrorCode } from "../utils/mapHasuraErrorCode.js";
import { ErrorCode, respondError } from "../utils/errorCodes.js";

const dataschemaShape = (row) => ({
  id: row.id,
  name: row.name,
  checksum: row.checksum,
  version_id: row.version_id,
});

/**
 * PUT /api/v1/dataschema/:dataschemaId   body: `{code: string}`
 *
 * Save one file's new code as a NEW version on the dataschema's branch: every
 * file of the dataschema's (current) version is copied, this file's code is
 * replaced. The previous version stays intact and restorable. Same guards as
 * DELETE (auth, partition, owner/admin, current version of an active branch →
 * else 409). Identical code is a no-op: 200 with `unchanged: true`.
 *
 * Returns `{versionId, branchId, dataschema: {id, name, checksum, version_id}}`
 * where `dataschema.id` is the NEW row's id.
 */
export default async function updateDataschema(req, res) {
  const ctx = await resolveMutableDataschema(req, res, {
    action: "dataschema_update",
    codes: {
      invalidRequest: "update_invalid_request",
      authorization: ErrorCode.UPDATE_BLOCKED_AUTHORIZATION,
      historical: ErrorCode.UPDATE_BLOCKED_HISTORICAL_VERSION,
    },
  });
  if (!ctx) return;
  const {
    payload,
    userId,
    dataschemaId,
    target,
    versionId,
    branchId,
    datasourceId,
    audit,
  } = ctx;

  const code = req.body?.code;
  if (typeof code !== "string") {
    return respondError(
      res,
      400,
      "update_invalid_request",
      "Body must be {code: string}"
    );
  }

  if (code === target.code) {
    return res.json({
      versionId,
      branchId,
      dataschema: dataschemaShape(target),
      unchanged: true,
    });
  }

  let files;
  try {
    files = (await findVersionDataschemas({ versionId })).map((row) =>
      row.id === dataschemaId ? { ...row, code } : row
    );
  } catch (err) {
    return respondError(
      res,
      503,
      "hasura_unavailable",
      err?.message || "Hasura unavailable"
    );
  }

  let hasuraToken;
  try {
    hasuraToken = await hasuraTokenForUser(userId);
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
    result = await commitVersionFiles({
      branchId,
      userId,
      datasourceId,
      files,
      authToken: hasuraToken,
      // `Model Saved`, emitted by commitVersionFiles like every other save.
      emit: {
        accountId: payload?.accountId ?? null,
        partition: payload?.partition ?? null,
        userId,
      },
    });
  } catch (err) {
    return respondError(
      res,
      503,
      "hasura_unavailable",
      err?.message || "Hasura unavailable"
    );
  }

  if (result.errors) {
    const mapped = mapHasuraErrorCode(result.errors, { action: "update" });
    if (mapped === ErrorCode.UPDATE_BLOCKED_AUTHORIZATION) {
      await audit("failure", mapped, {
        hasura_code: result.errors?.[0]?.extensions?.code || null,
      });
      return respondError(
        res,
        403,
        mapped,
        "Hasura rejected the update (permission-error)"
      );
    }
    await audit("failure", "hasura_rejected", { errors: result.errors });
    return respondError(
      res,
      503,
      "hasura_unavailable",
      "Hasura rejected the update"
    );
  }

  const saved = result.dataschemas.find((row) => row.name === target.name);

  await audit("success", null, {
    name: target.name,
    version_id: versionId,
    new_version_id: result.newVersionId,
    new_dataschema_id: saved?.id ?? null,
    checksum: saved?.checksum ?? null,
  });

  return res.json({
    versionId: result.newVersionId,
    branchId,
    dataschema: saved
      ? dataschemaShape(saved)
      : { id: null, name: target.name, checksum: null, version_id: result.newVersionId },
  });
}
