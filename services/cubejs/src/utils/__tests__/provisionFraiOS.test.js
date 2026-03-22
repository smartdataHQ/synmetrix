import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Mock fetchGraphQL before importing module under test
const fetchGraphQLMock = mock.fn();
mock.module("../graphql.js", {
  namedExports: { fetchGraphQL: fetchGraphQLMock },
});
mock.module("../workosAuth.js", {
  namedExports: {
    fetchWorkOSUserProfile: mock.fn(),
    detectTokenType: mock.fn(),
    verifyWorkOSToken: mock.fn(),
    verifyFraiOSToken: mock.fn(),
  },
});

const {
  provisionUserFromFraiOS,
  invalidateWorkosSubCache,
} = await import("../dataSourceHelpers.js");

describe("provisionUserFromFraiOS", () => {
  beforeEach(() => {
    fetchGraphQLMock.mock.resetCalls();
    invalidateWorkosSubCache(null); // clear cache between tests
  });

  it("returns userId when account found by email", async () => {
    fetchGraphQLMock.mock.mockImplementation(async (query) => {
      if (query.includes("FindAccountByEmail")) {
        return {
          data: {
            accounts: [{ id: "acc-1", user_id: "user-uuid-1", email: "a@bonus.is" }],
          },
        };
      }
      if (query.includes("FindTeamByName")) {
        return { data: { teams: [{ id: "team-1", user_id: "user-uuid-1" }] } };
      }
      if (query.includes("CreateMember")) {
        return { data: { insert_members_one: null } };
      }
      if (query.includes("FindMember")) {
        return {
          data: {
            members: [{ id: "member-1", member_roles: [{ id: "role-1" }] }],
          },
        };
      }
      return { data: {} };
    });

    const userId = await provisionUserFromFraiOS({
      userId: "fraios-user-1",
      email: "a@bonus.is",
      accountId: "org-1",
      partition: "bonus.is",
    });

    assert.equal(userId, "user-uuid-1");
  });

  it("provisions new user when no account found", async () => {
    fetchGraphQLMock.mock.mockImplementation(async (query) => {
      if (query.includes("FindAccountByEmail")) {
        return { data: { accounts: [] } };
      }
      if (query.includes("CreateUser")) {
        return { data: { insert_users_one: { id: "new-user-uuid" } } };
      }
      if (query.includes("CreateAccount")) {
        return { data: { insert_auth_accounts_one: { id: "acc-new", user_id: "new-user-uuid" } } };
      }
      if (query.includes("FindTeamByName")) {
        return { data: { teams: [] } };
      }
      if (query.includes("CreateTeam")) {
        return { data: { insert_teams_one: { id: "team-new" } } };
      }
      if (query.includes("CreateMember")) {
        return { data: { insert_members_one: { id: "member-new" } } };
      }
      if (query.includes("CreateMemberRole")) {
        return { data: { insert_member_roles_one: { id: "role-new" } } };
      }
      return { data: {} };
    });

    const userId = await provisionUserFromFraiOS({
      userId: "fraios-user-2",
      email: "b@bonus.is",
      accountId: "org-2",
      partition: "bonus.is",
    });

    assert.equal(userId, "new-user-uuid");
  });

  it("uses cache on second call with same fraios userId", async () => {
    let callCount = 0;
    fetchGraphQLMock.mock.mockImplementation(async (query) => {
      if (query.includes("FindAccountByEmail")) {
        callCount++;
        return {
          data: {
            accounts: [{ id: "acc-3", user_id: "user-uuid-3", email: "c@bonus.is" }],
          },
        };
      }
      if (query.includes("FindTeamByName")) {
        return { data: { teams: [{ id: "team-3" }] } };
      }
      if (query.includes("CreateMember")) {
        return { data: { insert_members_one: null } };
      }
      if (query.includes("FindMember")) {
        return {
          data: { members: [{ id: "m-3", member_roles: [{ id: "r-3" }] }] },
        };
      }
      return { data: {} };
    });

    const payload = {
      userId: "fraios-user-3",
      email: "c@bonus.is",
      accountId: "org-3",
      partition: "bonus.is",
    };

    await provisionUserFromFraiOS(payload);
    await provisionUserFromFraiOS(payload);

    assert.equal(callCount, 1, "should hit cache on second call");
  });
});
