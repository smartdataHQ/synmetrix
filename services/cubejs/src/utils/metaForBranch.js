import defineUserScope from "./defineUserScope.js";

/**
 * compileMetaForBranch — load + compile the dataschemas of a chosen
 * (branch, version) pair and return the raw visibility-filtered metaConfig.
 *
 * This helper centralises the compilation path shared by:
 *   - /api/v1/meta-all       (aggregate catalog, which then summarizes)
 *   - /api/v1/meta/cube/:cubeName  (single-cube, which returns the raw envelope)
 *
 * The existing `metaForDatasource` inside routes/metaAll.js summarized each
 * cube down to `{measures:string[], dimensions:string[], segments:string[]}`,
 * and always picked `ds.branches.find(b => b.status === 'active')`. Neither
 * behaviour is appropriate for the single-cube route, which:
 *   - needs full member envelopes (so the agent can inspect sql/type/meta without
 *     a second round-trip), and
 *   - must honour an explicit `x-hasura-branch-id` header.
 *
 * Returns `{ branchId, versionId, metaConfig }` where `metaConfig` is the
 * array Cube.js emits from `compilerApi.metaConfig()` after
 * `apiGateway.filterVisibleItemsInMeta(context, …)`.
 *
 * @param {object} args
 * @param {object} args.apiGateway   - `cubejs.apiGateway()` instance
 * @param {import('express').Request} args.req
 * @param {string} args.userId
 * @param {string} args.authToken
 * @param {object} args.dataSource   - a single dataSource row (includes `.branches`)
 * @param {string} [args.branchId]   - optional; defaults to the datasource's active branch
 * @param {string} [args.versionId]  - optional; defaults to the branch's latest version
 * @param {Array<object>} args.allMembers - `user.members`, forwarded to defineUserScope
 * @param {string} [args.requestId]
 * @returns {Promise<{branchId:string, versionId:string|null, metaConfig:Array<object>}>}
 */
export async function compileMetaForBranch({
  apiGateway,
  req,
  userId,
  authToken,
  dataSource,
  branchId,
  versionId,
  allMembers,
  requestId,
}) {
  const branches = dataSource?.branches || [];
  const branch = branchId
    ? branches.find((b) => b.id === branchId)
    : branches.find((b) => b.status === "active") || branches[0];

  if (!branch) {
    const err = new Error("branch_not_found");
    err.status = 404;
    throw err;
  }

  const versions = branch.versions || [];
  const version = versionId
    ? versions.find((v) => v.id === versionId)
    : versions[0] || null;

  const userScope = defineUserScope(
    [dataSource],
    allMembers,
    dataSource.id,
    branch.id,
    version?.id
  );

  const securityContext = { authToken, userId, userScope };
  const context = await apiGateway.contextByReq(
    req,
    securityContext,
    requestId ||
      req?.get?.("x-request-id") ||
      req?.get?.("traceparent") ||
      `metaForBranch-${Date.now()}`
  );

  const compilerApi = await apiGateway.getCompilerApi(context);
  let metaConfig = await compilerApi.metaConfig(context, {
    requestId: context.requestId,
  });
  metaConfig = apiGateway.filterVisibleItemsInMeta(context, metaConfig) || [];

  return {
    branchId: branch.id,
    versionId: version?.id || null,
    metaConfig,
  };
}
