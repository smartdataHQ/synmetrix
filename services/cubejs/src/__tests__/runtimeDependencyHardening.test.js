import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);

describe("production dependency hardening", () => {
  it("resolves the direct and Hive-transitive Thrift clients to 0.23.0", () => {
    assert.equal(require("thrift/package.json").version, "0.23.0");

    const hiveDirectory = require.resolve("@cubejs-backend/hive-driver/package.json");
    const hiveRequire = createRequire(hiveDirectory);
    assert.equal(hiveRequire("thrift/package.json").version, "0.23.0");

    const jshs2Directory = require.resolve("jshs2/package.json");
    const jshs2Require = createRequire(jshs2Directory);
    assert.equal(jshs2Require("thrift/package.json").version, "0.23.0");
  });

  it("constructs and releases the Hive driver with the hardened Thrift client", async () => {
    const { default: HiveDriver } = await import("@cubejs-backend/hive-driver");
    const driver = new HiveDriver({
      host: "127.0.0.1",
      port: 10000,
      username: "test",
      password: "test",
      dbName: "default",
    });

    assert.equal(typeof driver.query, "function");
    assert.equal(typeof driver.testConnection, "function");
    assert.equal(HiveDriver.getDefaultConcurrency(), 2);
    await driver.release();
  });

  it("replaces install-time archive extraction with a fail-closed runtime shim", () => {
    assert.equal(require("extract-zip/package.json").version, "0.0.0-disabled");
    const extract = require("extract-zip");
    assert.throws(
      () => extract("untrusted.zip", { dir: "/tmp/never" }),
      (error) => error?.code === "CUBE_RUNTIME_ARCHIVE_EXTRACTION_DISABLED",
    );
  });
});
