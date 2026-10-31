import assert from "node:assert/strict";
import { describe, it } from "node:test";

import driverFactory, {
  driverConfigFactory,
} from "../driverFactory.js";
import tenantDriverFactory from "../tenantDriverFactory.js";

const scopeFor = (dbType, dbParams = {}) => ({
  userScope: { dataSource: { dataSourceId: "ds-test", dbType, dbParams } },
});

const securityContext = {
  userScope: {
    dataSource: {
      dbType: "postgres",
      dbParams: {
        host: "database.internal",
        port: 5432,
        database: "analytics",
        user: "reader",
      },
    },
  },
};

describe("Cube 1.7 driver factory compatibility", () => {
  it("returns a typed DriverConfig for Cube server dialect resolution", async () => {
    const config = await driverConfigFactory({ securityContext });

    assert.deepEqual(config, {
      host: "database.internal",
      port: 5432,
      database: "analytics",
      user: "reader",
      type: "postgres",
    });
  });

  it("fails closed when the tenant datasource selection is incomplete", async () => {
    await assert.rejects(
      driverConfigFactory({ securityContext: {} }),
      /database type and parameters are required/,
    );
  });

  it("keeps raw-route driver construction separate from Cube DriverConfig", () => {
    const realFactory = () => "real-driver";
    const cubeFactory = () => ({ type: "postgres" });

    assert.equal(
      tenantDriverFactory({
        tenantDriverFactory: realFactory,
        options: { driverFactory: cubeFactory },
      }),
      realFactory,
    );
    assert.equal(
      tenantDriverFactory({ options: { driverFactory: cubeFactory } }),
      cubeFactory,
    );
  });

  it("constructs real driver instances through Cube's resolver", async () => {
    // Drivers ship ESM entry points since Cube 1.7.37: a default import
    // yields the module namespace, not the class.
    for (const [dbType, dbParams] of [
      ["postgres", { host: "127.0.0.1", database: "x", user: "x" }],
      ["clickhouse", { host: "127.0.0.1", port: 8123 }],
      ["vertica", { host: "127.0.0.1", database: "x", user: "x" }],
    ]) {
      const driver = await driverFactory({ securityContext: scopeFor(dbType, dbParams) });
      assert.equal(typeof driver.query, "function", dbType);
      assert.equal(typeof driver.testConnection, "function", dbType);
      await driver.release?.();
    }
  });

  it("keeps every database type Cube knows, confined", async () => {
    for (const [dbType, dbParams] of [
      ["duckdb", {}],
      ["sqlite", { database: ":memory:" }],
    ]) {
      const driver = await driverFactory({ securityContext: scopeFor(dbType, dbParams) });
      assert.equal(typeof driver.query, "function", dbType);
      await driver.release?.();
    }
    // The JDBC drivers' pool keeps a timer after release, which would hold the
    // test process open; their config path is what the Cube server uses.
    for (const [dbType, dbParams] of [
      ["jdbc", { url: "jdbc:postgresql://db.example.com/x", drivername: "org.postgresql.Driver" }],
      ["databricks-jdbc", { url: "jdbc:databricks://x.cloud.databricks.com:443/default;httpPath=/sql/1.0/warehouses/abc", token: "t" }],
    ]) {
      const { customClassPath, ...config } = await driverConfigFactory({
        securityContext: scopeFor(dbType, dbParams),
      });
      assert.deepEqual(config, { ...dbParams, type: dbType });
      // generic JDBC gets the shared JVM class path
      if (dbType === "jdbc") assert.ok(Array.isArray(customClassPath));
    }
  });

  it("refuses types Cube does not know, so no package is looked up by name", async () => {
    for (const dbType of ["some-npm-package", "../../etc"]) {
      await assert.rejects(
        driverFactory({ securityContext: scopeFor(dbType, {}) }),
        /Unsupported database type/,
      );
      await assert.rejects(
        driverConfigFactory({ securityContext: scopeFor(dbType, {}) }),
        /Unsupported database type/,
      );
    }
  });

  it("confines params on both the Cube server path and the raw-route path", async () => {
    const hostile = scopeFor("sqlite", { database: "/etc/hosts" });
    await assert.rejects(driverFactory({ securityContext: hostile }), /database files must be under/);
    await assert.rejects(driverConfigFactory({ securityContext: hostile }), /database files must be under/);
  });
});
