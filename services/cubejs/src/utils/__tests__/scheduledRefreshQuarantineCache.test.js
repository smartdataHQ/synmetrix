import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

const UNSAFE = `cubes:
  - name: events
    sql: >
      SELECT * FROM t WHERE {FILTER_PARAMS.events.partition.filter((c) => c)}
`;
const SAFE = `cubes:
  - name: orders
    sql: SELECT * FROM orders
`;

const dataSource = (id, versionId) => ({
  id,
  db_type: "clickhouse",
  db_params: { host: "database.invalid" },
  branches: [{ versions: [{ id: versionId, dataschemas: [{ id: `${versionId}-m`, name: "m.yml" }] }] }],
});

describe("scheduled refresh quarantine cache", () => {
  it("reads model code once per version, not every interval", async () => {
    let dataSources = [dataSource("ds-a", "v1"), dataSource("ds-b", "v2")];
    const code = { v1: UNSAFE, v2: SAFE, v3: SAFE };
    const getVersionModelCode = mock.fn(async (versionId) => [{ code: code[versionId] }]);
    mock.module("../dataSourceHelpers.js", {
      namedExports: { getDataSources: async () => dataSources, getVersionModelCode },
    });
    const { default: scheduledRefreshContexts } = await import("../scheduledRefreshContexts.js");
    const ids = (contexts) => contexts.map((c) => c.securityContext.userScope.dataSource.dataSourceId);

    assert.deepEqual(ids(await scheduledRefreshContexts()), ["ds-b"]);
    assert.deepEqual(ids(await scheduledRefreshContexts()), ["ds-b"]);
    assert.equal(getVersionModelCode.mock.callCount(), 2);

    // ds-a publishes a fixed version: only the new version is read.
    dataSources = [dataSource("ds-a", "v3"), dataSource("ds-b", "v2")];
    assert.deepEqual(ids(await scheduledRefreshContexts()), ["ds-a", "ds-b"]);
    assert.deepEqual(getVersionModelCode.mock.calls.map((c) => c.arguments[0]), ["v1", "v2", "v3"]);
  });
});
