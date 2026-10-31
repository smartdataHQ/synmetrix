import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SUPPORTED_VERSION = "1.8.16";
const COMPILER_PACKAGE = "@cubejs-backend/schema-compiler";
const BIGQUERY_PACKAGE = "@cubejs-backend/bigquery-driver";
const ORCHESTRATOR_PACKAGE = "@cubejs-backend/query-orchestrator";
const DUCKDB_PACKAGE = "@cubejs-backend/duckdb-driver";
const SQLITE_PACKAGE = "@cubejs-backend/sqlite-driver";
const DATABRICKS_PACKAGE = "@cubejs-backend/databricks-jdbc-driver";
const FIREBOLT_PACKAGE = "@cubejs-backend/firebolt-driver";

const ORIGINAL = `        else if (typeof obj === 'string') {
            let code = obj;
            if (!CubeValidator_1.nonStringFields.has(propertyPath[propertyPath.length - 1])) {`;

const PATCHED = `        else if (typeof obj === 'string') {
            // Cube metadata is an arbitrary literal payload exposed to API consumers.
            // Treating it as Python f-string source makes JSON-valued metadata look
            // like an interpolation expression and rejects otherwise valid models.
            // Jinja rendering has already happened before this transformation.
            if (propertyPath.includes('meta')) {
                return t.stringLiteral(obj);
            }
            let code = obj;
            if (!CubeValidator_1.nonStringFields.has(propertyPath[propertyPath.length - 1])) {`;

const BIGQUERY_ORIGINAL = `        const rowStream = new HydrationStream_1.HydrationStream();
        stream.pipe(rowStream);`;

const BIGQUERY_PATCHED = `        const rowStream = new HydrationStream_1.HydrationStream();
        // pipe() drops source errors; an unhandled one ("Not found: Table")
        // is an uncaughtException that kills the refresh worker for every
        // tenant. Forwarded, it fails only this pre-aggregation build.
        stream.on('error', (err) => rowStream.destroy(err));
        stream.pipe(rowStream);`;

const BIGQUERY_DOWNLOAD_ORIGINAL = `    async loadTablesForDataset(dataset) {`;

const BIGQUERY_DOWNLOAD_PATCHED = `    // Read-only rollups: column types from BigQuery's result schema, as
    // tableColumnTypes gives the staging path. The base driver guesses them
    // from the rows: a decimal after whole numbers fails the Cube Store load,
    // and an empty partition cannot be typed at all.
    async downloadQueryResults(query, values, options) {
        const labels = this.buildQueryLabels(options);
        const [job] = await this.bigquery.createQueryJob({
            query,
            params: values,
            parameterMode: 'positional',
            useLegacySql: false,
            wrapIntegers: true,
            ...(labels ? { labels } : {}),
        });
        const [rows] = await this.waitForJobResult(job, options, true);
        const [, , response] = await job.getQueryResults({ maxResults: 0, autoPaginate: false });
        return {
            rows: rows.map(row => (0, HydrationStream_1.transformRow)(row)),
            types: response.schema.fields.map((c) => {
                if (c.type === 'NUMERIC' || c.type === 'DECIMAL') {
                    return { name: c.name, type: this.toGenericType(c.type, 38, 9) };
                }
                if (c.type === 'BIGNUMERIC' || c.type === 'BIGDECIMAL') {
                    return { name: c.name, type: this.toGenericType(c.type, 76, 38) };
                }
                return { name: c.name, type: this.toGenericType(c.type) };
            }),
        };
    }
    async loadTablesForDataset(dataset) {`;

// Both stream-download paths wrap the driver's row stream the same way.
const LOADER_ORIGINAL = `                tableData.rowStream.pipe(stream);
                tableData.rowStream = stream;`;

const LOADER_PATCHED = `                // pipe() drops source errors; forwarded, they reach the upload pipeline
                tableData.rowStream.on('error', (err) => stream.destroy(err));
                tableData.rowStream.pipe(stream);
                tableData.rowStream = stream;`;

