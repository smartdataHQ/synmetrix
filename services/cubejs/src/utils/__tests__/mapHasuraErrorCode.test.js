import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mapHasuraErrorCode } from "../mapHasuraErrorCode.js";
import { ErrorCode } from "../errorCodes.js";

describe("mapHasuraErrorCode", () => {
  it("returns null for empty / non-array input", () => {
    assert.equal(mapHasuraErrorCode(null), null);
    assert.equal(mapHasuraErrorCode(undefined), null);
    assert.equal(mapHasuraErrorCode([]), null);
  });

  it("returns null when extensions.code is absent", () => {
    assert.equal(mapHasuraErrorCode([{ message: "whatever" }]), null);
  });

  it("permission-error maps to delete_blocked_authorization for delete action", () => {
    const code = mapHasuraErrorCode(
      [{ extensions: { code: "permission-error" } }],
      { action: "delete" }
    );
    assert.equal(code, ErrorCode.DELETE_BLOCKED_AUTHORIZATION);
  });

  it("permission-error maps to rollback_blocked_authorization for rollback action", () => {
    const code = mapHasuraErrorCode(
      [{ extensions: { code: "permission-error" } }],
      { action: "rollback" }
    );
    assert.equal(code, ErrorCode.ROLLBACK_BLOCKED_AUTHORIZATION);
  });

  it("not-exists maps to cube_not_found for meta action", () => {
    const code = mapHasuraErrorCode(
      [{ extensions: { code: "not-exists" } }],
      { action: "meta" }
    );
    assert.equal(code, ErrorCode.CUBE_NOT_FOUND);
  });

  it("constraint-violation maps to delete_blocked_by_references for delete", () => {
    const code = mapHasuraErrorCode(
      [{ extensions: { code: "constraint-violation" } }],
      { action: "delete" }
    );
    assert.equal(code, ErrorCode.DELETE_BLOCKED_BY_REFERENCES);
  });

  it("returns null for unknown extensions.code", () => {
    const code = mapHasuraErrorCode(
      [{ extensions: { code: "totally-unknown" } }],
      { action: "delete" }
    );
    assert.equal(code, null);
  });
});
