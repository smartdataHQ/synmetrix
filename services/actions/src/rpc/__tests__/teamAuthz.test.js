import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canInvite } from "../inviteTeamMember.js";
import { canCreateTeam } from "../createTeam.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const OUTSIDER = "33333333-3333-4333-8333-333333333333";

const team = {
  id: "team-1",
  members: [
    { id: "m1", user_id: OWNER, member_roles: [{ team_role: "owner" }] },
    { id: "m2", user_id: MEMBER, member_roles: [{ team_role: "member" }] },
  ],
};

const notAdmin = { portalAdmin: async () => false };
const admin = { portalAdmin: async () => true };

describe("invite_team_member authorization", () => {
  it("allows the team owner", async () => {
    assert.equal(await canInvite({ team, userId: OWNER }, notAdmin), true);
  });

  it("refuses a plain member", async () => {
    assert.equal(await canInvite({ team, userId: MEMBER }, notAdmin), false);
  });

  it("refuses a non-member (previously skipped the check)", async () => {
    assert.equal(await canInvite({ team, userId: OUTSIDER }, notAdmin), false);
  });

  it("refuses when the team does not exist", async () => {
    assert.equal(await canInvite({ team: null, userId: OWNER }, admin), false);
  });

  it("refuses a team with no members unless portal admin", async () => {
    const empty = { id: "team-2", members: [] };
    assert.equal(await canInvite({ team: empty, userId: OUTSIDER }, notAdmin), false);
    assert.equal(await canInvite({ team: empty, userId: OUTSIDER }, admin), true);
  });

  it("allows a portal admin who is not a member", async () => {
    assert.equal(await canInvite({ team, userId: OUTSIDER }, admin), true);
  });
});

describe("create_team authorization", () => {
  it("refuses a user-invoked action from a non-admin", async () => {
    assert.equal(
      await canCreateTeam({ "x-hasura-user-id": OUTSIDER }, notAdmin),
      false
    );
  });

  it("allows a portal admin", async () => {
    assert.equal(await canCreateTeam({ "x-hasura-user-id": OWNER }, admin), true);
  });

  it("allows an admin-secret caller (role admin)", async () => {
    assert.equal(
      await canCreateTeam(
        { "x-hasura-role": "admin", "x-hasura-user-id": OUTSIDER },
        notAdmin
      ),
      true
    );
  });

  it("does not trust a user-role caller that is not a portal admin", async () => {
    assert.equal(
      await canCreateTeam(
        { "x-hasura-role": "user", "x-hasura-user-id": OUTSIDER },
        notAdmin
      ),
      false
    );
  });

  it("allows the users-insert event trigger (no session)", async () => {
    assert.equal(await canCreateTeam(undefined, notAdmin), true);
  });
});