// A DuckDB datasource runs tenant SQL (initSql, model SQL, run-sql) inside the
// Cube process. The patches sandbox it:
// - creation: no extension downloads (the image ships the remote-data ones),
//   no community extensions, no persistent secrets, a private spill dir, and
//   only operator extensions whose file and network access goes through
//   DuckDB's own checks (sqlite/postgres/mysql scanners don't);
// - before any tenant SQL: operator S3 credentials move from readable
//   settings into a DuckDB secret; file access only inside the datasource's
//   own directory (plus operator remote prefixes,
//   CUBEJS_DB_DUCKDB_ALLOWED_PATHS); external access off; configuration
//   locked; it refuses to start if a disallowed extension is loaded or the
//   pod's files are reachable. Nothing loads after the lock: operators list
//   what tenants need (httpfs for S3/HTTP, excel, ...) in
//   CUBEJS_DB_DUCKDB_EXTENSIONS;
// - queries: no logging/profiling calls (the lock doesn't cover them).
const DUCKDB_SAFE_EXTENSIONS = "['httpfs', 'aws', 'azure', 'motherduck', 'excel', 'json', 'parquet', 'icu', 'fts', 'inet', 'tpch', 'tpcds', 'autocomplete', 'core_functions', 'jemalloc']";

const DUCKDB_CREATE_ORIGINAL = `        let dbOptions;
        if (token) {
            dbOptions = { custom_user_agent: \`Cube/\${version}\` };
        }
        const instance = await node_api_1.DuckDBInstance.create(dbUrl, dbOptions);`;

const DUCKDB_CREATE_PATCHED = `        const safeExtensions = ${DUCKDB_SAFE_EXTENSIONS};
        for (const name of [...((0, shared_1.getEnv)('duckdbExtensions', this.config) || []), ...((0, shared_1.getEnv)('duckdbCommunityExtensions', this.config) || [])]) {
            if (!safeExtensions.includes(String(name).toLowerCase())) {
                throw new Error(\`DuckDB: extension "\${name}" reads files or networks outside DuckDB's sandbox\`);
            }
        }
        const dbOptions = {
            ...(token ? { custom_user_agent: \`Cube/\${version}\` } : {}),
            autoinstall_known_extensions: 'false',
            allow_community_extensions: 'false',
            allow_persistent_secrets: 'false',
            temp_directory: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'duckdb-spill-')),
            // Every tenant's DuckDB shares the cube process and its disk:
            // bounded unless the operator raises them.
            memory_limit: process.env.CUBEJS_DB_DUCKDB_MEMORY_LIMIT || '1GB',
            threads: process.env.CUBEJS_DB_DUCKDB_THREADS || '2',
            max_temp_directory_size: process.env.CUBEJS_DB_DUCKDB_MAX_TEMP_DIRECTORY_SIZE || '4GB',
        };
        const instance = await node_api_1.DuckDBInstance.create(dbUrl, dbOptions);`;

const DUCKDB_ORIGINAL = `        if (this.config.initSql) {
            try {
                await execAsync(this.config.initSql);`;

const DUCKDB_PATCHED = `        const sqlLiteral = (v) => \`'\${String(v).replace(/'/g, "''")}'\`;
        const s3 = {
            KEY_ID: (0, shared_1.getEnv)('duckdbS3AccessKeyId', this.config),
            SECRET: (0, shared_1.getEnv)('duckdbS3SecretAccessKeyId', this.config),
            SESSION_TOKEN: (0, shared_1.getEnv)('duckdbS3SessionToken', this.config),
            REGION: (0, shared_1.getEnv)('duckdbS3Region', this.config),
            ENDPOINT: (0, shared_1.getEnv)('duckdbS3Endpoint', this.config),
            URL_STYLE: (0, shared_1.getEnv)('duckdbS3UrlStyle', this.config),
        };
        if (s3.KEY_ID || s3.SECRET || s3.SESSION_TOKEN) {
            const fields = Object.entries(s3).filter(([, v]) => v).map(([k, v]) => \`\${k} \${sqlLiteral(v)}\`);
            await execAsync(\`CREATE SECRET synmetrix_operator_s3 (TYPE s3, \${fields.join(', ')})\`);
            await execAsync('RESET s3_access_key_id; RESET s3_secret_access_key; RESET s3_session_token;');
        }
        const dbFile = this.config.databasePath;
        const allowed = [
            ...(dbFile && dbFile !== ':memory:' && !/^(md|motherduck):/i.test(dbFile)
                ? [\`\${require('path').dirname(dbFile)}/\`]
                : []),
            ...String(process.env.CUBEJS_DB_DUCKDB_ALLOWED_PATHS || '').split(',').map((p) => p.trim()).filter(Boolean),
        ];
        // DuckDB checks a remote prefix's path, not the host a secret's
        // ENDPOINT (or a redirect) sends it to: with a remote prefix allowed,
        // tenant SQL reaches whatever the pod can. Only with egress restricted.
        if (allowed.some((p) => /^[a-z][a-z0-9+.-]*:\\/\\//i.test(p)) && process.env.CUBEJS_DB_DUCKDB_EGRESS_RESTRICTED !== 'true') {
            throw new Error('DuckDB: remote prefixes need the cube pods\\' egress restricted (NetworkPolicy); then set CUBEJS_DB_DUCKDB_EGRESS_RESTRICTED=true');
        }
        // ponytail: a query-text filter can't see SQL built at run time
        // (query('...'||'...')), so logging can still be switched on to the
        // pod's stdout; a NetworkPolicy-free fix needs DuckDB to lock logging.
        if (/\\b(enable|disable)_(logging|profiling)\\b/i.test(String(this.config.initSql || ''))) {
            throw new Error('DuckDB: logging and profiling calls are not allowed');
        }
        // Nothing loads after the lock (the extension directory is out of
        // reach), so what is loaded now is all tenant SQL gets.
        const loaded = await connection.runAndReadAll("SELECT extension_name FROM duckdb_extensions() WHERE loaded");
        const unsafe = loaded.getRows().map(([name]) => name).filter((name) => !${DUCKDB_SAFE_EXTENSIONS}.includes(name));
        if (unsafe.length) {
            throw new Error(\`DuckDB: refusing tenant SQL with \${unsafe.join(', ')} loaded\`);
        }
        await execAsync(\`SET allowed_directories=[\${allowed.map(sqlLiteral).join(', ')}]; \` +
            "SET enable_external_access=false; " +
            "SET lock_configuration=true;");
        let podFilesReachable = true;
        try {
            await execAsync("SELECT 1 FROM read_text('/proc/self/environ')");
        }
        catch (e) {
            podFilesReachable = false;
        }
        if (podFilesReachable) {
            throw new Error('DuckDB: refusing tenant SQL while the pod\\'s files are reachable');
        }
        if (this.config.initSql) {
            try {
                await execAsync(this.config.initSql);`;

