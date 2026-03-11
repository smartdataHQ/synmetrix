import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

// --- Test Environment Setup ---
// We need to set env vars before importing the proxy module

const TEST_JWT_KEY = "test-secret-key-that-is-long-enough-for-hs256-testing";
const TEST_CLAIMS_NAMESPACE = "hasura";

before(() => {
  process.env.JWT_KEY = TEST_JWT_KEY;
  process.env.JWT_ALGORITHM = "HS256";
  process.env.JWT_CLAIMS_NAMESPACE = TEST_CLAIMS_NAMESPACE;
  process.env.JWT_EXPIRES_IN = "15";
  // HASURA_ENDPOINT will be set per-test to point to mock Hasura
});

/**
 * Create a mock Hasura server that echoes back request details.
 * Returns { server, port, close() }.
 */
async function createMockHasura() {
  const app = express();
  // Don't parse body — just echo raw headers
  app.all("/v1/graphql", (req, res) => {
    res.json({
      data: { test: true },
      _headers: {
        authorization: req.headers.authorization || null,
        "x-hasura-user-id": req.headers["x-hasura-user-id"] || null,
        "x-hasura-role": req.headers["x-hasura-role"] || null,
      },
    });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Mint a valid HS256 token for testing.
 */
async function mintTestHS256Token(userId, options = {}) {
  const secret = new TextEncoder().encode(TEST_JWT_KEY);
  const builder = new SignJWT({
    [TEST_CLAIMS_NAMESPACE]: {
      "x-hasura-user-id": userId,
      "x-hasura-allowed-roles": ["user"],
      "x-hasura-default-role": "user",
    },
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("services:actions")
    .setAudience("services:hasura")
    .setSubject(userId);

  if (options.expired) {
    // Set exp in the past
    builder.setExpirationTime(Math.floor(Date.now() / 1000) - 60);
  } else {
    builder.setExpirationTime("15m");
  }

  return builder.sign(secret);
}

/**
 * Create test Express app with the proxy mounted.
 */
async function createTestApp(hasuraUrl) {
  process.env.HASURA_ENDPOINT = hasuraUrl;

  // Dynamic import to pick up env vars
  const { default: createHasuraProxy } = await import(
    "../src/routes/hasuraProxy.js"
  );

  const app = express();

  // Mount proxy BEFORE body parsers (same as production)
  app.use(
    createHasuraProxy({
      hasuraEndpoint: hasuraUrl,
    })
  );

  // Body parsers after proxy (same as production)
  app.use(express.json({ limit: "50mb" }));

  return app;
}

/**
 * Make an HTTP request to an Express app.
 */
async function request(app, { method = "POST", path = "/v1/graphql", headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const port = server.address().port;
      try {
        const fetchHeaders = { ...headers };
        const fetchOpts = { method, headers: fetchHeaders };

        if (body) {
          fetchHeaders["Content-Type"] = "application/json";
          fetchOpts.body = JSON.stringify(body);
        }

        const res = await fetch(`http://127.0.0.1:${port}${path}`, fetchOpts);
        const responseBody = await res.json();
        resolve({ status: res.status, body: responseBody, headers: Object.fromEntries(res.headers) });
      } finally {
        server.close();
      }
    });
  });
}

describe("hasuraProxy", () => {
  let mockHasura;

  before(async () => {
    mockHasura = await createMockHasura();
  });

  after(async () => {
    if (mockHasura) await mockHasura.close();
  });

  it("passes through HS256 token unchanged and returns successful response", async () => {
    const app = await createTestApp(mockHasura.url);
    const token = await mintTestHS256Token("user-hs256");

    const res = await request(app, {
      headers: { Authorization: `Bearer ${token}` },
      body: { query: "{ users { id } }" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.test, true);
    // HS256 token should pass through unchanged
    assert.equal(res.body._headers.authorization, `Bearer ${token}`);
  });

  it("returns 401 JSON for missing Authorization header", async () => {
    const app = await createTestApp(mockHasura.url);

    const res = await request(app, {
      headers: {},
      body: { query: "{ users { id } }" },
    });

    assert.equal(res.status, 401);
    assert.ok(res.body.error, "should have error field");
    assert.match(res.body.error, /Authorization header required/i);
  });

  it("returns 401 JSON for malformed token (not 3-segment JWT)", async () => {
    const app = await createTestApp(mockHasura.url);

    const res = await request(app, {
      headers: { Authorization: "Bearer not-a-jwt" },
      body: { query: "{ users { id } }" },
    });

    assert.equal(res.status, 401);
    assert.ok(res.body.error);
    assert.match(res.body.error, /Invalid token format/i);
  });

  it("returns 401 for two-segment token", async () => {
    const app = await createTestApp(mockHasura.url);

    const res = await request(app, {
      headers: { Authorization: "Bearer abc.def" },
      body: { query: "{ users { id } }" },
    });

    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid token format/i);
  });

  it("strips x-hasura-* headers before forwarding", async () => {
    const app = await createTestApp(mockHasura.url);
    const token = await mintTestHS256Token("user-strip");

    const res = await request(app, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-hasura-user-id": "spoofed-id",
        "x-hasura-role": "admin",
      },
      body: { query: "{ users { id } }" },
    });

    assert.equal(res.status, 200);
    // Spoofed headers should be stripped
    assert.equal(res.body._headers["x-hasura-user-id"], null, "x-hasura-user-id should be stripped");
    assert.equal(res.body._headers["x-hasura-role"], null, "x-hasura-role should be stripped");
  });

  it("returns JSON content-type for all error responses", async () => {
    const app = await createTestApp(mockHasura.url);

    const res = await request(app, {
      headers: {},
      body: { query: "{ users { id } }" },
    });

    assert.equal(res.status, 401);
    assert.ok(
      res.headers["content-type"]?.includes("application/json"),
      "error response should be JSON"
    );
  });

  it("does not intercept non /v1/graphql paths", async () => {
    const app = await createTestApp(mockHasura.url);

    // Add a catch-all to verify the proxy didn't handle this
    app.get("/api/v1/test", (req, res) => {
      res.json({ handled: "rest-api" });
    });

    const res = await request(app, {
      method: "GET",
      path: "/api/v1/test",
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.handled, "rest-api");
  });
});
