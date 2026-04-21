import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { requireOwnerOrAdmin } from "../requireOwnerOrAdmin.js";

describe("requireOwnerOrAdmin", () => {
  it("returns true for an owner on the target team", () => {
    const user = {
      members: [
        {
          team_id: "t1",
          member_roles: [{ team_role: "owner" }],
        },
      ],
    };
    assert.equal(requireOwnerOrAdmin(user, "t1"), true);
  });

  it("returns true for an admin on the target team", () => {
    const user = {
      members: [
        { team_id: "t1", member_roles: [{ team_role: "admin" }] },
      ],
    };
    assert.equal(requireOwnerOrAdmin(user, "t1"), true);
  });

  it("returns false for a plain member", () => {
    const user = {
      members: [
        { team_id: "t1", member_roles: [{ team_role: "member" }] },
      ],
    };
    assert.equal(requireOwnerOrAdmin(user, "t1"), false);
  });

  it("returns false when the caller has admin on a different team", () => {
    const user = {
      members: [
        { team_id: "other", member_roles: [{ team_role: "admin" }] },
      ],
    };
    assert.equal(requireOwnerOrAdmin(user, "t1"), false);
  });

  it("returns false on malformed input", () => {
    assert.equal(requireOwnerOrAdmin(null, "t1"), false);
    assert.equal(requireOwnerOrAdmin({}, "t1"), false);
    assert.equal(requireOwnerOrAdmin({ members: null }, "t1"), false);
    assert.equal(requireOwnerOrAdmin({ members: [] }, "t1"), false);
    assert.equal(requireOwnerOrAdmin({ members: [{}] }, "t1"), false);
    assert.equal(requireOwnerOrAdmin({ members: [{ team_id: "t1" }] }, "t1"), false);
  });
});