const DUCKDB_QUERY_ORIGINAL = `    async query(query, values = [], _options) {
        const { defaultConnection } = await this.getInitiatedState();`;

const DUCKDB_QUERY_PATCHED = `    async query(query, values = [], _options) {
        if (/\\b(enable|disable)_(logging|profiling)\\b/i.test(String(query))) {
            throw new Error('DuckDB: logging and profiling calls are not allowed');
        }
        const { defaultConnection } = await this.getInitiatedState();`;

const DUCKDB_STREAM_ORIGINAL = `    async stream(query, values, { highWaterMark }) {
        const { instance } = await this.getInitiatedState();`;

const DUCKDB_STREAM_PATCHED = `    async stream(query, values, { highWaterMark }) {
        if (/\\b(enable|disable)_(logging|profiling)\\b/i.test(String(query))) {
            throw new Error('DuckDB: logging and profiling calls are not allowed');
        }
        const { instance } = await this.getInitiatedState();`;

// SQLite's ATTACH opens any path the process can reach, beside the
// datasource's own file: no attached databases at all. An open failure
// (missing directory, unreadable file) is kept for the next query instead of
// being an unhandled 'error' event that takes the process down.
const SQLITE_ORIGINAL = `      this.config.db = new sqlite3.Database(this.config.database);`;

const SQLITE_PATCHED = `      this.opened = new Promise((resolve) => {
        this.config.db = new sqlite3.Database(this.config.database, (err) => {
          this.openError = err || null;
          resolve();
        });
      });
      this.config.db.configure('limit', sqlite3.LIMIT_ATTACHED, 0);`;

// With no ATTACH, Cube's in-source pre-aggregation path (CREATE SCHEMA =
// ATTACH) can't run; read-only makes Cube build rollups into Cube Store, and
// a pre-aggregation kept in the source gets a clear error. Queries wait for
// the open (and fail with its error), and refuse the pragmas that move
// SQLite's process-wide temp/data directories.
const SQLITE_READONLY_ORIGINAL = `  async testConnection() {`;

const SQLITE_READONLY_PATCHED = `  readOnly() {
    return true;
  }

  async testConnection() {`;

const SQLITE_QUERY_ORIGINAL = `  query(query, values) {
    return new Promise(
      (resolve, reject) => this.config.db.all(
        query,
        values || [],
        (err, result) => (err ? reject(err) : resolve(result))
      )
    );
  }`;

const SQLITE_QUERY_PATCHED = `  query(query, values) {
    if (/(temp_store_directory|data_store_directory|hard_heap_limit|soft_heap_limit)/i.test(String(query))) {
      return Promise.reject(new Error('SQLite: pragmas that change process-wide settings are not allowed'));
    }
    return Promise.resolve(this.opened).then(() => {
      if (this.openError) throw this.openError;
      return new Promise(
        (resolve, reject) => this.config.db.all(
          query,
          values || [],
          (err, result) => (err ? reject(err) : resolve(result))
        )
      );
    });
  }`;

