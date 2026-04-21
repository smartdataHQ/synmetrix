import { prepareCompiler } from "@cubejs-backend/schema-compiler";

import { verifyAndProvision } from "../utils/directVerifyAuth.js";
import {
  findUser,
  findDataSchemas,
} from "../utils/dataSourceHelpers.js";
import { fetchGraphQL } from "../utils/graphql.js";
import { mintHasuraToken } from "../utils/mintHasuraToken.js";
import { mintedTokenCache } from "../utils/mintedTokenCache.js";
import { requireOwnerOrAdmin } from "../utils/requireOwnerOrAdmin.js";
import { scanCrossCubeReferences } from "../utils/referenceScanner.js";
import { resolvePartitionTeamIds } from "./discover.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { extractCubes } from "./discover.js";

const BRANCH_DATASOURCE_QUERY = `
  query BranchDatasource($branchId: uuid!) {
    branches_by_pk(id: $branchId) {
      id
      status
      datasource {
        id
        team_id
      }
    }
  }
`;

class InMemorySchemaFileRepository {
  constructor(files) {
    this.files = files;
  }
  localPath() {
    return "/";
  }
  async dataSchemaFiles() {
    return this.files;
  }
}

function mapCompilerError(err, code) {
  const mapped = {
    severity: "error",
    message: err.plainMessage || err.message || String(err),
    fileName: err.fileName || null,
    startLine: err.lineNumber != null ? Number(err.lineNumber) : null,
    startColumn: err.position != null ? Number(err.position) : null,
    endLine: null,
    endColumn: null,
  };
  if (code) mapped.code = code;
  return mapped;
}

function mapSyntaxWarning(warn) {
  const loc = warn.loc || {};
  const start = loc.start || {};
  const end = loc.end || {};
  return {
    severity: "warning",
    message: warn.plainMessage || warn.message || String(warn),
    fileName: null,
    startLine: start.line != null ? Number(start.line) : null,
    startColumn: start.column != null ? Number(start.column) : null,
    endLine: end.line != null ? Number(end.line) : null,
    endColumn: end.column != null ? Number(end.column) : null,
  };
}

function badRequest(res, code, message) {
  return res.status(400).json({ code, message });
}

function respondJson(res, status, body) {
  return res.status(status).json(body);
}

async function ensureHasuraTokenForUser(userId) {
  let hasuraToken = mintedTokenCache.get(userId);
  if (hasuraToken) return hasuraToken;
  hasuraToken = await mintHasuraToken(userId);
  const parts = hasuraToken.split(".");
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString()
  );
  mintedTokenCache.set(userId, hasuraToken, payload.exp);
  return hasuraToken;
}

/**
 * POST /api/v1/validate-in-branch
 *
 * Validates a draft dataschema file against the branch's currently-deployed
 * cubes. Three modes (FR-002):
 *   - append         → add draft alongside deployed files
 *   - replace        → swap target dataschema's code with the draft
 *   - preview-delete → compile the branch without the target file
 *
 * Direct-verify auth (FR-015): team membership is sufficient for `append`;
 * `replace` and `preview-delete` require owner or admin on the datasource's
 * team (both modes signal intent to mutate).
 */
