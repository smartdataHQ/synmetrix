import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const fetchGraphQLMock = mock.fn();
mock.module("../graphql.js", {
  namedExports: { fetchGraphQL: fetchGraphQLMock },
});

const { commitVersionFiles, rollbackVersion } = await import(
  "../dataSourceHelpers.js"
);

const DS = "ds-1";
const BRANCH = "branch-1";

describe("commitVersionFiles / rollbackVersion", () => {
  beforeEach(() => fetchGraphQLMock.mock.resetCalls());

  it("inserts a new version with the caller token and returns the new rows", async () => {
    fetchGraphQLMock.mock.mockImplementation(async () => ({
      data: {
        insert_versions_one: {
          id: "v-new",
          dataschemas: [{ id: "d-new", name: "a.yml", checksum: "c", version_id: "v-new" }],
        },
      },
    }));
    const res = await commitVersionFiles({
      branchId: BRANCH,
      userId: "u-1",
      datasourceId: DS,
      files: [{ id: "d-old", name: "a.yml", code: "cubes: []", checksum: "x" }],
      authToken: "tok",
    });
    assert.deepEqual(res, {
      newVersionId: "v-new",
      dataschemas: [{ id: "d-new", name: "a.yml", checksum: "c", version_id: "v-new" }],
    });
    const [, vars, token, opts] = fetchGraphQLMock.mock.calls[0].arguments;
    assert.equal(token, "tok");
    assert.deepEqual(opts, { preserveErrors: true });
    assert.equal(vars.object.origin, "user");
    assert.equal("source_version_id" in vars.object, false);
    // Only insertable columns — never the source row's id/checksum.
    assert.deepEqual(vars.object.dataschemas.data, [
      { name: "a.yml", code: "cubes: []", user_id: "u-1", datasource_id: DS },
    ]);
  });

  it("passes Hasura errors through for mapping", async () => {
    const errors = [{ extensions: { code: "permission-error" } }];
    fetchGraphQLMock.mock.mockImplementation(async () => ({ data: null, errors }));
    const res = await commitVersionFiles({
      branchId: BRANCH,
      userId: "u-1",
      datasourceId: DS,
      files: [],
      authToken: "tok",
    });
    assert.deepEqual(res, { errors });
  });

  it("rollback records origin=rollback and the restored version as source", async () => {
    fetchGraphQLMock.mock.mockImplementation(async (query) =>
      query.includes("VersionDataschemas")
        ? { data: { dataschemas: [{ id: "d-1", name: "a.yml", code: "x" }] } }
        : { data: { insert_versions_one: { id: "v-new", dataschemas: [] } } }
    );
    const res = await rollbackVersion({
      branchId: BRANCH,
      toVersionId: "v-old",
      userId: "u-1",
      datasourceId: DS,
      authToken: "tok",
    });
    assert.deepEqual(res, { newVersionId: "v-new", clonedDataschemaCount: 1 });
    const insert = fetchGraphQLMock.mock.calls[1].arguments[1].object;
    assert.equal(insert.origin, "rollback");
    assert.equal(insert.source_version_id, "v-old");
  });
});
