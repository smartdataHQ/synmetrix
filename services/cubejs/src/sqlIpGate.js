import http from "node:http";
import net from "node:net";
import {
  deriveAudvitadSqlSecret,
  isAudvitadSqlLogin,
  signProxyPasswordEnvelope,
} from "./utils/audvitadSqlAuth.js";

// Lightweight sidecar inside the `synmetrix-sql-tls-proxy` pod (127.0.0.1:15434).
//
// Traffic flow:
//   Client -> rke2-ingress-nginx (:5432, proxy_protocol on)
//          -> Envoy (proxy_protocol + PostgreSQL STARTTLS TLS 1.2+, upstream proxy_protocol)
//          -> sqlIpGate (127.0.0.1:15434)
//          -> synmetrix-cubejs:15432
//
// Because Cube Core's Rust PostgreSQL wire server does not expose the client TCP peer
// address to `checkSqlAuth(request, user, password)`, sqlIpGate reads the verified client
// source IP from Envoy's PROXY protocol header, inspects the PostgreSQL v3.0 StartupMessage
// (`user`, `database`), and — for Auðvitað/QuickLookup `ql_*` logins — wraps ONLY the
// client's `PasswordMessage` (`'p'`) in an HMAC-SHA256 signed envelope carrying
// `(clientIp, database, timestamp)` before handing the socket off to raw zero-copy piping.
//
// `synmetrix-cubejs` (`audvitadSqlAuth.js`) verifies the HMAC + timestamp freshness and
// rejects any `ql_*` login arriving without a valid proxy signature (closing direct :15432
// bypasses). Non-`ql_*` internal Synmetrix logins pass through completely untouched.

const PROXY_V2_SIG = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);
const PG_CANCEL_CODE = 80877102;
const PG_SSL_REQUEST_CODE = 80877103;
const PG_PROTOCOL_V3 = 196608;
const MAX_STARTUP_BYTES = 16384;
const MAX_PASSWORD_MSG_BYTES = 8192;
const HANDSHAKE_TIMEOUT_MS = 15000;

export function normalizeClientIp(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) {
    return s.slice(7);
  }
  return s.toLowerCase();
}