export default async function validateInBranch(req, res) {
  const verified = await verifyAndProvision(req);
  if (verified.error) {
    return respondJson(res, verified.error.status, {
      code: verified.error.code,
      message: verified.error.message,
    });
  }
  const { payload, userId } = verified;

  const body = req.body || {};
  const { branchId, mode, draft, targetDataschemaId } = body;

  if (!branchId || typeof branchId !== "string") {
    return badRequest(
      res,
      ErrorCode.VALIDATE_INVALID_MODE,
      "branchId is required"
    );
  }
  if (
    mode !== "append" &&
    mode !== "replace" &&
    mode !== "preview-delete"
  ) {
    return badRequest(
      res,
      ErrorCode.VALIDATE_INVALID_MODE,
      "mode must be append | replace | preview-delete"
    );
  }

  // Mode-conditional field validation.
  if (mode === "append") {
    if (!draft || typeof draft !== "object") {
      return badRequest(
        res,
        ErrorCode.VALIDATE_INVALID_MODE,
        "draft is required when mode is append"
      );
    }
    if (targetDataschemaId) {
      return badRequest(
        res,
        ErrorCode.VALIDATE_INVALID_MODE,
        "targetDataschemaId must not be set when mode is append"
      );
    }
  } else if (mode === "replace") {
    if (!draft || typeof draft !== "object") {
      return badRequest(
        res,
        ErrorCode.VALIDATE_INVALID_MODE,
        "draft is required when mode is replace"
      );
    }
    if (!targetDataschemaId) {
      return badRequest(
        res,
        ErrorCode.VALIDATE_INVALID_MODE,
        "targetDataschemaId is required when mode is replace"
      );
    }
  } else {
    // preview-delete
    if (draft) {
      return badRequest(
        res,
        ErrorCode.VALIDATE_INVALID_MODE,
        "draft must not be set when mode is preview-delete"
      );
    }
    if (!targetDataschemaId) {
      return badRequest(
        res,
        ErrorCode.VALIDATE_INVALID_MODE,
        "targetDataschemaId is required when mode is preview-delete"
      );
    }
  }

  // Resolve branch → datasource → team_id (handler runs before the GraphQL
  // user-role query because the minted Hasura token we need for findDataSchemas
  // gets authorized against the branch's existing permissions).
  let branchRow;
  try {
    const res1 = await fetchGraphQL(BRANCH_DATASOURCE_QUERY, { branchId });
    branchRow = res1?.data?.branches_by_pk;
  } catch (err) {
    return respondJson(res, 503, {
      code: "hasura_unavailable",
      message: err?.message || "Hasura unavailable",
    });
  }

  if (!branchRow) {
    return respondJson(res, 404, {
      code: ErrorCode.VALIDATE_TARGET_NOT_FOUND,
      message: "Branch not found",
    });
  }

  const teamId = branchRow.datasource?.team_id;
  const user = await findUser({ userId });

  // Partition gate (FR-015).
  const partitionTeamIds = resolvePartitionTeamIds(
    user.members,
    payload.partition
  );
  if (partitionTeamIds && !partitionTeamIds.has(teamId)) {
    return respondJson(res, 403, {
      code: ErrorCode.DELETE_BLOCKED_AUTHORIZATION,
      message: "Caller's partition does not match the branch's team",
    });
  }

  // Owner/admin gate for non-append modes.
  if (mode !== "append" && !requireOwnerOrAdmin(user, teamId)) {
    return respondJson(res, 403, {
      code: ErrorCode.DELETE_BLOCKED_AUTHORIZATION,
      message: "Owner or admin role required for replace / preview-delete",
    });
  }

  // Load existing dataschemas via a minted Hasura token (findDataSchemas uses
  // the user-role select permission).
  let existing;
  try {
    const hasuraToken = await ensureHasuraTokenForUser(userId);
    existing = await findDataSchemas({ branchId, authToken: hasuraToken });
  } catch (err) {
    return respondJson(res, 503, {
      code: "hasura_unavailable",
      message: err?.message || "Hasura unavailable",
    });
  }

  // Assemble the compile repository per mode.
  const files = [];
  let targetExisting = null;

  for (const row of existing) {
    if (mode === "replace" && row.id === targetDataschemaId) {
      targetExisting = row;
      files.push({ fileName: row.name, content: draft.content });
      continue;
    }
    if (mode === "preview-delete" && row.id === targetDataschemaId) {
      targetExisting = row;
      continue; // excluded from compile set
    }
    files.push({ fileName: row.name, content: row.code });
  }

  if (mode === "replace" && !targetExisting) {
    return respondJson(res, 404, {
      code: ErrorCode.VALIDATE_TARGET_NOT_FOUND,
      message: "targetDataschemaId is not attached to the specified branch",
    });
  }
  if (mode === "preview-delete" && !targetExisting) {
    return respondJson(res, 404, {
      code: ErrorCode.VALIDATE_TARGET_NOT_FOUND,
      message: "targetDataschemaId is not attached to the specified branch",
    });
  }

  if (mode === "append") {
    if (files.some((f) => f.fileName === draft.fileName)) {
      // File name collision — surface as compile error.
      return res.json({
        valid: false,
        errors: [
          {
            severity: "error",
            message: `A dataschema named "${draft.fileName}" already exists on this branch`,
            fileName: draft.fileName,
            startLine: null,
            startColumn: null,
            endLine: null,
            endColumn: null,
            code: ErrorCode.VALIDATE_INVALID_MODE,
          },
        ],
        warnings: [],
      });
    }
    files.push({ fileName: draft.fileName, content: draft.content });
  }

  // Compile.
  try {
    const repo = new InMemorySchemaFileRepository(files);
    const { compiler } = prepareCompiler(repo, {
      allowNodeRequire: false,
      standalone: true,
    });

    let compileError = null;
    try {
      await compiler.compile();
    } catch (err) {
      compileError = err;
    }

    const errorsReport = compiler.errorsReport;
    const rawErrors = errorsReport ? errorsReport.getErrors() : [];
    const rawWarnings = errorsReport ? errorsReport.getWarnings() : [];

    let errors;
    if (rawErrors.length > 0) {
      errors = rawErrors.map((e) =>
        mapCompilerError(e, ErrorCode.VALIDATE_UNRESOLVED_REFERENCE)
      );
    } else if (compileError) {
      errors = [
        {
          severity: "error",
          message: compileError.message || String(compileError),
          fileName: null,
          startLine: null,
          startColumn: null,
          endLine: null,
          endColumn: null,
          code: ErrorCode.VALIDATE_UNRESOLVED_REFERENCE,
        },
      ];
    } else {
      errors = [];
    }

    const warnings = rawWarnings.map(mapSyntaxWarning);
    const result = {
      valid: errors.length === 0,
      errors,
      warnings,
    };

    if (mode === "preview-delete" && result.valid === false) {
      // Attach a structured blockingReferences list for the caller so the
      // delete endpoint can consume it.
      const targetCubeNames = extractCubes(targetExisting).map((c) => c.name);
      const otherCubes = existing
        .filter((row) => row.id !== targetDataschemaId)
        .flatMap((row) =>
          extractCubes(row).map((c) => ({
            cubeName: c.name,
            fileName: row.name,
            code: row.code,
          }))
        );
      const hits = [];
      for (const targetName of targetCubeNames) {
        for (const ref of scanCrossCubeReferences(targetName, otherCubes)) {
          hits.push(ref);
        }
      }
      if (hits.length > 0) {
        result.blockingReferences = hits;
      }
    }

    return res.json(result);
  } catch (err) {
    return respondJson(res, 500, {
      code: "validate_error",
      message: err?.message || "Validation failed",
    });
  }
}
