import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import ServerCore from "@cubejs-backend/server-core";

import shareCompilerApiBuilds from "../shareCompilerApiBuilds.js";

const contextToAppId = ({ securityContext }) =>
  `CUBEJS_APP_${securityContext.model}`;

const contextFor = (model) => ({ securityContext: { model } });

// Cube's own server class, so the read-await-write in its `getCompilerApi` is
// the real one. Nothing here compiles or connects: a CompilerApi is only built.
const servers = [];
const newServer = () => {
  const cubejs = new ServerCore({
    contextToAppId,
    apiSecret: "test",
    telemetry: false,
    devServer: false,
    scheduledRefreshTimer: false,
    driverFactory: () => ({ type: "clickhouse" }),
    repositoryFactory: () => ({ dataSchemaFiles: async () => [] }),
    preAggregationsSchema: () => "pre_aggregations_test",
  });
  servers.push(cubejs);
  return cubejs;
};

describe("shareCompilerApiBuilds", () => {
  after(async () => {
    await Promise.all(servers.map((cubejs) => cubejs.shutdown()));
  });

  it("gives callers of one appId in the same tick one CompilerApi", async () => {
    const cubejs = newServer();
    shareCompilerApiBuilds(cubejs, contextToAppId);

    const apis = await Promise.all(
      Array.from({ length: 5 }, () => cubejs.getCompilerApi(contextFor("a"))),
    );

    assert.equal(new Set(apis).size, 1);
    // Once built, Cube's cache answers, with the same instance.
    assert.equal(await cubejs.getCompilerApi(contextFor("a")), apis[0]);
  });

  it("builds each appId separately", async () => {
    const cubejs = newServer();
    shareCompilerApiBuilds(cubejs, contextToAppId);

    const [a, b] = await Promise.all([
      cubejs.getCompilerApi(contextFor("a")),
      cubejs.getCompilerApi(contextFor("b")),
    ]);

    assert.notEqual(a, b);
  });

  it("does not keep a failed build", async () => {
    let calls = 0;
    const cubejs = {
      async getCompilerApi() {
        calls += 1;
        if (calls === 1) throw new Error("repository unavailable");
        return { built: calls };
      },
    };
    shareCompilerApiBuilds(cubejs, contextToAppId);

    const failed = await Promise.allSettled([
      cubejs.getCompilerApi(contextFor("a")),
      cubejs.getCompilerApi(contextFor("a")),
    ]);
    assert.deepEqual(
      failed.map((r) => r.status),
      ["rejected", "rejected"],
    );
    assert.equal(calls, 1);

    assert.deepEqual(await cubejs.getCompilerApi(contextFor("a")), { built: 2 });
  });
});
