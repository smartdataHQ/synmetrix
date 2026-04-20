import { findUser } from "../utils/dataSourceHelpers.js";
import { compileMetaForBranch } from "../utils/metaForBranch.js";
import { ErrorCode } from "../utils/errorCodes.js";

/**
 * GET /api/v1/meta/cube/:cubeName
 *
 * Return the compiled metadata envelope for a single cube on the requested
 * branch. Runs behind `checkAuthMiddleware`, so `req.securityContext` and
 * the `x-hasura-datasource-id` header are already validated.
 *
 * The resolved branch is the caller's selection (`x-hasura-branch-id`, or
 * the active branch) and the endpoint always compiles the latest version of
 * that branch (FR-009 + spec Assumption L172).
 *
 * Respects the access-list visibility filter applied by
 * `apiGateway.filterVisibleItemsInMeta` (FR-010). If the caller's access
 * list hides the cube, the response is a clean 404 with `code:
 * cube_not_found`.
 */
export default async function metaSingleCube(req, res, cubejs) {
  const cubeName = req.params?.cubeName;
  if (!cubeName || typeof cubeName !== "string") {
    return res.status(400).json({
      code: "cube_not_found",
      message: "cubeName path parameter is required",
    });
  }

  const { authToken, userId, userScope } = req.securityContext || {};
  if (!userScope?.dataSource) {
    return res.status(400).json({
      code: "cube_not_found",
      message: "userScope not established",
    });
  }

  const datasourceId = userScope.dataSource.dataSourceId;
  const branchHeader = req.headers["x-hasura-branch-id"] || undefined;

  const user = await findUser({ userId });
  const dataSource = user.dataSources.find((ds) => ds.id === datasourceId);
  if (!dataSource) {
    return res.status(404).json({
      code: ErrorCode.CUBE_NOT_FOUND,
      message: "Datasource not visible",
    });
  }

  const apiGateway = cubejs.apiGateway();
  let metaConfig;
  let resolvedBranchId;
  let resolvedVersionId;
  try {
    const result = await compileMetaForBranch({
      apiGateway,
      req,
      userId,
      authToken,
      dataSource,
      branchId: branchHeader,
      allMembers: user.members,
    });
    metaConfig = result.metaConfig;
    resolvedBranchId = result.branchId;
    resolvedVersionId = result.versionId;
  } catch (err) {
    const status = err?.status || 500;
    if (status === 404) {
      return res.status(404).json({
        code: ErrorCode.CUBE_NOT_FOUND,
        message: err?.message || "Branch not found",
      });
    }
    return res.status(status).json({
      code: ErrorCode.CUBE_NOT_FOUND,
      message: err?.message || "Failed to compile branch metadata",
    });
  }

  const match = (metaConfig || []).find((entry) => {
    const node = entry?.config || entry || {};
    return node?.name === cubeName;
  });

  if (!match) {
    return res.status(404).json({
      code: ErrorCode.CUBE_NOT_FOUND,
      message: `Cube "${cubeName}" not found on the requested branch`,
      branchId: resolvedBranchId,
    });
  }

  const node = match?.config || match || {};
  return res.json({
    cube: {
      name: node.name,
      title: node.title || null,
      description: node.description || null,
      public: node.public !== false,
      measures: node.measures || [],
      dimensions: node.dimensions || [],
      segments: node.segments || [],
      hierarchies: node.hierarchies || undefined,
      meta: node.meta || null,
    },
    datasourceId,
    branchId: resolvedBranchId,
    versionId: resolvedVersionId,
  });
}
