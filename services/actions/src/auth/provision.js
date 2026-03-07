import { fetchGraphQL } from "../utils/graphql.js";
import logger from "../utils/logger.js";

const CONSUMER_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "aol.com",
  "protonmail.com",
  "live.com",
  "msn.com",
  "ymail.com",
  "googlemail.com",
  "me.com",
  "mac.com",
];

function isConsumerDomain(domain) {
  return CONSUMER_DOMAINS.includes(domain.toLowerCase());
}

function buildDisplayName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
}

async function findAccountByWorkosId(workosUserId) {
  const query = `
    query FindAccountByWorkosId($workos_user_id: String!) {
      accounts: auth_accounts(where: { workos_user_id: { _eq: $workos_user_id } }, limit: 1) {
        id
        user_id
        email
      }
    }
  `;
  const result = await fetchGraphQL(query, { workos_user_id: workosUserId });
  return result.data?.accounts?.[0] || null;
}

async function findAccountByEmail(email) {
  const query = `
    query FindAccountByEmail($email: citext!) {
      accounts: auth_accounts(where: { email: { _eq: $email } }, limit: 1) {
        id
        user_id
        email
        workos_user_id
      }
    }
  `;
  const result = await fetchGraphQL(query, { email });
  return result.data?.accounts?.[0] || null;
}

async function backfillWorkosId(accountId, workosUserId) {
  const mutation = `
    mutation BackfillWorkosId($id: uuid!, $workos_user_id: String!) {
      update_auth_accounts_by_pk(pk_columns: { id: $id }, _set: { workos_user_id: $workos_user_id }) {
        id
      }
    }
  `;
  await fetchGraphQL(mutation, { id: accountId, workos_user_id: workosUserId });
}

async function findMemberWithTeam(userId) {
  const query = `
    query FindMemberWithTeam($user_id: uuid!) {
      members(where: { user_id: { _eq: $user_id } }, limit: 1) {
        id
        team_id
      }
    }
  `;
  const result = await fetchGraphQL(query, { user_id: userId });
  return result.data?.members?.[0] || null;
}

async function createUser(displayName, avatarUrl) {
  const mutation = `
    mutation CreateUser($display_name: String, $avatar_url: String) {
      insert_users_one(object: { display_name: $display_name, avatar_url: $avatar_url }) {
        id
      }
    }
  `;
  const result = await fetchGraphQL(mutation, {
    display_name: displayName,
    avatar_url: avatarUrl || null,
  });
  return result.data?.insert_users_one?.id;
}

async function createAccount(userId, email, workosUserId) {
  const mutation = `
    mutation CreateAccount($user_id: uuid!, $email: citext!, $workos_user_id: String!) {
      insert_auth_accounts_one(object: {
        user_id: $user_id,
        email: $email,
        workos_user_id: $workos_user_id,
        active: true,
        default_role: "user"
      }) {
        id
      }
    }
  `;
  const result = await fetchGraphQL(mutation, {
    user_id: userId,
    email,
    workos_user_id: workosUserId,
  });
  return result.data?.insert_auth_accounts_one?.id;
}

async function findTeamByName(name) {
  const query = `
    query FindTeamByName($name: String!) {
      teams(where: { name: { _ilike: $name } }, limit: 1) {
        id
        user_id
      }
    }
  `;
  const result = await fetchGraphQL(query, { name });
  return result.data?.teams?.[0] || null;
}

async function createTeam(name, userId) {
  const mutation = `
    mutation CreateTeam($name: String!, $user_id: uuid!) {
      insert_teams_one(object: { name: $name, user_id: $user_id }) {
        id
      }
    }
  `;
  const result = await fetchGraphQL(mutation, { name, user_id: userId });
  return result.data?.insert_teams_one?.id;
}

async function createMember(userId, teamId) {
  const mutation = `
    mutation CreateMember($user_id: uuid!, $team_id: uuid!) {
      insert_members_one(
        object: { user_id: $user_id, team_id: $team_id },
        on_conflict: { constraint: members_user_id_team_id_key, update_columns: [] }
      ) {
        id
      }
    }
  `;
  const result = await fetchGraphQL(mutation, {
    user_id: userId,
    team_id: teamId,
  });
  return result.data?.insert_members_one?.id;
}

async function createMemberRole(memberId, teamRole) {
  const mutation = `
    mutation CreateMemberRole($member_id: uuid!, $team_role: String!) {
      insert_member_roles_one(object: { member_id: $member_id, team_role: $team_role }) {
        id
      }
    }
  `;
  await fetchGraphQL(mutation, { member_id: memberId, team_role: teamRole });
}

/**
 * JIT provision a user from WorkOS authentication data.
 * Returns { userId, teamId } for session creation.
 */
export async function provisionUser(workosUser) {
  const email = workosUser.email;
  const workosUserId = workosUser.id;

  // 1. Look up by workos_user_id (primary)
  let account = await findAccountByWorkosId(workosUserId);

  if (account) {
    // Existing user via workos_user_id
    const member = await findMemberWithTeam(account.user_id);
    if (member) {
      return { userId: account.user_id, teamId: member.team_id };
    }
    // Orphan: has account but no team membership — fall through to assign team
    return await assignTeamToUser(account.user_id, email, workosUser);
  }

  // 2. Fallback: look up by email
  account = await findAccountByEmail(email);

  if (account) {
    // Backfill workos_user_id
    if (!account.workos_user_id) {
      await backfillWorkosId(account.id, workosUserId);
    }

    const member = await findMemberWithTeam(account.user_id);
    if (member) {
      return { userId: account.user_id, teamId: member.team_id };
    }
    // Orphan
    return await assignTeamToUser(account.user_id, email, workosUser);
  }

  // 3. New user: create everything
  const displayName = buildDisplayName(workosUser);
  const userId = await createUser(displayName, workosUser.profilePictureUrl);
  await createAccount(userId, email, workosUserId);

  return await assignTeamToUser(userId, email, workosUser);
}

async function assignTeamToUser(userId, email, workosUser) {
  const emailDomain = email.split("@")[1]?.toLowerCase().trim();
  const teamName = (isConsumerDomain(emailDomain) ? email : emailDomain).toLowerCase().trim();

  let team = await findTeamByName(teamName);
  let isTeamCreator = false;

  if (!team) {
    const teamId = await createTeam(teamName, userId);
    team = { id: teamId };
    isTeamCreator = true;
  }

  const memberId = await createMember(userId, team.id);
  if (memberId) {
    await createMemberRole(memberId, isTeamCreator ? "owner" : "member");
  }

  logger.log(
    `Provisioned user ${userId} into team ${team.id} (${teamName}) as ${isTeamCreator ? "owner" : "member"}`
  );

  return { userId, teamId: team.id };
}

export default provisionUser;
