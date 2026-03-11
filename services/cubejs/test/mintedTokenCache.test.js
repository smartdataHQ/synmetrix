import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mintedTokenCache,
} from "../src/utils/mintedTokenCache.js";

describe("mintedTokenCache", () => {
  beforeEach(() => {
    mintedTokenCache.invalidateAll();
  });

  it("returns null on cache miss", () => {
    const result = mintedTokenCache.get("nonexistent-user");
    assert.equal(result, null, "should return null for unknown userId");
  });

  it("returns cached token when exp - now > 60s", () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300; // 5 min from now
    mintedTokenCache.set("user-1", "token-abc", futureExp);

    const result = mintedTokenCache.get("user-1");
    assert.equal(result, "token-abc", "should return cached token");
  });

  it("returns null when exp - now <= 60s", () => {
    const nearExp = Math.floor(Date.now() / 1000) + 30; // 30s from now
    mintedTokenCache.set("user-2", "token-expiring", nearExp);

    const result = mintedTokenCache.get("user-2");
    assert.equal(result, null, "should return null for nearly-expired token");
  });

  it("returns null when token is already expired", () => {
    const pastExp = Math.floor(Date.now() / 1000) - 10; // 10s ago
    mintedTokenCache.set("user-3", "token-expired", pastExp);

    const result = mintedTokenCache.get("user-3");
    assert.equal(result, null, "should return null for expired token");
  });

  it("invalidate(userId) clears specific entry", () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300;
    mintedTokenCache.set("user-a", "token-a", futureExp);
    mintedTokenCache.set("user-b", "token-b", futureExp);

    mintedTokenCache.invalidate("user-a");

    assert.equal(mintedTokenCache.get("user-a"), null, "user-a should be cleared");
    assert.equal(mintedTokenCache.get("user-b"), "token-b", "user-b should remain");
  });

  it("invalidateAll() clears all entries", () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300;
    mintedTokenCache.set("user-x", "token-x", futureExp);
    mintedTokenCache.set("user-y", "token-y", futureExp);

    mintedTokenCache.invalidateAll();

    assert.equal(mintedTokenCache.get("user-x"), null, "user-x should be cleared");
    assert.equal(mintedTokenCache.get("user-y"), null, "user-y should be cleared");
  });

  it("evicts oldest entry when max 1000 entries reached", () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300;

    // Fill cache to max
    for (let i = 0; i < 1000; i++) {
      mintedTokenCache.set(`user-${i}`, `token-${i}`, futureExp);
    }

    // Adding one more should evict the oldest (user-0)
    mintedTokenCache.set("user-new", "token-new", futureExp);

    assert.equal(mintedTokenCache.get("user-0"), null, "oldest entry should be evicted");
    assert.equal(mintedTokenCache.get("user-new"), "token-new", "new entry should exist");
    assert.equal(mintedTokenCache.get("user-999"), "token-999", "recent entries should remain");
  });
});
