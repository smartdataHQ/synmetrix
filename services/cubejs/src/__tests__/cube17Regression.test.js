import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prepareCompiler } from "@cubejs-backend/schema-compiler";

import { escapeCSVField } from "../utils/csvSerializer.js";
import { validateFormat } from "../utils/formatValidator.js";
import {
  patchBigQueryDownloadSource,
  patchBigQueryDriverSource,
  patchPreAggregationLoaderSource,
  patchCompilerSource,
  patchDatabricksClassPathSource,
  patchDuckDbDriverSource,
  patchFireboltDriverSource,
  patchSqliteDriverSource,
} from "../../scripts/patchCubeYamlCompiler.mjs";

const require = createRequire(import.meta.url);
const runtimeVersion = require("@cubejs-backend/server-core/package.json").version;

// T060 runs the complete test tree twice, once with each dependency set. This
// manifest makes the required comparison surfaces explicit and prevents a
// future refactor from silently dropping a lane from that corpus.
const CORPUS = {
  models: [
    "../utils/smart-generation/__tests__/cubeBuilder.test.js",
    "../routes/__tests__/reconcileTeam.test.js",
  ],
  formats: [
    "../utils/formatValidator.js",
    "../utils/csvSerializer.js",
    "../utils/arrowSerializer.js",
  ],
  auth: ["../utils/__tests__/workosAuth.test.js"],
  pre_aggregations: ["../routes/__tests__/validateInBranch.corpus.test.js"],
};

