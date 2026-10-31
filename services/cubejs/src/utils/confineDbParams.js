import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";

// Datasource params come from the tenant (Hasura lets team members write
// `datasources.db_params`). Every database type stays available; these rules
// take away only the settings that reach this pod or other tenants. The
// DuckDB sandbox and the SQLite limits are patched into the drivers
// themselves (scripts/patchCubeYamlCompiler.mjs), since tenant SQL runs there.

// Local database files (DuckDB, SQLite) live in a directory of their own per
// datasource: <root>/<datasource id>/. DuckDB is sandboxed to that directory.
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

const localFile = (dbType, file, dataSourceId) => {
  if (!dataSourceId) refuse(dbType, "a local database file needs a datasource id");
  const dir = path.join(localDbRoot(), String(dataSourceId));
  return insideDir(dir, file) || refuse(dbType, `database files must be under ${dir}`);
};

// JDBC URLs that start a database inside our JVM rather than connecting to
// one. Drivers match their URL prefix case-sensitively, so only the exact
// network forms pass.
const isInProcessJdbcUrl = (url) => {
  const u = String(url).trim();
  if (/^jdbc:(sqlite|duckdb):/i.test(u)) return true;
  if (/^jdbc:derby:/i.test(u)) return !u.startsWith("jdbc:derby://");
  if (/^jdbc:hsqldb:/i.test(u)) return !/^jdbc:hsqldb:(hsqls?|https?):\/\//.test(u);
  if (/^jdbc:h2:/i.test(u)) return !/^jdbc:h2:(tcp|ssl):\/\//.test(u);
  return false;
};

// IPv4-mapped IPv6 (::ffff:1.2.3.4, or ::ffff:102:304 once a URL normalises
// it) is the IPv4 address it maps.
const unmapped = (address) => {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return address;
  const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
};

const addresses = async (host) => {
  try {
    return (await lookup(host, { all: true })).map((a) => unmapped(a.address));
  } catch {
    return [];
  }
};

const confineDuckDb = (params, { dataSourceId }) => {
  // The credential chain hands tenant SQL this pod's own AWS credentials.
  const { duckdbS3UseCredentialChain, ...rest } = params;
  const file = rest.databasePath;
  if (file && file !== ":memory:" && !/^(md|motherduck):/i.test(file)) {
    rest.databasePath = localFile("duckdb", file, dataSourceId);
  }
  return rest;
};

const confineSqlite = (params, { dataSourceId }) => {
  if (!params.database) refuse("sqlite", "database file is required");
  return params.database === ":memory:"
    ? params
    : { ...params, database: localFile("sqlite", params.database, dataSourceId) };
};

const confineJdbc = (params) => {
  if (params.url && isInProcessJdbcUrl(params.url)) {
    refuse("jdbc", "in-process database URLs are not allowed");
  }
  if (params.customClassPath == null) return params;
  const dir = jdbcDriversDir();
  const entries = [params.customClassPath].flat().map((entry) => {
    // One entry, one jar: a class-path separator would add others.
    if (/[:;]/.test(String(entry))) refuse("jdbc", "one jar per class-path entry");
    return insideDir(dir, entry) || refuse("jdbc", `driver jars must be under ${dir}`);
  });
  return { ...params, customClassPath: entries };
};

const confineDatabricks = (params) => {
  // The driver pins its own driver class and class path; the URL is the rest.
  if (!params.url) return params;
  const url = String(params.url);
  if (!/^jdbc:(databricks|spark):\/\//i.test(url)) {
    refuse("databricks-jdbc", "url must be a jdbc:databricks:// URL");
  }
  // Driver logging settings make the JVM-wide driver write files on this pod
  // and trace every tenant's connections.
  if (/;\s*log(path|level|filecount|filesize)\s*=/i.test(url)) {
    refuse("databricks-jdbc", "driver logging settings are not allowed in the url");
  }
  return params;
};

// Addresses inside the cluster or on this host: our CubeStore (by service,
// pod or headless name), the pod itself, and every other internal service.
const PRIVATE = new BlockList();
for (const [net, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16], ["100.64.0.0", 10], ["0.0.0.0", 8]]) {
  PRIVATE.addSubnet(net, bits, "ipv4");
}
// NAT64 and 6to4 addresses embed an IPv4 address, private ones included.
for (const [net, bits] of [["::1", 128], ["fc00::", 7], ["fe80::", 10], ["::", 128], ["64:ff9b::", 96], ["2002::", 16]]) {
  PRIVATE.addSubnet(net, bits, "ipv6");
}
const isPrivate = (address) =>
  isIP(address) === 4 ? PRIVATE.check(address, "ipv4") : PRIVATE.check(address, "ipv6");

// The CubeStore driver speaks websockets; http(s) URLs mean the same thing.
const WS_PROTOCOLS = { "ws:": "ws:", "http:": "ws:", "wss:": "wss:", "https:": "wss:" };

// Our own CubeStore holds every tenant's pre-aggregations and has no auth.
// Its driver falls back to it when no host is given, so a host is required,
// and the store must sit on a public address unless the operator allows
// private networks (CUBEJS_CUBESTORE_DATASOURCE_ALLOW_PRIVATE=true, on-prem).
// Then ours is refused by name and service address, not by pod or endpoint
// address: an operator who allows private networks must keep tenants off the
// store's pods with a NetworkPolicy. Plain connections are pinned to the
// address checked here.
const confineCubeStore = async (params) => {
  let target = null;
  if (params.url) {
    const raw = String(params.url);
    const protocol = WS_PROTOCOLS[new URL(raw).protocol];
    if (!protocol) refuse("cubestore", "url must be ws://, wss://, http:// or https://");
    target = new URL(protocol + raw.slice(raw.indexOf(":") + 1));
  }
  const host = target ? target.hostname.replace(/^\[|\]$/g, "") : params.host;
  if (!host) refuse("cubestore", "host is required");
  const ours = process.env.CUBEJS_CUBESTORE_HOST;
  const ownStore = () => refuse("cubestore", "this deployment's own Cube Store cannot be a datasource");
  if (ours && String(host).toLowerCase().startsWith(ours.toLowerCase().split(".")[0])) ownStore();
  const theirAddresses = await addresses(host);
  if (!theirAddresses.length) refuse("cubestore", `cannot resolve ${host}`);
  if (ours) {
    const ourAddresses = new Set(await addresses(ours));
    if (theirAddresses.some((a) => ourAddresses.has(a))) ownStore();
  }
  if (
    process.env.CUBEJS_CUBESTORE_DATASOURCE_ALLOW_PRIVATE !== "true" &&
    theirAddresses.some(isPrivate)
  ) {
    refuse("cubestore", `${host} is on a private network`);
  }
  const pinned = theirAddresses[0];
  const bracketed = isIP(pinned) === 6 ? `[${pinned}]` : pinned;
  if (!target) return { ...params, host: bracketed };
  // TLS needs the name to verify the certificate, and a rebind to a plain
  // websocket store fails the handshake; every plain connection is pinned.
  if (target.protocol === "ws:") target.hostname = bracketed;
  return { ...params, url: target.toString() };
};

const CONFINE = {
  duckdb: confineDuckDb,
  sqlite: confineSqlite,
  jdbc: confineJdbc,
  "databricks-jdbc": confineDatabricks,
  cubestore: confineCubeStore,
};

export default async function confineDbParams(dbType, params, scope = {}) {
  const confine = CONFINE[dbType];
  return confine ? confine({ ...params }, scope) : params;
}
