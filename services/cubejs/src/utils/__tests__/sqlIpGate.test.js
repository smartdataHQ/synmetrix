import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";

import {
  buildPgPasswordPacket,
  createSqlIpGateServer,
  parseProxyHeader,
} from "../../sqlIpGate.js";
import {
  deriveAudvitadSqlSecret,
  verifyProxyPasswordEnvelope,
} from "../audvitadSqlAuth.js";

function buildStartupPacket(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    parts.push(Buffer.from(`${k}\0${v}\0`, "utf8"));
  }
  parts.push(Buffer.from([0]));
  const body = Buffer.concat(parts);
  const out = Buffer.allocUnsafe(8 + body.length);
  out.writeInt32BE(8 + body.length, 0);
  out.writeInt32BE(196608, 4);
  body.copy(out, 8);
  return out;
}

function buildProxyV2Ipv4(srcIp, dstIp = "10.0.0.1", sport = 54321, dport = 5432) {
  const sig = Buffer.from([
    0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
  ]);
  const hdr = Buffer.alloc(16 + 12);
  sig.copy(hdr, 0);
  hdr[12] = 0x21; // v2 PROXY
  hdr[13] = 0x11; // AF_INET + STREAM
  hdr.writeUInt16BE(12, 14);
  const s = srcIp.split(".").map(Number);
  const d = dstIp.split(".").map(Number);
  hdr.set(s, 16);
  hdr.set(d, 20);
  hdr.writeUInt16BE(sport, 24);
  hdr.writeUInt16BE(dport, 26);
  return hdr;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

describe("sqlIpGate", () => {
  it("parses PROXY v1 and v2 headers including IPv4-mapped IPv6", () => {
    const v1 = parseProxyHeader(
      Buffer.from("PROXY TCP4 203.0.113.42 10.0.0.1 55555 5432\r\nEXTRA"),
    );
    assert.equal(v1.status, "ok");
    assert.equal(v1.clientIp, "203.0.113.42");

    const v1Mapped = parseProxyHeader(
      Buffer.from("PROXY TCP6 ::ffff:198.51.100.7 ::1 55555 5432\r\n"),
    );
    assert.equal(v1Mapped.status, "ok");
    assert.equal(v1Mapped.clientIp, "198.51.100.7");

    const v2 = parseProxyHeader(buildProxyV2Ipv4("194.144.179.29"));
    assert.equal(v2.status, "ok");
    assert.equal(v2.clientIp, "194.144.179.29");

    const bad = parseProxyHeader(Buffer.from("GET / HTTP/1.1\r\n"));
    assert.equal(bad.status, "invalid");
  });

  it("signs client IP and database into ql_* PasswordMessage over PROXY v1 & v2, leaves non-ql_* untouched", async () => {
    const env = { SQL_AUTH_SECRET: "gate-test-secret" };
    const secret = deriveAudvitadSqlSecret(env);

    // Fake Cube PG upstream that replies AuthenticationCleartextPassword ('R' + 3)
    // and records the StartupMessage + PasswordMessage it receives.
    const received = [];
    const upstream = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let stage = "startup";
      const rec = { startup: null, password: null };
      received.push(rec);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === "startup" && buf.length >= 8) {
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          rec.startup = buf.subarray(0, len);
          buf = buf.subarray(len);
          stage = "pw";
          // Send AuthenticationCleartextPassword ('R', len=8, authType=3)
          const authReq = Buffer.alloc(9);
          authReq[0] = 0x52;
          authReq.writeInt32BE(8, 1);
          authReq.writeInt32BE(3, 5);
          sock.write(authReq);
        }
        if (stage === "pw" && buf.length >= 5) {
          const len = buf.readInt32BE(1);
          if (buf.length < 1 + len) return;
          rec.password = buf.subarray(5, 1 + len - 1).toString("utf8");
          // Send AuthenticationOk ('R', len=8, authType=0) and close
          const ok = Buffer.alloc(9);
          ok[0] = 0x52;
          ok.writeInt32BE(8, 1);
          ok.writeInt32BE(0, 5);
          sock.end(ok);
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const gate = createSqlIpGateServer({
      upstreamHost: "127.0.0.1",
      upstreamPort,
      requireProxyProtocol: true,
      env,
      logger: { warn() {} },
    });
    const gatePort = await listen(gate);

    const runClient = (proxyBytes, user, database, pw) =>
      new Promise((resolve, reject) => {
        const c = net.createConnection({ host: "127.0.0.1", port: gatePort }, () => {
          const payload = Buffer.concat([
            proxyBytes,
            buildStartupPacket({ user, database }),
          ]);
          // Send fragmented chunks to test reassembly
          c.write(payload.subarray(0, 10));
          setTimeout(() => c.write(payload.subarray(10)), 10);
        });
        let gotAuthReq = false;
        c.on("data", (d) => {
          if (!gotAuthReq && d[0] === 0x52 && d.readInt32BE(5) === 3) {
            gotAuthReq = true;
            c.write(buildPgPasswordPacket(pw));
          } else if (d[0] === 0x52 && d.readInt32BE(5) === 0) {
            c.end();
            resolve();
          }
        });
        c.on("error", reject);
      });

    try {
      // 1. PROXY v1 + ql_* user -> signed envelope
      await runClient(
        Buffer.from("PROXY TCP4 203.0.113.42 10.0.0.2 44444 5432\r\n"),
        "ql_01j9x",
        "audvitad",
        "sk_live_p|w",
      );
      const env1 = verifyProxyPasswordEnvelope("ql_01j9x", received[0].password, secret);
      assert.equal(env1.signed, true);
      assert.equal(env1.valid, true);
      assert.equal(env1.clientIp, "203.0.113.42");
      assert.equal(env1.database, "audvitad");
      assert.equal(env1.password, "sk_live_p|w");

      // 2. PROXY v2 + ql_* user -> signed envelope
      await runClient(
        buildProxyV2Ipv4("198.51.100.88"),
        "ql_ent99",
        "quicklookup",
        "sk_live_ent",
      );
      const env2 = verifyProxyPasswordEnvelope("ql_ent99", received[1].password, secret);
      assert.equal(env2.valid, true);
      assert.equal(env2.clientIp, "198.51.100.88");
      assert.equal(env2.database, "quicklookup");
      assert.equal(env2.password, "sk_live_ent");

      // 3. Non-ql_* internal Synmetrix user -> password passed through untouched
      await runClient(
        buildProxyV2Ipv4("10.42.0.5"),
        "synmetrix_internal",
        "synmetrix",
        "plain_pw",
      );
      assert.equal(received[2].password, "plain_pw");

      // 4. Missing PROXY header -> fail-closed immediately
      const closedWithoutReply = await new Promise((resolve) => {
        const c = net.createConnection({ host: "127.0.0.1", port: gatePort }, () => {
          c.write(buildStartupPacket({ user: "ql_01j9x", database: "audvitad" }));
        });
        let gotData = false;
        c.on("data", () => {
          gotData = true;
        });
        c.on("close", () => resolve(!gotData));
        c.on("error", () => resolve(!gotData));
      });
      assert.equal(closedWithoutReply, true);
    } finally {
      gate.close();
      upstream.close();
    }
  });
});