function formatIpv6Bytes(buf) {
  // Check IPv4-mapped ::ffff:a.b.c.d
  let isV4Mapped = true;
  for (let i = 0; i < 10; i++) {
    if (buf[i] !== 0) {
      isV4Mapped = false;
      break;
    }
  }
  if (isV4Mapped && buf[10] === 0xff && buf[11] === 0xff) {
    return `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;
  }
  const groups = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(buf.readUInt16BE(i).toString(16));
  }
  return groups.join(":");
}

/**
 * Attempts to parse a PROXY protocol v1 or v2 header from `buf`.
 * Returns:
 *   - `{ status: "need_more" }` if more bytes are needed
 *   - `{ status: "ok", clientIp: string | null, consumed: number }` on success
 *   - `{ status: "invalid", reason: string }` on malformed input
 */
export function parseProxyHeader(buf) {
  if (buf.length < 6) return { status: "need_more" };

  // PROXY v2 binary header
  if (buf.length >= 12 && buf.subarray(0, 12).equals(PROXY_V2_SIG)) {
    if (buf.length < 16) return { status: "need_more" };
    const verCmd = buf[12];
    if ((verCmd & 0xf0) !== 0x20) {
      return { status: "invalid", reason: "unsupported PROXY v2 version" };
    }
    const cmd = verCmd & 0x0f;
    const fam = buf[13];
    const addrLen = buf.readUInt16BE(14);
    const total = 16 + addrLen;
    if (total > 4096) {
      return { status: "invalid", reason: "PROXY v2 header too large" };
    }
    if (buf.length < total) return { status: "need_more" };
    if (cmd === 0x00) {
      // LOCAL command (e.g. health check)
      return { status: "ok", clientIp: null, consumed: total };
    }
    if (cmd !== 0x01) {
      return { status: "invalid", reason: "unsupported PROXY v2 command" };
    }
    const family = fam & 0xf0;
    if (family === 0x10 && addrLen >= 12) {
      // AF_INET (IPv4): 4 bytes src, 4 bytes dst, 2 bytes sport, 2 bytes dport
      const ip = `${buf[16]}.${buf[17]}.${buf[18]}.${buf[19]}`;
      return { status: "ok", clientIp: ip, consumed: total };
    }
    if (family === 0x20 && addrLen >= 36) {
      // AF_INET6 (IPv6): 16 bytes src, 16 bytes dst, 2 bytes sport, 2 bytes dport
      const ip = formatIpv6Bytes(buf.subarray(16, 32));
      return { status: "ok", clientIp: normalizeClientIp(ip), consumed: total };
    }
    return { status: "ok", clientIp: null, consumed: total };
  }

  // Could still be a partial v2 signature
  if (buf.length < 12 && PROXY_V2_SIG.subarray(0, buf.length).equals(buf)) {
    return { status: "need_more" };
  }

  // PROXY v1 text header: "PROXY TCP4 <src> <dst> <sport> <dport>\r\n"
  if (buf.subarray(0, 6).toString("ascii") === "PROXY ") {
    const crlf = buf.indexOf("\r\n");
    if (crlf === -1) {
      if (buf.length > 108) {
        return { status: "invalid", reason: "PROXY v1 header exceeds 108 bytes" };
      }
      return { status: "need_more" };
    }
    const line = buf.subarray(0, crlf).toString("ascii");
    const parts = line.split(" ");
    if (parts[1] === "UNKNOWN") {
      return { status: "ok", clientIp: null, consumed: crlf + 2 };
    }
    if ((parts[1] === "TCP4" || parts[1] === "TCP6") && parts.length === 6) {
      return {
        status: "ok",
        clientIp: normalizeClientIp(parts[2]),
        consumed: crlf + 2,
      };
    }
    return { status: "invalid", reason: "malformed PROXY v1 line" };
  }

  return { status: "invalid", reason: "missing PROXY protocol header" };
}

/**
 * Parses a PostgreSQL StartupMessage / CancelRequest / SSLRequest packet from `buf`.
 */
export function parsePgStartup(buf) {
  if (buf.length < 8) return { status: "need_more" };
  const len = buf.readInt32BE(0);
  if (len < 8 || len > MAX_STARTUP_BYTES) {
    return { status: "invalid", reason: `invalid PostgreSQL startup length ${len}` };
  }
  if (buf.length < len) return { status: "need_more" };
  const code = buf.readInt32BE(4);
  const packet = buf.subarray(0, len);
  if (code === PG_SSL_REQUEST_CODE) {
    return { status: "ssl_request", packet, consumed: len };
  }
  if (code === PG_CANCEL_CODE) {
    return { status: "cancel", packet, consumed: len };
  }
  if (code !== PG_PROTOCOL_V3) {
    return { status: "invalid", reason: `unsupported PG protocol code ${code}` };
  }
  const params = {};
  let offset = 8;
  while (offset < len - 1) {
    const kEnd = buf.indexOf(0, offset);
    if (kEnd === -1 || kEnd >= len) break;
    if (kEnd === offset) break; // final terminating NUL
    const key = buf.subarray(offset, kEnd).toString("utf8");
    const vStart = kEnd + 1;
    const vEnd = buf.indexOf(0, vStart);
    if (vEnd === -1 || vEnd >= len) break;
    const val = buf.subarray(vStart, vEnd).toString("utf8");
    params[key] = val;
    offset = vEnd + 1;
  }
  return { status: "startup", packet, params, consumed: len };
}

export function buildPgPasswordPacket(password) {
  const pwBuf = Buffer.from(password, "utf8");
  const totalPayload = 4 + pwBuf.length + 1;
  const out = Buffer.allocUnsafe(1 + totalPayload);
  out[0] = 0x70; // 'p' PasswordMessage
  out.writeInt32BE(totalPayload, 1);
  pwBuf.copy(out, 5);
  out[5 + pwBuf.length] = 0;
  return out;
}

export function createSqlIpGateServer({
  upstreamHost = process.env.SQL_IP_GATE_UPSTREAM_HOST || "synmetrix-cubejs",
  upstreamPort = Number(process.env.SQL_IP_GATE_UPSTREAM_PORT || 15432),
  requireProxyProtocol = process.env.SQL_IP_GATE_REQUIRE_PROXY_PROTOCOL !== "false",
  env = process.env,
  logger = console,
} = {}) {
  const secret = deriveAudvitadSqlSecret(env);
  if (!secret) {
    throw new Error("SQL_IP_GATE requires SQL_AUTH_SECRET or TOKEN_SECRET");
  }

  return net.createServer((client) => {
    client.setNoDelay(true);
    let upstream = null;
    let state = requireProxyProtocol ? "proxy" : "startup";
    let clientIp = requireProxyProtocol ? null : normalizeClientIp(client.remoteAddress || "");
    let startupUser = "";
    let startupDb = "";
    let buf = Buffer.alloc(0);
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      client.setTimeout(0);
      if (upstream && !upstream.destroyed) upstream.destroy();
      if (!client.destroyed) client.destroy();
    };

    client.setTimeout(HANDSHAKE_TIMEOUT_MS, () => cleanup());
    client.on("error", cleanup);
    client.on("close", cleanup);

    const switchToPipe = (extraClientBytes) => {
      state = "piping";
      client.setTimeout(0);
      client.removeListener("data", onClientData);
      if (extraClientBytes && extraClientBytes.length > 0 && upstream && !upstream.destroyed) {
        upstream.write(extraClientBytes);
      }
      if (upstream && !upstream.destroyed && !client.destroyed) {
        client.pipe(upstream);
      }
    };

    const connectUpstream = (initialPacket, interceptPassword, remainingBytes) => {
      upstream = net.createConnection({ host: upstreamHost, port: upstreamPort });
      upstream.setNoDelay(true);
      upstream.on("error", cleanup);
      upstream.on("close", cleanup);
      upstream.pipe(client);
      upstream.write(initialPacket);

      if (!interceptPassword) {
        switchToPipe(remainingBytes);
        return;
      }

      state = "password";
      buf = remainingBytes;
      if (buf.length > 0) {
        processPasswordBuffer();
      }
    };

    const processPasswordBuffer = () => {
      if (state !== "password" || buf.length < 5) return;
      const msgType = buf[0];
      const msgLen = buf.readInt32BE(1);
      // 'p' (0x70) = PasswordMessage. Anything else (e.g. 'X' Terminate) passes straight through.
      if (msgType !== 0x70) {
        const rest = buf;
        buf = Buffer.alloc(0);
        switchToPipe(rest);
        return;
      }
      if (msgLen < 5 || msgLen > MAX_PASSWORD_MSG_BYTES) {
        cleanup();
        return;
      }
      if (buf.length < 1 + msgLen) return;
      const rawBuf = buf.subarray(5, 1 + msgLen);
      const nulIdx = rawBuf.indexOf(0);
      const rawPassword = (nulIdx >= 0 ? rawBuf.subarray(0, nulIdx) : rawBuf).toString("utf8");
      const rest = buf.subarray(1 + msgLen);
      buf = Buffer.alloc(0);

      const signedPassword = signProxyPasswordEnvelope(
        {
          username: startupUser,
          clientIp: clientIp || "",
          database: startupDb,
          rawPassword,
        },
        secret,
      );
      const rewritten = buildPgPasswordPacket(signedPassword);
      upstream.write(rewritten);
      switchToPipe(rest);
    };

    const onClientData = (chunk) => {
      if (closed || state === "piping") return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

      if (state === "proxy") {
        const parsed = parseProxyHeader(buf);
        if (parsed.status === "need_more") return;
        if (parsed.status === "invalid") {
          logger.warn?.(`[sql-ip-gate] closing connection: ${parsed.reason}`);
          cleanup();
          return;
        }
        clientIp = parsed.clientIp;
        buf = buf.subarray(parsed.consumed);
        state = "startup";
      }

      if (state === "startup") {
        while (state === "startup" && buf.length > 0) {
          const parsed = parsePgStartup(buf);
          if (parsed.status === "need_more") return;
          if (parsed.status === "invalid") {
            logger.warn?.(`[sql-ip-gate] closing connection: ${parsed.reason}`);
            cleanup();
            return;
          }
          buf = buf.subarray(parsed.consumed);
          if (parsed.status === "ssl_request") {
            // Envoy terminates TLS before reaching sql-ip-gate; decline nested SSLRequest cleanly.
            client.write("N");
            continue;
          }
          if (parsed.status === "cancel") {
            const rest = buf;
            buf = Buffer.alloc(0);
            connectUpstream(parsed.packet, false, rest);
            return;
          }
          startupUser = parsed.params.user || "";
          startupDb = parsed.params.database || "";
          const interceptPassword = isAudvitadSqlLogin(startupUser, "");
          const rest = buf;
          buf = Buffer.alloc(0);
          connectUpstream(parsed.packet, interceptPassword, rest);
          return;
        }
      }

      if (state === "password") {
        processPasswordBuffer();
      }
    };

    client.on("data", onClientData);
  });
}

// Standalone entrypoint when invoked via `node src/sqlIpGate.js`.
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));

if (isMain) {
  const bindHost = process.env.SQL_IP_GATE_BIND || "127.0.0.1";
  const listenPort = Number(process.env.SQL_IP_GATE_PORT || 15434);
  const healthPort = Number(process.env.SQL_IP_GATE_HEALTH_PORT || 15436);

  const server = createSqlIpGateServer();
  let shuttingDown = false;

  const healthServer = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(shuttingDown ? 503 : 200, { "content-type": "text/plain" });
      res.end(shuttingDown ? "draining\n" : "ok\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(listenPort, bindHost, () => {
    console.log(
      `[sql-ip-gate] listening on ${bindHost}:${listenPort} -> ${process.env.SQL_IP_GATE_UPSTREAM_HOST || "synmetrix-cubejs"}:${process.env.SQL_IP_GATE_UPSTREAM_PORT || 15432}`,
    );
  });
  healthServer.listen(healthPort, "0.0.0.0", () => {
    console.log(`[sql-ip-gate] health server listening on :${healthPort}`);
  });

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    healthServer.close();
    setTimeout(() => process.exit(0), 25000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
