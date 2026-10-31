import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { prepareCompiler } from "@cubejs-backend/schema-compiler";

import driverFactory, { driverConfigFactory } from "../driverFactory.js";

const require = createRequire(import.meta.url);
const scope = (dbParams) => ({ userScope: { dataSource: { dbType: "elasticsearch", dbParams } } });

describe("Elasticsearch datasources (driver Cube dropped in 1.7.0, kept locally)", () => {
  it("resolves to the local driver package, which brings its own SQL dialect", () => {
    const { driverDependencies, lookupDriverClass } = require("@cubejs-backend/server-core/dist/src/core/DriverResolvers");
    assert.equal(driverDependencies("elasticsearch"), "elasticsearch-cubejs-driver");
    assert.equal(lookupDriverClass("elasticsearch").dialectClass().name, "ElasticSearchQuery");
  });

  it("is accepted by both factories and builds a driver from the form's params", async () => {
    const params = { url: "http://es.example.com:9200", username: "u", password: "p" };
    assert.equal((await driverConfigFactory({ securityContext: scope(params) })).type, "elasticsearch");
    const driver = await driverFactory({ securityContext: scope(params) });
    assert.equal(driver.config.url, "http://es.example.com:9200");
    await driver.release();
  });

  it("plans Elasticsearch SQL with the JS planner even when Tesseract is on", async () => {
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = "true";
    const Dialect = require("elasticsearch-cubejs-driver").dialectClass();
    const compilers = prepareCompiler(
      {
        dataSchemaFiles: async () => [{
          fileName: "o.yml",
          content: "cubes:\n  - name: orders\n    sql_table: orders\n    dimensions:\n      - name: status\n        sql: status\n        type: string\n    measures:\n      - name: count\n        type: count\n",
        }],
      },
      { adapter: "elasticsearch", dialectClass: () => Dialect },
    );
    await compilers.compiler.compile();
    const query = new Dialect(compilers, { measures: ["orders.count"], dimensions: ["orders.status"], timezone: "UTC" });
    const [sql] = query.buildSqlAndParams();
    assert.equal(query.useNativeSqlPlanner, false);
    assert.match(sql, /GROUP BY orders\.status/);
  });
});