describe("Cube 1.7.30 to 1.8.16 comparative corpus", () => {
  it("runs only an explicitly supported Cube runtime", () => {
    assert.ok(
      ["1.7.30", "1.8.16"].includes(runtimeVersion),
      `unsupported Cube runtime in comparative corpus: ${runtimeVersion}`,
    );
    if (process.env.CUBE_RUNTIME_EXPECTED_VERSION) {
      assert.equal(runtimeVersion, process.env.CUBE_RUNTIME_EXPECTED_VERSION);
    }
  });

  for (const [surface, paths] of Object.entries(CORPUS)) {
    it(`${surface} lane remains present`, async () => {
      for (const path of paths) await access(new URL(path, import.meta.url));
    });
  }

  it("keeps format behavior stable", () => {
    assert.equal(validateFormat(), "json");
    assert.equal(validateFormat("csv"), "csv");
    assert.equal(validateFormat("arrow"), "arrow");
    assert.equal(escapeCSVField('Iceland, "weather"'), '"Iceland, ""weather"""');
    assert.throws(() => validateFormat("parquet"), /Unsupported format/);
  });

  it("preserves JSON-valued metadata as a literal string", async () => {
    const value = JSON.stringify({
      time_zone: "Atlantic/Reykjavik",
      preferred_source: "sensor",
      language: "is",
    });
    const content = `cubes:
  - name: support_ticket_analysed
    sql_table: support_ticket_analysed
    meta:
      lc_values:
        - '${value}'
    dimensions:
      - name: id
        sql: id
        type: string
        primary_key: true
`;
    const repository = {
      dataSchemaFiles: async () => [
        { fileName: "support_ticket_analysed.yml", content },
      ],
    };
    const { compiler, metaTransformer } = prepareCompiler(repository, {});

    await compiler.compile();

    assert.equal(metaTransformer.cubes[0].config.meta.lc_values[0], value);
  });

  it("guards the compiler patch against upstream source drift", () => {
    const source = `before
        else if (typeof obj === 'string') {
            let code = obj;
            if (!CubeValidator_1.nonStringFields.has(propertyPath[propertyPath.length - 1])) {
after`;
    const first = patchCompilerSource(source);
    assert.equal(first.changed, true);
    assert.match(first.source, /propertyPath\.includes\('meta'\)/);
    assert.deepEqual(patchCompilerSource(first.source), {
      source: first.source,
      changed: false,
    });
    assert.throws(
      () => patchCompilerSource("unexpected compiler source"),
      /expected source anchor was not found exactly once/,
    );
  });

  it("guards the BigQuery stream-error patch against upstream source drift", () => {
    const source = `before
        const rowStream = new HydrationStream_1.HydrationStream();
        stream.pipe(rowStream);
after`;
    const first = patchBigQueryDriverSource(source);
    assert.equal(first.changed, true);
    assert.match(first.source, /stream\.on\('error', \(err\) => rowStream\.destroy\(err\)\);/);
    assert.deepEqual(patchBigQueryDriverSource(first.source), {
      source: first.source,
      changed: false,
    });
    assert.throws(
      () => patchBigQueryDriverSource("unexpected driver source"),
      /expected source anchor was not found exactly once/,
    );
  });

  it("guards the loader stream-error patch against upstream source drift", () => {
    const site = `
                tableData.rowStream.pipe(stream);
                tableData.rowStream = stream;`;
    const first = patchPreAggregationLoaderSource(`before${site}\nmiddle${site}\nafter`);
    assert.equal(first.changed, true);
    assert.equal(first.source.split("stream.destroy(err)").length - 1, 2);
    assert.deepEqual(patchPreAggregationLoaderSource(first.source), {
      source: first.source,
      changed: false,
    });
    assert.throws(
      () => patchPreAggregationLoaderSource(`before${site}\nafter`),
      /expected source anchor was not found exactly 2 times/,
    );
  });

  it("fails a BigQuery pre-aggregation download instead of crashing on a query-stream error", async () => {
    const { BigQueryDriver } = require("@cubejs-backend/bigquery-driver");
    const { PreAggregationLoader } = require(
      "@cubejs-backend/query-orchestrator/dist/src/orchestrator/PreAggregationLoader.js",
    );
    const driver = new BigQueryDriver({ projectId: "test", credentials: {} });
    const source = new PassThrough({ objectMode: true });
    driver.bigquery = {
      createQueryStream: () => source,
      dataset: () => ({ table: () => ({ getMetadata: async () => [{ schema: { fields: [] } }] }) }),
    };
    const loader = {
      preAggregation: { preAggregationId: "cube.rollup" },
      getUnloadOptions: () => ({}),
      getStreamingOptions: () => ({}),
      logger: () => {},
    };

    // the loader's own path: driver.stream(), then its LargeStreamWarning wrap
    const { rowStream } = await PreAggregationLoader.prototype.getTableDataWithTempTable.call(
      loader, driver, "pre_aggregations_x.t", (p) => p, {}, { csvImport: true, streamImport: true },
    );
    const loaded = pipeline(rowStream, new Writable({ objectMode: true, write: (_row, _enc, done) => done() }));
    source.emit("error", new Error("Not found: Table p:pre_aggregations_x.t"));

    await assert.rejects(loaded, /Not found: Table/);
  });

  it("guards the BigQuery read-only download patch against upstream source drift", () => {
    const source = `before
    async loadTablesForDataset(dataset) {
after`;
    const first = patchBigQueryDownloadSource(source);
    assert.equal(first.changed, true);
    assert.match(first.source, /async downloadQueryResults\(query, values, options\)/);
    assert.deepEqual(patchBigQueryDownloadSource(first.source), { source: first.source, changed: false });
    assert.throws(
      () => patchBigQueryDownloadSource("unexpected driver source"),
      /expected source anchor was not found exactly once/,
    );
  });

  describe("BigQuery read-only download", () => {
    const fields = [
      { name: "club", type: "STRING" },
      { name: "orders", type: "INTEGER" },
      { name: "amount", type: "NUMERIC" },
      { name: "fee", type: "FLOAT" },
      { name: "day", type: "TIMESTAMP" },
    ];
    const fakeBigQuery = (rows) => ({
      createQueryJob: async () => [{
        getMetadata: async () => [{ status: { state: "DONE" }, statistics: {} }],
        getQueryResults: async (opts) => (opts?.maxResults === 0 && opts?.autoPaginate === false
          ? [[], null, { schema: { fields } }]
          : [rows]),
      }],
      dataset: () => ({ table: () => ({ getMetadata: async () => [{ schema: { fields } }] }) }),
    });
    const download = async (rows) => {
      const { BigQueryDriver } = require("@cubejs-backend/bigquery-driver");
      const driver = new BigQueryDriver({ projectId: "test", credentials: {} });
      driver.bigquery = fakeBigQuery(rows);
      return { driver, result: await driver.downloadQueryResults("SELECT 1", [], {}) };
    };

    it("types columns from BigQuery's result schema, exactly as the staging path does", async () => {
      // whole numbers first: guessing from rows would type amount and fee as integers
      const rows = [
        { club: "A", orders: 3, amount: "10", fee: 0, day: "2026-10-01" },
        { club: "B", orders: 4, amount: "12.75", fee: 1.5, day: "2026-10-02" },
      ];
      const { driver, result } = await download(rows);

      assert.deepEqual(result.types, await driver.tableColumnTypes("pre_aggregations_x.t"));
      assert.equal(result.rows.length, 2);
    });

    it("types an empty partition instead of failing", async () => {
      const { driver, result } = await download([]);

      assert.deepEqual(result.rows, []);
      assert.deepEqual(result.types, await driver.tableColumnTypes("pre_aggregations_x.t"));
    });
  });

  it("casts composite-key count measures to a ClickHouse String type (Tesseract)", async () => {
    const { ClickHouseQuery } = require(
      "@cubejs-backend/schema-compiler/dist/src/adapter/ClickHouseQuery.js",
    );
    const content = `cubes:
  - name: points
    sql_table: points
    dimensions:
      - name: series_gid
        sql: series_gid
        type: string
        primary_key: true
      - name: ts
        sql: ts
        type: time
        primary_key: true
    measures:
      - name: count
        type: count
`;
    const compilers = prepareCompiler(
      { dataSchemaFiles: async () => [{ fileName: "points.yml", content }] },
      { adapter: "clickhouse" },
    );
    await compilers.compiler.compile();
    const [sql] = new ClickHouseQuery(compilers, {
      measures: ["points.count"],
      timezone: "UTC",
      useNativeSqlPlanner: true,
    }).buildSqlAndParams();

    // 1.7.30 (patched) casts to String; Cube 1.7.38+ casts to Nullable(String).
    assert.match(sql, / AS (?:Nullable\()?String\)/);
    assert.doesNotMatch(sql, / AS STRING\)/);
  });

  it("guards the DuckDB and SQLite tenant-isolation patches against upstream drift", () => {
    const duck = patchDuckDbDriverSource(`x
        let dbOptions;
        if (token) {
            dbOptions = { custom_user_agent: \`Cube/\${version}\` };
        }
        const instance = await node_api_1.DuckDBInstance.create(dbUrl, dbOptions);
        if (this.config.initSql) {
            try {
                await execAsync(this.config.initSql);
    async query(query, values = [], _options) {
        const { defaultConnection } = await this.getInitiatedState();
    async stream(query, values, { highWaterMark }) {
        const { instance } = await this.getInitiatedState();
y`);
    assert.equal(duck.changed, true);
    assert.match(duck.source, /autoinstall_known_extensions: 'false'/);
    assert.match(duck.source, /allow_persistent_secrets: 'false'/);
    assert.ok(
      duck.source.indexOf("lock_configuration=true") < duck.source.indexOf("await execAsync(this.config.initSql)"),
      "the sandbox must be locked before tenant initSql",
    );
    assert.equal(patchDuckDbDriverSource(duck.source).changed, false);
    assert.throws(() => patchDuckDbDriverSource("drifted"), /exactly once/);

    const lite = patchSqliteDriverSource(`      this.config.db = new sqlite3.Database(this.config.database);
  async testConnection() {
  query(query, values) {
    return new Promise(
      (resolve, reject) => this.config.db.all(
        query,
        values || [],
        (err, result) => (err ? reject(err) : resolve(result))
      )
    );
  }
  async release() {
    await new Promise((resolve, reject) => this.config.db.close((err) => (err ? reject(err) : resolve())));
  }
    return this.query(
      'PRAGMA database_list'
    ).then((schemas) => {`);
    assert.match(lite.source, /LIMIT_ATTACHED, 0/);
    assert.match(lite.source, /readOnly\(\) \{\n    return true;/);
    assert.throws(() => patchSqliteDriverSource("drifted"), /exactly once/);
  });

  it("gives the Databricks driver the operator's JDBC jars too, so connect order doesn't matter", async () => {
    const patched = patchDatabricksClassPathSource(`    async getCustomClassPath() {
        return (0, installer_1.resolveJDBCDriver)();
    }`);
    assert.match(patched.source, /CUBEJS_JDBC_DRIVERS_DIR/);
    // Read, not loaded: loading a JDBC driver starts node-java, which would
    // hold the test process open.
    const installed = await readFile(
      require.resolve("@cubejs-backend/databricks-jdbc-driver/dist/src/DatabricksDriver.js"),
      "utf8",
    );
    assert.equal(patchDatabricksClassPathSource(installed).changed, false, "the installed driver is patched");
  });

  it("the installed DuckDB driver keeps tenant SQL inside its own directory", async () => {
    const { mkdirSync } = await import("node:fs");
    const { default: ServerCore } = await import("@cubejs-backend/server-core");
    const dir = "/tmp/duckdb-sandbox-test/ds-1";
    mkdirSync(dir, { recursive: true });
    const driver = ServerCore.createDriver("duckdb", {
      databasePath: `${dir}/a.duckdb`,
      // Tenant initSql tries to stash the environment; it runs after the lock.
      initSql: "CREATE TABLE leak AS SELECT content FROM read_text('/proc/self/environ')",
    });
    try {
      assert.equal(Number((await driver.query("SELECT 41 + 1 AS answer", []))[0].answer), 42);
      await driver.query("CREATE OR REPLACE TABLE t AS SELECT range AS b FROM range(200000)", []);
      await driver.query(`COPY (SELECT 1) TO '${dir}/out.csv'`, []);
      await assert.rejects(driver.query("SELECT * FROM leak", []), /leak/);
      for (const sql of [
        "SELECT content FROM read_text('/proc/self/environ')",
        "SELECT * FROM read_csv('/etc/passwd')",
        "ATTACH '/tmp/victim.db' AS v (TYPE sqlite)",
        "ATTACH '/tmp/x.duckdb' AS x",
        "COPY (SELECT 1) TO '/tmp/out.csv'",
        `SELECT * FROM read_csv('${dir}/../other/x.csv')`,
        "LOAD sqlite",
        "SET enable_external_access=true",
        "SET lock_configuration=false",
      ]) {
        await assert.rejects(driver.query(sql, []), undefined, sql);
      }
    } finally {
      await driver.release();
    }
  });

  it("the installed DuckDB driver refuses operator extensions that bypass its sandbox, and logging calls", async () => {
    const { default: ServerCore } = await import("@cubejs-backend/server-core");
    process.env.CUBEJS_DB_DUCKDB_EXTENSIONS = "httpfs,sqlite";
    const refused = ServerCore.createDriver("duckdb", {});
    try {
      await assert.rejects(refused.query("SELECT 1", []), /extension "sqlite"/);
    } finally {
      delete process.env.CUBEJS_DB_DUCKDB_EXTENSIONS;
      await refused.release().catch(() => {});
    }
    const driver = ServerCore.createDriver("duckdb", {});
    try {
      await assert.rejects(driver.query("CALL enable_logging(storage='stdout')", []), /not allowed/);
    } finally {
      await driver.release();
    }
    const viaInitSql = ServerCore.createDriver("duckdb", { initSql: "CALL enable_logging(storage='stdout')" });
    await assert.rejects(viaInitSql.query("SELECT 1", []), /not allowed/);
    await viaInitSql.release().catch(() => {});
  });

  it("the installed DuckDB driver serves remote prefixes only once egress is restricted", async () => {
    const { default: ServerCore } = await import("@cubejs-backend/server-core");
    process.env.CUBEJS_DB_DUCKDB_ALLOWED_PATHS = "s3://operator-bucket/";
    try {
      const open = ServerCore.createDriver("duckdb", {});
      await assert.rejects(open.query("SELECT 1", []), /egress restricted/);
      await open.release().catch(() => {});
      process.env.CUBEJS_DB_DUCKDB_EGRESS_RESTRICTED = "true";
      const restricted = ServerCore.createDriver("duckdb", {});
      try {
        assert.equal(Number((await restricted.query("SELECT 1 AS one", []))[0].one), 1);
      } finally {
        await restricted.release();
      }
    } finally {
      delete process.env.CUBEJS_DB_DUCKDB_ALLOWED_PATHS;
      delete process.env.CUBEJS_DB_DUCKDB_EGRESS_RESTRICTED;
    }
  });

  it("the installed DuckDB driver keeps operator S3 credentials out of readable settings", async () => {
    const { default: ServerCore } = await import("@cubejs-backend/server-core");
    Object.assign(process.env, {
      CUBEJS_DB_DUCKDB_EXTENSIONS: "httpfs",
      CUBEJS_DB_DUCKDB_S3_ACCESS_KEY_ID: "AKIAOPERATOR",
      CUBEJS_DB_DUCKDB_S3_SECRET_ACCESS_KEY_ID: "operator-secret",
      CUBEJS_DB_DUCKDB_S3_REGION: "eu-west-1",
    });
    const driver = ServerCore.createDriver("duckdb", {});
    try {
      const [setting] = await driver.query("SELECT current_setting('s3_secret_access_key') AS v", []);
      assert.ok(!setting.v, "the operator secret is not a readable setting");
      const secrets = await driver.query("SELECT name, secret_string FROM duckdb_secrets()", []);
      assert.equal(secrets[0].name, "synmetrix_operator_s3");
      assert.doesNotMatch(secrets[0].secret_string, /operator-secret/);
    } finally {
      await driver.release();
      for (const k of ["CUBEJS_DB_DUCKDB_EXTENSIONS", "CUBEJS_DB_DUCKDB_S3_ACCESS_KEY_ID", "CUBEJS_DB_DUCKDB_S3_SECRET_ACCESS_KEY_ID", "CUBEJS_DB_DUCKDB_S3_REGION"]) delete process.env[k];
    }
  });

  it("an unopenable SQLite file fails its queries, not the process", async () => {
    const { default: ServerCore } = await import("@cubejs-backend/server-core");
    const driver = ServerCore.createDriver("sqlite", { database: "/nonexistent-dir/x.db" });
    try {
      await assert.rejects(driver.query("SELECT 1", []), /SQLITE_CANTOPEN/);
    } finally {
      await driver.release().catch(() => {});
    }
  });

  it("the installed SQLite driver is read-only and refuses ATTACH", async () => {
    const { default: ServerCore } = await import("@cubejs-backend/server-core");
    const driver = ServerCore.createDriver("sqlite", { database: ":memory:" });
    try {
      assert.equal(driver.readOnly(), true);
      assert.equal(Number((await driver.query("SELECT 1 AS one", []))[0].one), 1);
      await assert.rejects(
        driver.query("ATTACH DATABASE '/tmp/attached.db' AS a", []),
        /too many attached databases/,
      );
      for (const sql of [
        "PRAGMA temp_store_directory = '/dev/shm'",
        "PRAGMA hard_heap_limit = 100000",
        "SELECT * FROM pragma_soft_heap_limit(1)",
      ]) {
        await assert.rejects(driver.query(sql, []), /not allowed/, sql);
      }
      await assert.rejects(driver.createSchemaIfNotExists("stb_pre_aggregations"), /must be external/);
    } finally {
      await driver.release();
    }
  });

  it("reads compile errors one by one from errorsReporter", async () => {
    const { compiler } = prepareCompiler(
      { dataSchemaFiles: async () => [{ fileName: "bad.yml", content: "cubes:\n  - name: orders\n    sql_table: t\n    measures:\n      - name: c\n        type: nope\n" }] },
      { adapter: "postgres" },
    );
    await assert.rejects(compiler.compile());
    assert.equal(compiler.errorsReport, undefined, "the old name is gone; reading it lost every structured error");
    const errors = compiler.errorsReporter.getErrors();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /^orders cube: \(measures\.c\.type = nope\)/);
  });

  it("lets a Firebolt datasource connect with its own login when the server has none", async () => {
    assert.equal(patchFireboltDriverSource(
      "        const username = (0, shared_1.getEnv)('dbUser', { dataSource, preAggregations });",
    ).changed, true);
    const { default: ServerCore } = await import("@cubejs-backend/server-core");
    const { default: prepareDbParams } = await import("../utils/prepareDbParams.js");
    const driver = ServerCore.createDriver(
      "firebolt",
      prepareDbParams({ username: "svc", password: "s", database: "d", engineName: "e", account: "a" }, "firebolt"),
    );
    assert.deepEqual(driver.config.connection.auth, { client_id: "svc", client_secret: "s" });
    assert.equal(driver.config.connection.account, "a");
  });

  it("does not embed a comparison result in the test source", async () => {
    const source = await readFile(new URL(import.meta.url), "utf8");
    assert.doesNotMatch(source, /pass(?:ed)?\s*[:=]\s*(?:true|yes)/i);
  });
});
