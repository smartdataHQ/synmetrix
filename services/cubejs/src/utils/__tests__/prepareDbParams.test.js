import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import prepareDbParams from "../prepareDbParams.js";

const require = createRequire(import.meta.url);

describe("prepareDbParams", () => {
  it("makes BigQuery drivers read-only, so rollups never write to the customer's project", () => {
    const { BigQueryDriver } = require("@cubejs-backend/bigquery-driver");
    const params = prepareDbParams(
      { projectId: "abler-web", keyFile: JSON.stringify({ client_email: "sa@abler-web.iam" }) },
      "bigquery",
    );

    assert.equal(new BigQueryDriver(params).readOnly(), true);
  });

  it("authenticates Presto and Trino with the form's password", () => {
    for (const type of ["prestodb", "trino"]) {
      const params = prepareDbParams({ host: "h", user: "u", pass: "secret", catalog: "c" }, type);
      assert.deepEqual(params.basic_auth, { user: "u", password: "secret" });
      assert.equal(params.pass, undefined);
    }
  });

  it("turns SQL Server encryption on from the form's SSL checkbox", () => {
    assert.deepEqual(prepareDbParams({ host: "h", ssl: true }, "mssql").options, { encrypt: true, useUTC: true });
    assert.deepEqual(prepareDbParams({ host: "h" }, "mssql").options, { encrypt: false, useUTC: true });
  });

  it("maps the generic form onto the Hive driver's field names", () => {
    const params = prepareDbParams({ host: "h", user: "u", database: "warehouse" }, "hive");
    assert.equal(params.username, "u");
    assert.equal(params.dbName, "warehouse");
  });

  it("gives Firebolt the connection.auth its driver reads", () => {
    const service = prepareDbParams({ username: "svc-id", password: "s", database: "d", engineName: "e", account: "acme" }, "firebolt");
    assert.deepEqual(service.connection, { auth: { client_id: "svc-id", client_secret: "s" }, database: "d", engineName: "e", account: "acme" });
    const email = prepareDbParams({ username: "me@x.com", password: "p", database: "d" }, "firebolt");
    assert.deepEqual(email.connection.auth, { username: "me@x.com", password: "p" });
  });

  it("passes the MotherDuck token under the key the DuckDB driver reads, and in an md: path", () => {
    assert.equal(prepareDbParams({ motherduckToken: "tok" }, "duckdb").motherDuckToken, "tok");
    assert.equal(
      prepareDbParams({ database: "md:my_db", motherduckToken: "t/k" }, "duckdb").databasePath,
      "md:my_db?motherduck_token=t%2Fk",
    );
  });
});
