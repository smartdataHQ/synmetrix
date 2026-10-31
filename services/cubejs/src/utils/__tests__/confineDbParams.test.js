import assert from "node:assert/strict";
import { describe, it } from "node:test";

import confineDbParams from "../confineDbParams.js";

process.env.CUBEJS_LOCAL_DB_ROOT = "/data/local-db";
process.env.CUBEJS_JDBC_DRIVERS_DIR = "/app/jdbc-drivers";

const refused = (dbType, params, pattern) =>
  assert.rejects(confineDbParams(dbType, params), pattern, `${dbType} ${JSON.stringify(params)}`);

describe("tenant datasource params are confined, not refused", () => {
  it("passes other types through untouched", async () => {
    const params = { host: "ch.example.com", port: 8123 };
    assert.equal(await confineDbParams("clickhouse", params), params);
  });

  it("duckdb: memory, MotherDuck and files under the local root; never the pod's AWS credentials", async () => {
    assert.deepEqual(await confineDbParams("duckdb", { duckdbS3UseCredentialChain: true, initSql: "x" }), { initSql: "x" });
    assert.equal((await confineDbParams("duckdb", { databasePath: "md:my_db" })).databasePath, "md:my_db");
    assert.equal((await confineDbParams("duckdb", { databasePath: "team/a.duckdb" })).databasePath, "/data/local-db/team/a.duckdb");
    await refused("duckdb", { databasePath: "/etc/passwd" }, /under \/data\/local-db/);
    await refused("duckdb", { databasePath: "../../etc/passwd" }, /under \/data\/local-db/);
    await refused("duckdb", { databasePath: "/data/local-db" }, /under \/data\/local-db/);
  });

  it("sqlite: a file under the local root or memory", async () => {
    assert.equal((await confineDbParams("sqlite", { database: "a.db" })).database, "/data/local-db/a.db");
    assert.equal((await confineDbParams("sqlite", { database: ":memory:" })).database, ":memory:");
    await refused("sqlite", { database: "/app/.env" }, /under \/data\/local-db/);
    await refused("sqlite", {}, /database file is required/);
  });

  it("jdbc: network URLs, driver jars only from the drivers dir", async () => {
    const ok = await confineDbParams("jdbc", {
      url: "jdbc:derby://db.example.com:1527/x",
      customClassPath: "derbyclient.jar",
    });
    assert.deepEqual(ok.customClassPath, ["/app/jdbc-drivers/derbyclient.jar"]);
    for (const url of [
      "jdbc:derby:memory:x;create=true",
      "jdbc:derby:/tmp/x",
      "jdbc:hsqldb:mem:x",
      "jdbc:hsqldb:file:/tmp/x",
      "JDBC:H2:mem:x",
      "jdbc:sqlite:/tmp/x",
      "jdbc:duckdb:",
    ]) {
      await refused("jdbc", { url }, /in-process database URLs/);
    }
    for (const url of ["jdbc:hsqldb:hsql://db.example.com/x", "jdbc:h2:tcp://db.example.com/x"]) {
      assert.equal((await confineDbParams("jdbc", { url })).url, url);
    }
    await refused(
      "jdbc",
      { url: "jdbc:x://h", customClassPath: ["/app/node_modules/@cubejs-backend/jdbc/drivers-10.17/hsqldb.jar"] },
      /driver jars must be under/,
    );
  });

  it("databricks-jdbc: Databricks URLs only", async () => {
    const url = "jdbc:databricks://x.cloud.databricks.com:443/default;httpPath=/sql/1";
    assert.equal((await confineDbParams("databricks-jdbc", { url })).url, url);
    await refused("databricks-jdbc", { url: "jdbc:derby:memory:x" }, /jdbc:databricks/);
  });

  it("cubestore: never ours, never a private address, pinned to the checked address", async () => {
    process.env.CUBEJS_CUBESTORE_HOST = "synmetrix-cubestore";
    await refused("cubestore", {}, /host is required/);
    await refused("cubestore", { host: "synmetrix-cubestore.synmetrix.svc.cluster.local" }, /own Cube Store/);
    await refused("cubestore", { host: "synmetrix-cubestore-0.synmetrix-cubestore" }, /own Cube Store/);
    for (const host of ["127.0.0.1", "10.42.191.29", "localhost", "[::1]"]) {
      await refused("cubestore", { host: host.replace(/[[\]]/g, "") }, /private network|cannot resolve/);
    }
    await refused("cubestore", { url: "ws://10.0.0.5:3030/" }, /private network/);
    assert.deepEqual(await confineDbParams("cubestore", { host: "1.1.1.1", port: 3030 }), { host: "1.1.1.1", port: 3030 });
    assert.equal(
      (await confineDbParams("cubestore", { url: "ws://1.1.1.1:3030/" })).url,
      "ws://1.1.1.1:3030/",
    );
    process.env.CUBEJS_CUBESTORE_DATASOURCE_ALLOW_PRIVATE = "true";
    assert.equal((await confineDbParams("cubestore", { host: "10.0.0.5" })).host, "10.0.0.5");
    delete process.env.CUBEJS_CUBESTORE_DATASOURCE_ALLOW_PRIVATE;
  });
});
