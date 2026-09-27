import YAML from "yaml";

import { emitModelEvent } from "../utils/eventEmitter.js";
import {
  commitVersionFiles,
  findVersionDataschemas,
} from "../utils/dataSourceHelpers.js";
import {
  ensureHasuraTokenForUser,
  resolveMutableDataschema,
  respondError,
} from "../utils/mutableDataschema.js";
import { scanCrossCubeReferences } from "../utils/referenceScanner.js";
import { mapHasuraErrorCode } from "../utils/mapHasuraErrorCode.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { parseCubesFromJs } from "../utils/smart-generation/diffModels.js";

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

/**
 * DELETE /api/v1/dataschema/:dataschemaId
 *
 * Remove a dataschema from the current version of its branch by writing a NEW
 * version holding every other file of that version — the version the file
 * was deleted from stays intact, so the delete is restorable via rollback.
 * Enforces, in order:
 *   - authentication, partition, owner/admin, current version of the active
 *     branch (resolveMutableDataschema — FR-015 / FR-007)
 *   - cross-cube reference scan (FR-008, seven kinds)
 *
 * Every outcome writes a durable audit row via `writeAuditLog` (FR-016); the
 * `delete_dataschema_audit` event trigger no longer fires because no row is
 * deleted.
 */
export default async function deleteDataschema(req, res) {
  const ctx = await resolveMutableDataschema(req, res, {
    action: "dataschema_delete",
    codes: {
      invalidRequest: "delete_invalid_request",
      authorization: ErrorCode.DELETE_BLOCKED_AUTHORIZATION,
      historical: ErrorCode.DELETE_BLOCKED_HISTORICAL_VERSION,
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

  // Cross-cube reference scan (FR-008).
  let siblings;
  try {
    siblings = (await findVersionDataschemas({ versionId })).filter(
      (row) => row.id !== dataschemaId
    );
  } catch (err) {
    return respondError(
      res,
      503,
      "hasura_unavailable",
      err?.message || "Hasura unavailable"
    );
  }

  const targetCubeNames = parseCubes(target.name, target.code).map(
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
    await audit("failure", ErrorCode.DELETE_BLOCKED_BY_REFERENCES, {
      blockingReferences,
    });
    return respondError(
      res,
      409,
      ErrorCode.DELETE_BLOCKED_BY_REFERENCES,
      "Cube is referenced by another cube on the same branch",
      { blockingReferences }
    );
  }

  // Write the new version with the caller's minted Hasura token so the
  // user-role insert permissions apply at the DB layer too (two-layer
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

  let result;
  try {
    result = await commitVersionFiles({
      branchId,
      userId,
      datasourceId,
      files: siblings,
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

  if (result.errors) {
    const mapped = mapHasuraErrorCode(result.errors, { action: "delete" });
    if (mapped === ErrorCode.DELETE_BLOCKED_AUTHORIZATION) {
      await audit("failure", mapped, {
        hasura_code: result.errors?.[0]?.extensions?.code || null,
      });
      return respondError(
        res,
        403,
        mapped,
        "Hasura rejected the delete (permission-error)"
      );
    }
    await audit("failure", "hasura_rejected", { errors: result.errors });
    return respondError(
      res,
      503,
      "hasura_unavailable",
      "Hasura rejected the delete"
    );
  }

  await audit("success", null, {
    name: target.name,
    version_id: versionId,
    new_version_id: result.newVersionId,
  });

  // 099 T087 (FR-091): a successful delete is a model lifecycle fact.
  // Fire-and-forget; never blocks the response (FR-007).
  emitModelEvent({
    event: "Model Deleted",
    accountId: payload?.accountId ?? null,
    partition: payload?.partition ?? null,
    userId,
    modelId: dataschemaId,
    modelLabel: target.name || null,
    status: "ok",
    properties: {
      datasource_id: datasourceId,
      branch_id: branchId,
      version_id: versionId,
      new_version_id: result.newVersionId,
    },
  });

  return res.json({
    deleted: true,
    dataschemaId,
    versionId: result.newVersionId,
    branchId,
  });
}
