import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("cubeCache", () => {
  it("sends the admin secret cubejs requires on invalidate-cache", async () => {
    process.env.HASURA_GRAPHQL_ADMIN_SECRET = "s3cret";
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    };
    try {
      const { invalidateUserCache, invalidateAllUserCaches, invalidateRulesCache } =
        await import("../cubeCache.js");
      invalidateUserCache("u-1");
      invalidateAllUserCaches();
      invalidateRulesCache();
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 3);
    for (const { url, init } of calls) {
      assert.match(url, /\/api\/v1\/internal\/invalidate-cache$/);
      assert.equal(init.headers["x-hasura-admin-secret"], "s3cret");
    }
  });
});
