import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ErrorCode,
  ErrorCodeSet,
  isKnownErrorCode,
} from "../errorCodes.js";

describe("ErrorCode enum", () => {
  it("freezes the enum to prevent runtime mutation", () => {
    assert.ok(Object.isFrozen(ErrorCode));
    assert.ok(Object.isFrozen(ErrorCodeSet));
  });

  it("exposes a Set of every code for test discovery", () => {
    const values = new Set(Object.values(ErrorCode));
    assert.deepEqual(values, ErrorCodeSet);
  });

  it("recognises each declared code", () => {
    for (const v of Object.values(ErrorCode)) {
      assert.equal(isKnownErrorCode(v), true, `known: ${v}`);
    }
    assert.equal(isKnownErrorCode("nope"), false);
  });

  it("includes refresh_unauthorized (FR-017 / R13 contract enum)", () => {
    assert.ok(ErrorCodeSet.has("refresh_unauthorized"));
  });

  it("includes rollback_blocked_authorization for partition/role failures on rollback", () => {
    assert.ok(ErrorCodeSet.has("rollback_blocked_authorization"));
  });
});
