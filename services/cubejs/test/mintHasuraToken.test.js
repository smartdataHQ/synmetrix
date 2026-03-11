import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Save original env and set test values before importing
const originalEnv = { ...process.env };

before(() => {
  process.env.JWT_KEY = "test-secret-key-that-is-long-enough-for-hs256";
  process.env.JWT_ALGORITHM = "HS256";
  process.env.JWT_CLAIMS_NAMESPACE = "hasura";
  process.env.JWT_EXPIRES_IN = "15";
});

after(() => {
  Object.assign(process.env, originalEnv);
});

describe("mintHasuraToken", () => {
  it("returns a valid JWT string with 3 segments", async () => {
    const { mintHasuraToken } = await import(
      "../src/utils/mintHasuraToken.js"
    );
    const token = await mintHasuraToken("user-123");
    assert.ok(token, "token should be truthy");
    const parts = token.split(".");
    assert.equal(parts.length, 3, "JWT should have 3 dot-separated segments");
  });

  it("includes correct Hasura claims under the configured namespace", async () => {
    const { mintHasuraToken } = await import(
      "../src/utils/mintHasuraToken.js"
    );
    const { decodeJwt } = await import("jose");

    const token = await mintHasuraToken("user-456");
    const payload = decodeJwt(token);

    assert.ok(payload.hasura, "should have claims under 'hasura' namespace");
    assert.equal(
      payload.hasura["x-hasura-user-id"],
      "user-456",
      "x-hasura-user-id should match userId"
    );
    assert.deepEqual(
      payload.hasura["x-hasura-allowed-roles"],
      ["user"],
      "allowed roles should be ['user']"
    );
    assert.equal(
      payload.hasura["x-hasura-default-role"],
      "user",
      "default role should be 'user'"
    );
  });

  it("sets correct issuer, audience, and subject", async () => {
    const { mintHasuraToken } = await import(
      "../src/utils/mintHasuraToken.js"
    );
    const { decodeJwt } = await import("jose");

    const token = await mintHasuraToken("user-789");
    const payload = decodeJwt(token);

    assert.equal(payload.iss, "services:cubejs", "issuer should be services:cubejs");
    assert.equal(payload.aud, "services:hasura", "audience should be services:hasura");
    assert.equal(payload.sub, "user-789", "subject should match userId");
  });

  it("sets expiry matching JWT_EXPIRES_IN env var", async () => {
    const { mintHasuraToken } = await import(
      "../src/utils/mintHasuraToken.js"
    );
    const { decodeJwt } = await import("jose");

    const token = await mintHasuraToken("user-exp");
    const payload = decodeJwt(token);

    assert.ok(payload.iat, "should have iat");
    assert.ok(payload.exp, "should have exp");

    const diffMinutes = (payload.exp - payload.iat) / 60;
    // Allow small variance due to timing
    assert.ok(
      diffMinutes >= 14.9 && diffMinutes <= 15.1,
      `expiry should be ~15 minutes, got ${diffMinutes}`
    );
  });

  it("uses HS256 algorithm", async () => {
    const { mintHasuraToken } = await import(
      "../src/utils/mintHasuraToken.js"
    );
    const { decodeProtectedHeader } = await import("jose");

    const token = await mintHasuraToken("user-alg");
    const header = decodeProtectedHeader(token);

    assert.equal(header.alg, "HS256", "algorithm should be HS256");
  });
});
