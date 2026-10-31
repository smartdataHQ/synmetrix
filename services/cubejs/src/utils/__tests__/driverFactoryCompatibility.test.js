import assert from "node:assert/strict";
import { describe, it } from "node:test";

import driverFactory, {
  driverConfigFactory,
} from "../driverFactory.js";
import tenantDriverFactory from "../tenantDriverFactory.js";

const scopeFor = (dbType, dbParams = {}) => ({
  userScope: { dataSource: { dbType, dbParams } },
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

  it("refuses types that reach the Cube pod's files, its JVM, or our pre-aggregation store", async () => {
    for (const dbType of [
      "duckdb",
      "sqlite",
      "jdbc",
      "databricks-jdbc",
      "cubestore",
      "elasticsearch",
      "some-npm-package",
    ]) {
      await assert.rejects(
        driverFactory({ securityContext: scopeFor(dbType, { database: "/etc/hosts" }) }),
        /Unsupported database type/,
        dbType,
      );
      await assert.rejects(
        driverConfigFactory({ securityContext: scopeFor(dbType, { database: "/etc/hosts" }) }),
        /Unsupported database type/,
        dbType,
      );
    }
  });
});
