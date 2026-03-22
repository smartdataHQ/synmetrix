import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";

// Set TOKEN_SECRET before importing module under test
const TEST_TOKEN_SECRET = "test-fraios-secret-key-at-least-32-chars!!";
process.env.TOKEN_SECRET = TEST_TOKEN_SECRET;

const { detectTokenType, verifyFraiOSToken } = await import(
  "../workosAuth.js"
);

// --- Helpers ---

function makeHS256Token(payload, secret) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

// --- detectTokenType ---

describe("detectTokenType", () => {
  it('returns "fraios" for HS256 token with accountId claim', async () => {
    const token = await makeHS256Token(
      { userId: "u1", email: "a@b.com", accountId: "org1" },
      TEST_TOKEN_SECRET
    );
    assert.equal(detectTokenType(token), "fraios");
  });

  it('returns "hasura" for HS256 token with hasura namespace', async () => {
    const token = await makeHS256Token(
      { hasura: { "x-hasura-user-id": "u1" } },
      "any-secret-that-is-long-enough-ok"
    );
    assert.equal(detectTokenType(token), "hasura");
  });

  it('returns "hasura" for malformed token', () => {
    assert.equal(detectTokenType("not.a.jwt"), "hasura");
  });
});

// --- verifyFraiOSToken ---

describe("verifyFraiOSToken", () => {
  it("verifies a valid FraiOS token and returns payload", async () => {
    const token = await makeHS256Token(
      {
        userId: "u1",
        email: "user@example.com",
        accountId: "org1",
        partition: "bonus.is",
      },
      TEST_TOKEN_SECRET
    );
    const payload = await verifyFraiOSToken(token);
    assert.equal(payload.userId, "u1");
    assert.equal(payload.email, "user@example.com");
    assert.equal(payload.accountId, "org1");
    assert.equal(payload.partition, "bonus.is");
  });

  it("rejects a token signed with wrong secret", async () => {
    const token = await makeHS256Token(
      { userId: "u1", email: "a@b.com", accountId: "org1" },
      "wrong-secret-that-is-long-enough!!"
    );
    await assert.rejects(() => verifyFraiOSToken(token), (err) => {
      assert.equal(err.status, 403);
      return true;
    });
  });

  it("rejects an expired token", async () => {
    const token = await new SignJWT({
      userId: "u1",
      email: "a@b.com",
      accountId: "org1",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(TEST_TOKEN_SECRET));

    await assert.rejects(() => verifyFraiOSToken(token), (err) => {
      assert.equal(err.status, 403);
      assert.ok(err.message.includes("expired"));
      return true;
    });
  });
});
