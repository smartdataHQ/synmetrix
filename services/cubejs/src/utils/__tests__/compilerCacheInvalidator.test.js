import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { invalidateCompilerForBranch } from "../compilerCacheInvalidator.js";

function makeFakeLRU(initialEntries = []) {
  const map = new Map(initialEntries);
  return {
    keys: () => map.keys(),
    delete: (key) => map.delete(key),
    size: () => map.size,
    has: (key) => map.has(key),
    _backing: map,
  };
}

describe("invalidateCompilerForBranch", () => {
  it("evicts only entries whose appId suffix matches the given schemaVersion", () => {
    const cache = makeFakeLRU([
      ["CUBEJS_APP_dsvA_schA}", {}],
      ["CUBEJS_APP_dsvB_schA}", {}],
      ["CUBEJS_APP_dsvC_schB}", {}],
      ["CUBEJS_APP_dsvA_schC}", {}],
    ]);

    const evicted = invalidateCompilerForBranch(
      { compilerCache: cache },
      "schA"
    );

    assert.equal(evicted, 2);
    assert.equal(cache.has("CUBEJS_APP_dsvA_schA}"), false);
    assert.equal(cache.has("CUBEJS_APP_dsvB_schA}"), false);
    assert.equal(cache.has("CUBEJS_APP_dsvC_schB}"), true);
    assert.equal(cache.has("CUBEJS_APP_dsvA_schC}"), true);
  });

  it("returns 0 and no-ops on an empty cache", () => {
    const cache = makeFakeLRU();
    const evicted = invalidateCompilerForBranch(
      { compilerCache: cache },
      "anyhash"
    );
    assert.equal(evicted, 0);
  });

  it("returns 0 gracefully when compilerCache is missing or unsupported", () => {
    assert.equal(invalidateCompilerForBranch({}, "h"), 0);
    assert.equal(invalidateCompilerForBranch({ compilerCache: null }, "h"), 0);
    assert.equal(
      invalidateCompilerForBranch({ compilerCache: { keys: null } }, "h"),
      0
    );
  });

  it("is idempotent — second call with no intervening inserts returns 0", () => {
    const cache = makeFakeLRU([
      ["CUBEJS_APP_dsvA_schX}", {}],
      ["CUBEJS_APP_dsvB_schX}", {}],
    ]);
    const cubejs = { compilerCache: cache };

    const first = invalidateCompilerForBranch(cubejs, "schX");
    const second = invalidateCompilerForBranch(cubejs, "schX");

    assert.equal(first, 2);
    assert.equal(second, 0);
  });

  it("ignores non-string keys without throwing", () => {
    const cache = makeFakeLRU([
      [Symbol("weird"), {}],
      [42, {}],
      ["CUBEJS_APP_x_schK}", {}],
    ]);
    const evicted = invalidateCompilerForBranch(
      { compilerCache: cache },
      "schK"
    );
    assert.equal(evicted, 1);
  });
});