const SQLITE_RELEASE_ORIGINAL = `  async release() {
    await new Promise((resolve, reject) => this.config.db.close((err) => (err ? reject(err) : resolve())));
  }`;

// A database that never opened has nothing to close (close() would never call back).
const SQLITE_RELEASE_PATCHED = `  async release() {
    await this.opened;
    if (this.openError) return;
    await new Promise((resolve, reject) => this.config.db.close((err) => (err ? reject(err) : resolve())));
  }`;

const SQLITE_SCHEMA_ORIGINAL = `    return this.query(
      'PRAGMA database_list'
    ).then((schemas) => {`;

const SQLITE_SCHEMA_PATCHED = `    if (schemaName) {
      return Promise.reject(new Error('SQLite pre-aggregations must be external (built into Cube Store): set external: true'));
    }
    return this.query(
      'PRAGMA database_list'
    ).then((schemas) => {`;

// node-java runs one JVM per process, whose class path is set by the first
// JDBC-family driver to connect. Databricks adds the operator's driver jars
// (CUBEJS_JDBC_DRIVERS_DIR) to its own, and generic JDBC gets the same set
// (confineDbParams), so either works whichever connected first.
const DATABRICKS_CLASSPATH_ORIGINAL = `    async getCustomClassPath() {
        return (0, installer_1.resolveJDBCDriver)();
    }`;

const DATABRICKS_CLASSPATH_PATCHED = `    async getCustomClassPath() {
        const dir = require('path').resolve(process.env.CUBEJS_JDBC_DRIVERS_DIR || '/app/jdbc-drivers');
        let shared = [];
        try {
            shared = require('fs').readdirSync(dir).filter((f) => f.endsWith('.jar')).sort().map((f) => require('path').join(dir, f));
        }
        catch (e) {
            shared = [];
        }
        return [await (0, installer_1.resolveJDBCDriver)(), ...shared];
    }`;
// Firebolt reads its login from server env before the datasource's own
// connection; with no CUBEJS_DB_USER it crashed on undefined.includes(), so no
// Firebolt datasource could connect. The datasource's connection.auth applies.
const FIREBOLT_ORIGINAL = `        const username = (0, shared_1.getEnv)('dbUser', { dataSource, preAggregations });`;

const FIREBOLT_PATCHED = `        const username = (0, shared_1.getEnv)('dbUser', { dataSource, preAggregations }) || '';`;

const occurrences = (source, value) => source.split(value).length - 1;

function applyPatch(source, original, patched, label, expected = 1) {
  if (source.includes(patched)) return { source, changed: false };
  if (occurrences(source, original) !== expected) {
    throw new Error(
      `Refusing to patch Cube ${label}: expected source anchor was not found exactly ${expected === 1 ? "once" : `${expected} times`}`,
    );
  }
  return { source: source.replaceAll(original, patched), changed: true };
}

export function patchCompilerSource(source) {
  return applyPatch(source, ORIGINAL, PATCHED, "YAML compiler");
}

export function patchBigQueryDriverSource(source) {
  return applyPatch(source, BIGQUERY_ORIGINAL, BIGQUERY_PATCHED, "BigQuery driver");
}

export function patchBigQueryDownloadSource(source) {
  return applyPatch(source, BIGQUERY_DOWNLOAD_ORIGINAL, BIGQUERY_DOWNLOAD_PATCHED, "BigQuery read-only download");
}

const applyPatches = (source, patches) =>
  patches.reduce(
    (acc, [original, patched, label]) => {
      const next = applyPatch(acc.source, original, patched, label);
      return { source: next.source, changed: acc.changed || next.changed };
    },
    { source, changed: false },
  );

export function patchDuckDbDriverSource(source) {
  return applyPatches(source, [
    [DUCKDB_CREATE_ORIGINAL, DUCKDB_CREATE_PATCHED, "DuckDB driver creation sandbox"],
    [DUCKDB_ORIGINAL, DUCKDB_PATCHED, "DuckDB driver lockdown"],
    [DUCKDB_QUERY_ORIGINAL, DUCKDB_QUERY_PATCHED, "DuckDB driver query filter"],
    [DUCKDB_STREAM_ORIGINAL, DUCKDB_STREAM_PATCHED, "DuckDB driver stream filter"],
  ]);
}

