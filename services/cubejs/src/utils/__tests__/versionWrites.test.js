import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const fetchGraphQLMock = mock.fn();
mock.module("../graphql.js", {
  namedExports: { fetchGraphQL: fetchGraphQLMock },
});

const {
  authorizeModelWrite,
  commitVersionFiles,
  createDataSchema,
  invalidateUserCache,
  rollbackVersion,
} = await import("../dataSourceHelpers.js");

const TEAM = "team-1";
const DS = "ds-1";
const BRANCH = "branch-1";

function userQueryResult(teamRole) {
  return {
    data: {
      members: [
        {
          id: "m-1",
          team_id: TEAM,
          team: {
            name: "t",
            settings: {},
            datasources: [
              { id: DS, team_id: TEAM, branches: [{ id: BRANCH, versions: [] }] },
            ],
          },
          member_roles: [{ id: "r-1", team_role: teamRole }],
        },
      ],
    },
  };
}

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
    // origin left to the column default ('user')
    assert.equal("origin" in vars.object, false);
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

  it("createDataSchema keeps its contract on top of the shared insert", async () => {
    fetchGraphQLMock.mock.mockImplementation(async () => ({
      data: { insert_versions_one: { id: "v-new", dataschemas: [] } },
    }));
    const out = await createDataSchema({
      branch_id: BRANCH,
      user_id: "u-1",
      checksum: "caller-checksum",
      dataschemas: {
        data: [{ name: "a.yml", code: "x", user_id: "u-1", datasource_id: DS }],
      },
    });
    assert.deepEqual(out, { id: "v-new" });
    const [, vars, token] = fetchGraphQLMock.mock.calls[0].arguments;
    assert.equal(token, undefined); // admin secret, as before
    assert.equal(vars.object.checksum, "caller-checksum");
    assert.deepEqual(vars.object.dataschemas.data, [
      { name: "a.yml", code: "x", user_id: "u-1", datasource_id: DS },
    ]);

    fetchGraphQLMock.mock.mockImplementation(async () => ({
      data: null,
      errors: [{ message: "boom" }],
    }));
    await assert.rejects(
      createDataSchema({ branch_id: BRANCH, user_id: "u-1", checksum: "c", dataschemas: { data: [] } }),
      (err) => err.status === 503 && /boom/.test(err.message)
    );
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

describe("authorizeModelWrite", () => {
  beforeEach(() => {
    fetchGraphQLMock.mock.resetCalls();
    invalidateUserCache(null);
  });

  const as = (role) =>
    fetchGraphQLMock.mock.mockImplementation(async () => userQueryResult(role));

  it("refuses a branch that is not on the request's datasource", async () => {
    as("owner");
    const res = await authorizeModelWrite({
      userId: "u-1",
      dataSourceId: DS,
      branchId: "someone-elses-branch",
    });
    assert.equal(res.status, 404);
  });

  it("refuses a plain member's write but allows the member's dry run", async () => {
    as("member");
    const write = await authorizeModelWrite({ userId: "u-1", dataSourceId: DS, branchId: BRANCH });
    assert.equal(write.status, 403);
    const dry = await authorizeModelWrite({
      userId: "u-1",
      dataSourceId: DS,
      branchId: BRANCH,
      dryRun: true,
    });
    assert.equal(dry, null);
  });

  it("allows owners and admins (the row-type pipeline identity is admin)", async () => {
    for (const role of ["owner", "admin"]) {
      invalidateUserCache(null);
      as(role);
      assert.equal(
        await authorizeModelWrite({ userId: "u-1", dataSourceId: DS, branchId: BRANCH }),
        null
      );
    }
  });
});
