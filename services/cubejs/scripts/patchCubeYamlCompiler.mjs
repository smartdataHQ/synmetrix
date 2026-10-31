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
// Cube process. Two patches sandbox it. At creation: no extension auto-install
// or auto-load (a sqlite-format database file would otherwise pull in the
// sqlite extension, whose file access DuckDB's own checks don't cover) and a
// private spill directory. Before any tenant SQL: file access only inside the
// datasource's own directory (plus operator-listed remote prefixes,
// CUBEJS_DB_DUCKDB_ALLOWED_PATHS), external access off, configuration locked
// -- and it refuses to start unless the pod's files are out of reach.
const DUCKDB_CREATE_ORIGINAL = `        let dbOptions;
        if (token) {
            dbOptions = { custom_user_agent: \`Cube/\${version}\` };
        }
        const instance = await node_api_1.DuckDBInstance.create(dbUrl, dbOptions);`;

const DUCKDB_CREATE_PATCHED = `        const dbOptions = {
            ...(token ? { custom_user_agent: \`Cube/\${version}\` } : {}),
            autoinstall_known_extensions: 'false',
            autoload_known_extensions: 'false',
            allow_community_extensions: 'false',
            temp_directory: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'duckdb-spill-')),
        };
        const instance = await node_api_1.DuckDBInstance.create(dbUrl, dbOptions);`;

const DUCKDB_ORIGINAL = `        if (this.config.initSql) {
            try {
                await execAsync(this.config.initSql);`;

const DUCKDB_PATCHED = `        const dbFile = this.config.databasePath;
        const allowed = [
            ...(dbFile && dbFile !== ':memory:' && !/^(md|motherduck):/i.test(dbFile)
                ? [\`\${require('path').dirname(dbFile)}/\`]
                : []),
            ...String(process.env.CUBEJS_DB_DUCKDB_ALLOWED_PATHS || '').split(',').map((p) => p.trim()).filter(Boolean),
        ];
        const quote = (p) => \`'\${p.replace(/'/g, "''")}'\`;
        await execAsync(\`SET allowed_directories=[\${allowed.map(quote).join(', ')}]; \` +
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

// SQLite's ATTACH opens any path the process can reach, beside the
// datasource's own file. No attached databases at all.
const SQLITE_ORIGINAL = `      this.config.db = new sqlite3.Database(this.config.database);`;

const SQLITE_PATCHED = `      this.config.db = new sqlite3.Database(this.config.database);
      this.config.db.configure('limit', sqlite3.LIMIT_ATTACHED, 0);`;

// With no ATTACH, Cube's in-source pre-aggregation path (CREATE SCHEMA =
// ATTACH) can't run; read-only makes Cube build rollups from query results
// into Cube Store instead.
const SQLITE_READONLY_ORIGINAL = `  async testConnection() {`;

const SQLITE_READONLY_PATCHED = `  readOnly() {
    return true;
  }

  async testConnection() {`;

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

export function patchDuckDbDriverSource(source) {
  const create = applyPatch(source, DUCKDB_CREATE_ORIGINAL, DUCKDB_CREATE_PATCHED, "DuckDB driver creation sandbox");
  const lock = applyPatch(create.source, DUCKDB_ORIGINAL, DUCKDB_PATCHED, "DuckDB driver lockdown");
  return { source: lock.source, changed: create.changed || lock.changed };
}

export function patchSqliteDriverSource(source) {
  const attach = applyPatch(source, SQLITE_ORIGINAL, SQLITE_PATCHED, "SQLite driver attach limit");
  const readOnly = applyPatch(attach.source, SQLITE_READONLY_ORIGINAL, SQLITE_READONLY_PATCHED, "SQLite driver read-only");
  return { source: readOnly.source, changed: attach.changed || readOnly.changed };
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
  return {
    compilerPath,
    bigQueryPath,
    loaderPath,
    duckDbPath,
    sqlitePath,
    changed: yamlChanged || bigQueryChanged || loaderChanged || duckDbChanged || sqliteChanged,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await patchInstalledCompiler();
  console.log(
    result.changed
      ? `Patched Cube ${SUPPORTED_VERSION} YAML metadata handling + stream error forwarding + BigQuery read-only types + DuckDB lockdown + SQLite attach limit`
      : `Cube ${SUPPORTED_VERSION} YAML metadata + stream error forwarding + BigQuery read-only type + DuckDB lockdown + SQLite attach limit patches already applied`,
  );
}
