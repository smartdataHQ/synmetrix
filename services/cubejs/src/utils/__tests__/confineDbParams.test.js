import assert from "node:assert/strict";
import { describe, it } from "node:test";

import confineDbParams from "../confineDbParams.js";

process.env.CUBEJS_LOCAL_DB_ROOT = "/data/local-db";
process.env.CUBEJS_JDBC_DRIVERS_DIR = "/app/jdbc-drivers";
const ds = { dataSourceId: "ds-1" };

const refused = (dbType, params, pattern, scope = ds) =>
  assert.rejects(confineDbParams(dbType, params, scope), pattern, `${dbType} ${JSON.stringify(params)}`);

describe("tenant datasource params are confined, not refused", () => {
  it("passes other types through untouched", async () => {
    const params = { host: "ch.example.com", port: 8123 };
    assert.equal(await confineDbParams("clickhouse", params, ds), params);
  });

  it("duckdb: memory, MotherDuck and files in the datasource's own directory; never the pod's AWS credentials", async () => {
    assert.deepEqual(await confineDbParams("duckdb", { duckdbS3UseCredentialChain: true, initSql: "x" }, ds), { initSql: "x" });
    assert.equal((await confineDbParams("duckdb", { databasePath: "md:my_db?motherduck_token=t" }, ds)).databasePath, "md:my_db?motherduck_token=t");
    await refused("duckdb", { databasePath: "md:my_db" }, /MotherDuck needs a token/);
    assert.equal((await confineDbParams("duckdb", { databasePath: "a.duckdb" }, ds)).databasePath, "/data/local-db/ds-1/a.duckdb");
    await refused("duckdb", { databasePath: "/etc/passwd" }, /under \/data\/local-db\/ds-1/);
    await refused("duckdb", { databasePath: "../ds-2/b.duckdb" }, /under \/data\/local-db\/ds-1/);
    await refused("duckdb", { databasePath: "a.duckdb" }, /needs a datasource id/, {});
  });

  it("sqlite: a file in the datasource's own directory, or memory", async () => {
    assert.equal((await confineDbParams("sqlite", { database: "a.db" }, ds)).database, "/data/local-db/ds-1/a.db");
    assert.equal((await confineDbParams("sqlite", { database: ":memory:" }, ds)).database, ":memory:");
    await refused("sqlite", { database: "/data/local-db/ds-2/victim.db" }, /under \/data\/local-db\/ds-1/);
    await refused("sqlite", {}, /database file is required/);
  });

  it("jdbc: network URLs, one driver jar per entry, only from the drivers dir", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/jdbc-drivers-`);
    for (const jar of ["b.jar", "a.jar"]) writeFileSync(`${dir}/${jar}`, "");
    process.env.CUBEJS_JDBC_DRIVERS_DIR = dir;
    // Every JDBC datasource gets the same class path: every operator jar, plus
    // the Databricks driver, whichever connects first.
    const ok = await confineDbParams("jdbc", { url: "jdbc:derby://db.example.com:1527/x", customClassPath: "a.jar" }, ds);
    assert.deepEqual(ok.customClassPath.slice(0, 2), [`${dir}/a.jar`, `${dir}/b.jar`]);
    assert.deepEqual(
      (await confineDbParams("jdbc", { url: "jdbc:x://h" }, ds)).customClassPath,
      ok.customClassPath,
    );
    process.env.CUBEJS_JDBC_DRIVERS_DIR = "/app/jdbc-drivers";
    for (const url of [
      "jdbc:derby:memory:x;create=true", "jdbc:derby:/tmp/x", "jdbc:hsqldb:mem:x", "jdbc:hsqldb:file:/tmp/x",
      "jdbc:h2:mem:x", "jdbc:h2:TCP://h/x", "jdbc:sqlite:/tmp/x", "jdbc:duckdb:",
    ]) {
      await refused("jdbc", { url }, /in-process database URLs/);
    }
    for (const url of ["jdbc:hsqldb:hsql://db.example.com/x", "jdbc:h2:tcp://db.example.com/x"]) {
      assert.equal((await confineDbParams("jdbc", { url }, ds)).url, url);
    }
    await refused("jdbc", { url: "jdbc:x://h", customClassPath: ["/app/node_modules/@cubejs-backend/jdbc/drivers-10.17/hsqldb.jar"] }, /driver jars must be under/);
    await refused("jdbc", { url: "jdbc:x://h", customClassPath: ["a.jar:/app/node_modules/x/hsqldb.jar"] }, /one jar per class-path entry/);
  });

  it("databricks-jdbc: Databricks URLs without driver logging", async () => {
    const url = "jdbc:databricks://x.cloud.databricks.com:443/default;httpPath=/sql/1";
    assert.equal((await confineDbParams("databricks-jdbc", { url }, ds)).url, url);
    await refused("databricks-jdbc", { url: "jdbc:derby:memory:x" }, /jdbc:databricks/);
    await refused("databricks-jdbc", { url: `${url};LogLevel=6;LogPath=/app` }, /logging/);
    // the Databricks driver class through the generic type, by URL or property
    await refused("jdbc", { url: `${url};LogLevel=6`, drivername: "com.databricks.client.jdbc.Driver" }, /logging/);
    await refused("jdbc", { url, properties: { LogPath: "/tmp/x" } }, /logging/);
  });

  it("cubestore: never ours, never private, websocket only, every plain connection pinned", async () => {
    process.env.CUBEJS_CUBESTORE_HOST = "synmetrix-cubestore";
    await refused("cubestore", {}, /host is required/);
    await refused("cubestore", { host: "synmetrix-cubestore.synmetrix.svc.cluster.local" }, /own Cube Store/);
    await refused("cubestore", { host: "synmetrix-cubestore-0.synmetrix-cubestore" }, /own Cube Store/);
    for (const host of ["127.0.0.1", "10.42.191.29", "localhost", "::1", "64:ff9b::a00:1", "2002:a00:1::1"]) {
      await refused("cubestore", { host }, /private network|cannot resolve/);
    }
    await refused("cubestore", { url: "ws://10.0.0.5:3030/" }, /private network/);
    await refused("cubestore", { url: "ws+unix:///var/run/x.sock" }, /url must be/);
    // host/port become a pinned URL; a port can't carry another host
    assert.deepEqual(await confineDbParams("cubestore", { host: "1.1.1.1", port: 3030 }, ds), { url: "ws://1.1.1.1:3030/" });
    await refused("cubestore", { host: "1.1.1.1", port: "1@127.0.0.1:3030" }, /port must be a number/);
    // http is plain websocket: rewritten and pinned like ws
    assert.equal((await confineDbParams("cubestore", { url: "http://1.1.1.1:3030/" }, ds)).url, "ws://1.1.1.1:3030/");
    assert.equal((await confineDbParams("cubestore", { url: "https://one.one.one.one:3030/" }, ds)).url, "wss://one.one.one.one:3030/");
    process.env.CUBEJS_CUBESTORE_DATASOURCE_ALLOW_PRIVATE = "true";
    process.env.CUBEJS_CUBESTORE_HOST = "127.0.0.1";
    assert.equal((await confineDbParams("cubestore", { host: "10.0.0.5" }, ds)).url, "ws://10.0.0.5:3030/");
    await refused("cubestore", { url: "ws://[::ffff:127.0.0.1]:3030" }, /own Cube Store/);
    delete process.env.CUBEJS_CUBESTORE_DATASOURCE_ALLOW_PRIVATE;
  });
});