export function patchSqliteDriverSource(source) {
  return applyPatches(source, [
    [SQLITE_ORIGINAL, SQLITE_PATCHED, "SQLite driver attach limit"],
    [SQLITE_READONLY_ORIGINAL, SQLITE_READONLY_PATCHED, "SQLite driver read-only"],
    [SQLITE_QUERY_ORIGINAL, SQLITE_QUERY_PATCHED, "SQLite driver query filter"],
    [SQLITE_SCHEMA_ORIGINAL, SQLITE_SCHEMA_PATCHED, "SQLite driver in-source pre-aggregations"],
    [SQLITE_RELEASE_ORIGINAL, SQLITE_RELEASE_PATCHED, "SQLite driver release"],
  ]);
}

export function patchDatabricksClassPathSource(source) {
  return applyPatch(source, DATABRICKS_CLASSPATH_ORIGINAL, DATABRICKS_CLASSPATH_PATCHED, "Databricks driver class path");
}

export function patchFireboltDriverSource(source) {
  return applyPatch(source, FIREBOLT_ORIGINAL, FIREBOLT_PATCHED, "Firebolt driver env login");
}

export function patchPreAggregationLoaderSource(source) {
  return applyPatch(source, LOADER_ORIGINAL, LOADER_PATCHED, "pre-aggregation loader", 2);
}

async function supportedPackageRoot(name) {
  const packageJsonPath = require.resolve(`${name}/package.json`);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Refusing to patch ${name} ${packageJson.version}; expected ${SUPPORTED_VERSION}`,
    );
  }
  return dirname(packageJsonPath);
}

async function patchFile(path, patch) {
  const current = await readFile(path, "utf8");
  const result = patch(current);
  if (result.changed) await writeFile(path, result.source, "utf8");
  return result.changed;
}

export async function patchInstalledCompiler() {
  const root = await supportedPackageRoot(COMPILER_PACKAGE);
  const compilerPath = resolve(root, "dist/src/compiler/YamlCompiler.js");
  const yamlChanged = await patchFile(compilerPath, patchCompilerSource);
  const bigQueryPath = resolve(
    await supportedPackageRoot(BIGQUERY_PACKAGE),
    "dist/src/BigQueryDriver.js",
  );
  const bigQueryChanged = await patchFile(bigQueryPath, (source) => {
    const stream = patchBigQueryDriverSource(source);
    const download = patchBigQueryDownloadSource(stream.source);
    return { source: download.source, changed: stream.changed || download.changed };
  });
  const loaderPath = resolve(
    await supportedPackageRoot(ORCHESTRATOR_PACKAGE),
    "dist/src/orchestrator/PreAggregationLoader.js",
  );
  const loaderChanged = await patchFile(loaderPath, patchPreAggregationLoaderSource);
  const duckDbPath = resolve(
    await supportedPackageRoot(DUCKDB_PACKAGE),
    "dist/src/DuckDBDriver.js",
  );
  const duckDbChanged = await patchFile(duckDbPath, patchDuckDbDriverSource);
  const sqlitePath = resolve(
    await supportedPackageRoot(SQLITE_PACKAGE),
    "driver/SqliteDriver.js",
  );
  const sqliteChanged = await patchFile(sqlitePath, patchSqliteDriverSource);
  const databricksPath = resolve(
    await supportedPackageRoot(DATABRICKS_PACKAGE),
    "dist/src/DatabricksDriver.js",
  );
  const databricksChanged = await patchFile(databricksPath, patchDatabricksClassPathSource);
  const fireboltPath = resolve(
    await supportedPackageRoot(FIREBOLT_PACKAGE),
    "dist/src/FireboltDriver.js",
  );
  const fireboltChanged = await patchFile(fireboltPath, patchFireboltDriverSource);
  return {
    compilerPath,
    bigQueryPath,
    loaderPath,
    duckDbPath,
    sqlitePath,
    databricksPath,
    fireboltPath,
    changed: yamlChanged || bigQueryChanged || loaderChanged || duckDbChanged || sqliteChanged || databricksChanged || fireboltChanged,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await patchInstalledCompiler();
  console.log(
    result.changed
      ? `Patched Cube ${SUPPORTED_VERSION} YAML metadata handling + stream error forwarding + BigQuery read-only types + DuckDB lockdown + SQLite attach limit + JDBC class path + Firebolt env login`
      : `Cube ${SUPPORTED_VERSION} YAML metadata + stream error forwarding + BigQuery read-only type + DuckDB lockdown + SQLite attach limit + JDBC class path + Firebolt env login patches already applied`,
  );
}
