import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";

// Datasource params come from the tenant (Hasura lets team members write
// `datasources.db_params`). Every database type stays available; these rules
// take away only the settings that reach this pod or other tenants. The
// DuckDB lockdown and the SQLite attach limit are patched into the drivers
// themselves (scripts/patchCubeYamlCompiler.mjs), since tenant SQL runs there.

// Local database files (DuckDB, SQLite) must live under this directory. It is
// shared by every datasource on the deployment: mount files here only where
// tenants may read each other's files (single-tenant / on-prem installs).
const localDbRoot = () =>
  path.resolve(process.env.CUBEJS_LOCAL_DB_ROOT || "/data/local-db");

// Generic JDBC loads driver jars from here only. The image's node_modules
// holds Derby and HSQLDB jars, which run an in-process database (and Java
// stored procedures) inside our JVM.
const jdbcDriversDir = () =>
  path.resolve(process.env.CUBEJS_JDBC_DRIVERS_DIR || "/app/jdbc-drivers");

const refuse = (dbType, why) => {
  throw new Error(`${dbType} datasource refused: ${why}`);
};

const insideDir = (dir, file) => {
  const resolved = path.resolve(dir, String(file));
  return resolved.startsWith(dir + path.sep) ? resolved : null;
};

const localFile = (dbType, file) => {
  const root = localDbRoot();
  return (
    insideDir(root, file) ||
    refuse(dbType, `database files must be under ${root}`)
  );
};

// JDBC URLs that start a database inside our JVM rather than connecting to one.
const IN_PROCESS_JDBC_URL =
  /^jdbc:(derby:(?!\/\/)|hsqldb:(?!(hsqls?|https?):\/\/)|h2:(?!(tcp|ssl):)|sqlite:|duckdb:)/i;

const addresses = async (host) => {
  try {
    return (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
};

const confineDuckDb = (params) => {
  // The credential chain hands tenant SQL this pod's own AWS credentials.
  const { duckdbS3UseCredentialChain, ...rest } = params;
  const file = rest.databasePath;
  if (file && file !== ":memory:" && !/^(md|motherduck):/i.test(file)) {
    rest.databasePath = localFile("duckdb", file);
  }
  return rest;
};

const confineSqlite = (params) => {
  if (!params.database) refuse("sqlite", "database file is required");
  return params.database === ":memory:"
    ? params
    : { ...params, database: localFile("sqlite", params.database) };
};

const confineJdbc = (params) => {
  if (params.url && IN_PROCESS_JDBC_URL.test(String(params.url))) {
    refuse("jdbc", "in-process database URLs are not allowed");
  }
  if (params.customClassPath == null) return params;
  const dir = jdbcDriversDir();
  const entries = [params.customClassPath].flat().map((entry) =>
    insideDir(dir, entry) || refuse("jdbc", `driver jars must be under ${dir}`),
  );
  return { ...params, customClassPath: entries };
};

const confineDatabricks = (params) => {
  // The driver pins its own driver class and class path; the URL is the rest.
  if (params.url && !/^jdbc:(databricks|spark):\/\//i.test(String(params.url))) {
    refuse("databricks-jdbc", "url must be a jdbc:databricks:// URL");
  }
  return params;
};

// Addresses inside the cluster or on this host: our CubeStore (by service,
// pod or headless name), the pod itself, and every other internal service.
const PRIVATE = new BlockList();
for (const [net, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16], ["100.64.0.0", 10], ["0.0.0.0", 8]]) {
  PRIVATE.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [["::1", 128], ["fc00::", 7], ["fe80::", 10], ["::", 128]]) {
  PRIVATE.addSubnet(net, bits, "ipv6");
}
const isPrivate = (address) => {
  const v4 = address.replace(/^::ffff:/i, "");
  return isIP(v4) === 4 ? PRIVATE.check(v4, "ipv4") : PRIVATE.check(address, "ipv6");
};

// Our own CubeStore holds every tenant's pre-aggregations and has no auth.
// Its driver falls back to it when no host is given, so a host is required,
// and the store must sit on a public address unless the operator allows
// private networks (CUBEJS_CUBESTORE_DATASOURCE_ALLOW_PRIVATE=true, on-prem);
// ours is refused either way. The connection is pinned to the address checked.
const confineCubeStore = async (params) => {
  const target = params.url ? new URL(String(params.url)) : null;
  const host = target ? target.hostname.replace(/^\[|\]$/g, "") : params.host;
  if (!host) refuse("cubestore", "host is required");
  const ours = process.env.CUBEJS_CUBESTORE_HOST;
  const ownStore = () => refuse("cubestore", "this deployment's own Cube Store cannot be a datasource");
  if (ours && String(host).toLowerCase().startsWith(ours.toLowerCase().split(".")[0])) ownStore();
  const theirAddresses = await addresses(host);
  if (!theirAddresses.length) refuse("cubestore", `cannot resolve ${host}`);
  if (ours) {
    const ourAddresses = new Set(await addresses(ours));
    if (theirAddresses.some((a) => ourAddresses.has(a))) {
      ownStore();
    }
  }
  if (
    process.env.CUBEJS_CUBESTORE_DATASOURCE_ALLOW_PRIVATE !== "true" &&
    theirAddresses.some(isPrivate)
  ) {
    refuse("cubestore", `${host} is on a private network`);
  }
  const pinned = theirAddresses[0];
  if (!target) return { ...params, host: pinned };
  // TLS needs the name to verify the certificate; a rebind to a plain
  // websocket store fails the handshake, so only plain ws is pinned.
  if (target.protocol === "ws:") target.hostname = isIP(pinned) === 6 ? `[${pinned}]` : pinned;
  return { ...params, url: target.toString() };
};

const CONFINE = {
  duckdb: confineDuckDb,
  sqlite: confineSqlite,
  jdbc: confineJdbc,
  "databricks-jdbc": confineDatabricks,
  cubestore: confineCubeStore,
};

export default async function confineDbParams(dbType, params) {
  const confine = CONFINE[dbType];
  return confine ? confine({ ...params }) : params;
}
