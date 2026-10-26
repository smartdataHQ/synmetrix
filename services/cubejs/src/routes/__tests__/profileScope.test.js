import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { profileRuleFilters } from "../../utils/profileRuleFilters.js";
import buildSecurityContext, {
  buildAuthorityRevision,
} from "../../utils/buildSecurityContext.js";
import createMd5Hex from "../../utils/md5Hex.js";

const route = readFileSync(
  new URL("../profileTable.js", import.meta.url),
  "utf8",
);
const rewrite = readFileSync(
  new URL("../../utils/queryRewrite.js", import.meta.url),
  "utf8",
);
const loaderStart = rewrite.indexOf("export async function loadRules(");
const loaderEnd = rewrite.indexOf("\n}", loaderStart) + 2;

describe("physical profile mandatory scope", () => {
  it("authority revisions isolate identity, policy and model without depending on the bearer token", () => {
    const context = {
      userId: "user",
      authToken: "first-token",
      tokenPayload: { accountId: "account", partition: "partition" },
      userScope: {
        dataSource: {
          dataSourceId: "source",
          dataSourceVersion: "connection-version",
          schemaVersion: "model-version",
          schemaRevisionComplete: true,
        },
        role: "member",
        hasAccessList: true,
        dataSourceAccessList: { Events: ["count"] },
        teamProperties: { partition: "partition" },
        memberProperties: { region: "region" },
      },
    };
    const rules = [{ id: "first", operator: "equals" }, { id: "second" }];
    const revision = buildAuthorityRevision(context, rules);
    assert.match(revision, /^[a-f0-9]{64}$/);
    assert.equal(
      buildAuthorityRevision({ ...context, authToken: "next-token" }, rules),
      revision,
    );
    assert.equal(
      buildAuthorityRevision(context, rules.slice().reverse()),
      revision,
    );
    const changes = [
      (copy) => {
        copy.userId = "other";
      },
      (copy) => {
        copy.tokenPayload.accountId = "other";
      },
      (copy) => {
        copy.userScope.dataSource.schemaVersion = "other";
      },
      (copy) => {
        copy.userScope.dataSource.dataSourceVersion = "other";
      },
      (copy) => {
        copy.userScope.role = "owner";
      },
      (copy) => {
        copy.userScope.memberProperties.region = "other";
      },
      (copy) => {
        copy.userScope.dataSourceAccessList = {};
      },
    ];
    for (const change of changes) {
      const copy = structuredClone(context);
      change(copy);
      assert.notEqual(buildAuthorityRevision(copy, rules), revision);
    }
    assert.notEqual(buildAuthorityRevision(context, []), revision);
    context.userScope.dataSource.schemaRevisionComplete = false;
    assert.equal(buildAuthorityRevision(context, rules), null);
  });

  it("model identity changes with content at the same file ID and matches the code-free projection", () => {
    const source = {
      id: "source",
      db_type: "clickhouse",
      db_params: { host: "localhost", port: 8123 },
    };
    const first = { id: "first", name: "first.yml", code: "first code" };
    const second = { id: "second", name: "second.yml", code: "second code" };
    const identify = (dataschemas) =>
      buildSecurityContext(source, { versions: [{ dataschemas }] });
    const baseline = identify([first, second]);
    assert.equal(
      identify([second, first]).schemaVersion,
      baseline.schemaVersion,
    );
    assert.notEqual(
      identify([{ ...first, code: "changed code" }, second]).schemaVersion,
      baseline.schemaVersion,
    );
    const projected = [first, second].map(({ id, name, code }) => ({
      id,
      name,
      checksum: createMd5Hex(`${name}-${code}`),
    }));
    assert.equal(identify(projected).schemaVersion, baseline.schemaVersion);
    assert.deepEqual(identify(projected).files, ["first", "second"]);
    assert.notEqual(
      identify([{ ...projected[0], checksum: "updated" }, projected[1]])
        .schemaVersion,
      baseline.schemaVersion,
    );
    assert.equal(typeof identify([{ id: "legacy" }]).schemaVersion, "string");
    assert.equal(identify([{ id: "legacy" }]).schemaRevisionComplete, false);
    assert.equal(identify(projected).schemaRevisionComplete, true);
  });

  it("only successful authenticated responses expose the server-owned revision", () => {
    const source = readFileSync(
      new URL("../index.js", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("  router.use(basePath,");
    const end = source.indexOf("  router.get(`${basePath}/v1/scope`", start);
    let middleware;
    runInNewContext(source.slice(start, end), {
      basePath: "/api",
      router: {
        use: (_path, handler) => {
          middleware = handler;
        },
      },
    });
    for (const [revision, status, path, expected] of [
      ["a".repeat(64), 200, "/v1/load", true],
      ["a".repeat(64), 200, "/v1/meta", true],
      ["a".repeat(64), 200, "/v1/scope", true],
      ["a".repeat(64), 200, "/v1/profile-table", false],
      ["a".repeat(64), 403, "/v1/load", false],
      [null, 200, "/v1/load", false],
    ]) {
      const headers = new Map();
      let sent;
      const response = {
        setHeader: (name, value) => headers.set(name, value),
        writeHead: (code) => {
          sent = code;
        },
      };
      middleware(
        { path, securityContext: { authorityRevision: revision } },
        response,
        () => {},
      );
      response.writeHead(status);
      assert.equal(sent, status);
      assert.equal(headers.has("x-synmetrix-authority-revision"), expected);
      if (expected) assert.equal(headers.get("Cache-Control"), "no-store");
    }
  });

  it("user scope observes membership changes in independent replicas and rejects partial reads", async () => {
    const source = readFileSync(
      new URL("../../utils/dataSourceHelpers.js", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export const findUser =");
    const end = source.indexOf("\n};", start) + 3;
    const datasource = { id: "source" };
    let response = {
      data: {
        members: [
          { team: { datasources: [datasource] } },
          { team: { datasources: [datasource] } },
        ],
      },
    };
    let reads = 0;
    const projections = [];
    const replicas = Array.from({ length: 2 }, () =>
      runInNewContext(
        source.slice(start, end).replace("export const", "const") +
          "\nfindUser;",
        {
          userQuery: "scope",
          fetchGraphQL: async (_query, variables) => {
            reads++;
            projections.push(variables.includeModelCode);
            return response;
          },
        },
      ),
    );
    for (const load of replicas) {
      const scope = await load({ userId: "user" });
      assert.equal(scope.dataSources.length, 1);
      assert.equal(scope.members.length, 2);
    }
    assert.deepEqual(projections, [true, true]);
    await replicas[0]({ userId: "user", includeModelCode: false });
    assert.equal(projections.at(-1), false);
    assert.match(source, /code @include\(if: \$includeModelCode\)/);
    response = { data: { members: [] } };
    for (const load of replicas) {
      const scope = await load({ userId: "user" });
      assert.equal(scope.dataSources.length, 0);
      assert.equal(scope.members.length, 0);
    }
    for (response of [
      undefined,
      { data: {} },
      { errors: [{ message: "partial" }], data: { members: [] } },
    ]) {
      for (const load of replicas) {
        await assert.rejects(
          load({ userId: "user" }),
          /scope could not be resolved/,
        );
      }
    }
    assert.equal(reads, 11);
  });

  it("model loading rejects failed or partial authority reads and permits confirmed empty input", async () => {
    const source = readFileSync(
      new URL("../../utils/dataSourceHelpers.js", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export const findDataSchemasByIds =");
    const end = source.indexOf("\n};", start) + 3;
    let response;
    let calls = 0;
    const load = runInNewContext(
      source.slice(start, end).replace("export const", "const") +
        "\nfindDataSchemasByIds;",
      {
        dataschemasQuery: "models",
        createHash,
        fetchGraphQL: async () => {
          calls++;
          return response;
        },
      },
    );
    assert.equal((await load({ ids: [] })).length, 0);
    assert.equal(calls, 0);
    for (const ids of [undefined, null, "file", [null], [""]]) {
      await assert.rejects(load({ ids }), /file IDs could not be resolved/);
    }
    for (response of [
      undefined,
      { data: {} },
      { data: { dataschemas: [] } },
      { data: { dataschemas: [{ id: "first" }] } },
      {
        errors: [{ message: "partial" }],
        data: { dataschemas: [{ id: "first" }, { id: "second" }] },
      },
    ]) {
      await assert.rejects(
        load({ ids: ["first", "second"] }),
        /could not be resolved completely/,
      );
    }
    response = { data: { dataschemas: [{ id: "second" }, { id: "first" }] } };
    assert.equal((await load({ ids: ["first", "second"] })).length, 2);
    const schema = { id: "first", name: "first.yml", code: "original" };
    const expectedChecksums = { first: createMd5Hex("first.yml-original") };
    response = { data: { dataschemas: [schema] } };
    assert.equal((await load({ ids: ["first"], expectedChecksums })).length, 1);
    schema.code = "changed after scope read";
    await assert.rejects(
      load({ ids: ["first"], expectedChecksums }),
      /Model files changed during scope resolution/,
    );
    assert.equal((await load({ ids: ["first"] })).length, 1);
    expectedChecksums.first = createMd5Hex(`${schema.name}-${schema.code}`);
    assert.equal((await load({ ids: ["first"], expectedChecksums })).length, 1);
  });

  it("failed model reads or YAML parsing never cache an empty or partial rule map", async () => {
    const start = rewrite.indexOf("async function buildCubeToTableMap(");
    const end = rewrite.indexOf("\n}", start) + 2;
    const cache = new Map();
    let failure = true;
    let invalidYaml = false;
    const build = runInNewContext(
      rewrite.slice(start, end) + "\nbuildCubeToTableMap;",
      {
        cubeTableMapCache: cache,
        CUBE_TABLE_MAP_MAX_SIZE: 10,
        console: { error() {} },
        findDataSchemasByIds: async () => {
          if (failure) throw Error("model unavailable");
          return [
            { name: "first.yml", code: "valid" },
            { name: "second.yml", code: "second" },
          ];
        },
        YAML: {
          parse: (code) => {
            if (invalidYaml && code === "second") throw Error("invalid YAML");
            return {
              cubes: [{ name: code, dimensions: [{ name: "partition" }] }],
            };
          },
        },
        extractTableName: () => "data_points",
      },
    );
    await assert.rejects(
      build("version", ["first", "second"]),
      /model unavailable/,
    );
    assert.equal(cache.size, 0);
    failure = false;
    // An unreadable file is recorded, not fatal: queries on cubes the map lacks
    // are refused while row rules apply (queryRewrite step 1).
    invalidYaml = true;
    const partial = await build("version", ["first", "second"]);
    assert.deepEqual([...partial.unreadable], ["second.yml"]);
    assert.equal(partial.has("valid"), true);
    assert.equal(partial.has("second"), false);
    cache.clear();
    invalidYaml = false;
    const recovered = await build("version", ["first", "second"]);
    assert.equal(recovered.size, 2);
    assert.equal(recovered.get("valid").sourceTable, "data_points");
    assert.equal(cache.size, 1);
    assert.equal(await build("version", ["first", "second"]), recovered);
  });

  it("both profile entry points reject malformed criteria instead of dropping them", () => {
    for (const file of ["profileTable.js", "smartGenerate.js"]) {
      const source = readFileSync(
        new URL("../" + file, import.meta.url),
        "utf8",
      );
      const start = source.indexOf("  if (\n    (rawFilters !== undefined");
      const end = source.indexOf("\n  }", start) + 4;
      assert.ok(start >= 0 && end > start);
      for (const field of ["rawFilters", "rawNestedFilters"]) {
        for (const value of [null, false, {}, "partition = example"]) {
          let status;
          const validate = runInNewContext(
            "(function () {" + source.slice(start, end) + "})",
            {
              rawFilters: undefined,
              rawNestedFilters: undefined,
              [field]: value,
              res: {
                status: (code) => {
                  status = code;
                  return { json: (payload) => payload };
                },
              },
            },
          );
          assert.match(validate().message, /invalid scope cannot be ignored/);
          assert.equal(status, 400);
        }
      }
      for (const value of [undefined, []]) {
        const validate = runInNewContext(
          "(function () {" + source.slice(start, end) + "})",
          { rawFilters: value, rawNestedFilters: value },
        );
        assert.equal(validate(), undefined);
      }
    }
  });

  const rule = {
    cube_name: "data_points",
    dimension: "partition",
    operator: "equals",
    property_source: "team",
    property_key: "partition",
  };

  it("retains supported mandatory predicates and ignores other tables", () => {
    const result = profileRuleFilters(
      [rule, { ...rule, cube_name: "other" }],
      "data_points",
      { teamProperties: { partition: "blue.is" } },
    );
    assert.equal(
      JSON.stringify(result),
      JSON.stringify([
        { column: "partition", operator: "=", value: "blue.is" },
      ]),
    );
    assert.equal(
      profileRuleFilters(
        [{ ...rule, operator: "notEquals", property_source: "member" }],
        "data_points",
        { memberProperties: { partition: false } },
      )[0].value,
      "false",
    );
  });

  it("rejects missing properties, unsupported operators and invalid sources", () => {
    assert.throws(
      () => profileRuleFilters([rule], "data_points", {}),
      /unavailable/,
    );
    for (const operator of ["contains", "gte", "toString"]) {
      assert.throws(
        () =>
          profileRuleFilters([{ ...rule, operator }], "data_points", {
            teamProperties: { partition: "blue.is" },
          }),
        /translated safely/,
      );
    }
    assert.throws(
      () =>
        profileRuleFilters(
          [{ ...rule, property_source: "unknown" }],
          "data_points",
          {},
        ),
      /property source/,
    );
  });

  it("does not stringify structured or non-finite property values", () => {
    for (const value of [[], {}, NaN, Infinity]) {
      assert.throws(
        () =>
          profileRuleFilters([rule], "data_points", {
            teamProperties: { partition: value },
          }),
        /property value/,
      );
    }
  });

  it("rule loading rejects failed or partial authority reads without empty or stale fallback", async () => {
    for (const fetchGraphQL of [
      async () => {
        throw Error("unavailable");
      },
      async () => ({ data: null }),
      async () => ({
        data: { query_rewrite_rules: [] },
        errors: [{ message: "partial authority read" }],
      }),
    ]) {
      const context = { fetchGraphQL, rulesQuery: "rules" };
      const loadRules = runInNewContext(
        rewrite.slice(loaderStart, loaderEnd).replace("export ", "") +
          "\nloadRules;",
        context,
      );
      await assert.rejects(loadRules());
      context.fetchGraphQL = async () => ({
        data: { query_rewrite_rules: [] },
      });
      assert.equal((await loadRules()).length, 0);
    }
    assert.match(route, /await loadRules\(\)/);
  });

  it("rule loading accepts a confirmed empty rules list", async () => {
    const context = {
      fetchGraphQL: async () => ({ data: { query_rewrite_rules: [] } }),
      rulesQuery: "rules",
    };
    const loadRules = runInNewContext(
      rewrite.slice(loaderStart, loaderEnd).replace("export ", "") +
        "\nloadRules;",
      context,
    );
    assert.equal((await loadRules()).length, 0);
  });

  it("each replica reads changed rules without relying on an invalidation callback", async () => {
    let current = [];
    let unavailable = false;
    let reads = 0;
    const replicas = Array.from({ length: 2 }, () =>
      runInNewContext(
        rewrite.slice(loaderStart, loaderEnd).replace("export ", "") +
          "\nloadRules;",
        {
          rulesQuery: "rules",
          fetchGraphQL: async () => {
            reads++;
            if (unavailable) throw Error("authority unavailable");
            return { data: { query_rewrite_rules: current } };
          },
        },
      ),
    );
    for (const load of replicas) assert.equal((await load()).length, 0);
    current = [rule];
    for (const load of replicas) assert.equal((await load())[0], rule);
    unavailable = true;
    for (const load of replicas)
      await assert.rejects(load(), /authority unavailable/);
    unavailable = false;
    current = [];
    for (const load of replicas) assert.equal((await load()).length, 0);
    assert.equal(reads, 8);
  });

  it("SQL authorization propagates rule-read failure before execution", async () => {
    const sqlRoute = readFileSync(
      new URL("../runSql.js", import.meta.url),
      "utf8",
    );
    const start = sqlRoute.indexOf("    if (!signed) {");
    const end = sqlRoute.indexOf("    // Authorized to execute", start);
    assert.ok(start >= 0 && end > start);
    const authorize = runInNewContext(
      "(async function () {" + sqlRoute.slice(start, end) + "})",
      {
        signed: false,
        req: {},
        loadRules: async () => {
          throw Error("authority unavailable");
        },
      },
    );
    await assert.rejects(authorize(), /authority unavailable/);
    const generation = readFileSync(
      new URL("../smartGenerate.js", import.meta.url),
      "utf8",
    );
    const authorityRead = generation.indexOf(
      "const rewriteRules = req.securityContext?.queryRules || (await loadRules());",
    );
    const driverCreation = generation.indexOf(
      "driver = await tenantDriverFactory",
    );
    assert.ok(authorityRead >= 0 && driverCreation > authorityRead);
    assert.doesNotMatch(
      generation,
      /Failed to load query rewrite rules \(non-fatal\)/,
    );
  });
});
