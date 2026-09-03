import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  driverConfigFactory,
} from "../driverFactory.js";
import tenantDriverFactory from "../tenantDriverFactory.js";

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
});
