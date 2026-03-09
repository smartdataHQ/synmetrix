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

async function createTeam(name, userId, initialSettings = {}) {
  const mutation = `
    mutation CreateTeam($name: String!, $user_id: uuid!, $settings: jsonb) {
      insert_teams_one(object: { name: $name, user_id: $user_id, settings: $settings }) {
        id
      }
    }
  `;
  const settings = Object.keys(initialSettings).length > 0 ? initialSettings : null;
  const result = await fetchGraphQL(mutation, { name, user_id: userId, settings });
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
    mutation CreateMemberRole($member_id: uuid!, $team_role: team_roles_enum!) {
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
export async function provisionUser(workosUser, options = {}) {
  const { partition, orgId } = options;
  const email = workosUser.email;
  const workosUserId = workosUser.id;

  logger.log(`[Provision] Starting: email=${email}, workosId=${workosUserId}, partition=${partition || "none"}, orgId=${orgId || "none"}`);

  // 1. Look up by workos_user_id (primary)
  let account = await findAccountByWorkosId(workosUserId);

  if (account) {
    return await ensureOrgTeam(account.user_id, email, workosUser, partition, orgId);
  }

  // 2. Fallback: look up by email
  account = await findAccountByEmail(email);

  if (account) {
    if (!account.workos_user_id) {
      await backfillWorkosId(account.id, workosUserId);
    }

    return await ensureOrgTeam(account.user_id, email, workosUser, partition, orgId);
  }

  // 3. New user: create everything
  const displayName = buildDisplayName(workosUser);
  const userId = await createUser(displayName, workosUser.profilePictureUrl);
  await createAccount(userId, email, workosUserId);

  return await assignTeamToUser(userId, email, workosUser, partition, orgId);
}

/**
 * Derive team name from org context.
 * Priority: partition from JWT (e.g. "blue.is") > email domain (business) > full email (consumer).
 * The partition claim in WorkOS is the org's unique identifier/slug.
 */
function deriveTeamName(email, partition) {
  if (partition) {
    return partition.toLowerCase().trim();
  }
  const emailDomain = email.split("@")[1]?.toLowerCase().trim();
  return (isConsumerDomain(emailDomain) ? email : emailDomain).toLowerCase().trim();
}

/**
 * For existing users: ensure they have membership in the org-derived team.
 * Uses orgName from JWT for team naming when available. Creates the team if needed.
 * Returns that team as the active team for the session.
 */
async function ensureOrgTeam(userId, email, workosUser, partition, orgId) {
  const teamName = deriveTeamName(email, partition);

  logger.log(`[Provision] ensureOrgTeam: userId=${userId}, teamName="${teamName}", partition=${partition || "none"}, orgId=${orgId || "none"}`);

  // Find or create the org's team
  let team = await findTeamByName(teamName);
  let isTeamCreator = false;

  if (!team) {
    const initialSettings = partition ? { partition } : {};
    const teamId = await createTeam(teamName, userId, initialSettings);
    team = { id: teamId };
    isTeamCreator = true;
    logger.log(`[Provision] Created new team "${teamName}" (${teamId}) with partition=${partition || "none"}`);
  }

  // Ensure user is a member of this team (on_conflict handles duplicate)
  const memberId = await createMember(userId, team.id);
  if (memberId) {
    await createMemberRole(memberId, isTeamCreator ? "owner" : "member");
    logger.log(`[Provision] Added user ${userId} to team ${team.id} (${teamName}) as ${isTeamCreator ? "owner" : "member"}`);
  }

  // If partition provided and team already existed, ensure partition is set in settings
  if (partition && !isTeamCreator) {
    await ensureTeamPartition(team.id, partition);
  }

  logger.log(
    `[Provision] ensureOrgTeam result: user=${userId} team=${team.id} (${teamName}) partition=${partition || "none"} newTeam=${isTeamCreator}`
  );

  return { userId, teamId: team.id };
}

async function assignTeamToUser(userId, email, workosUser, partition, orgId) {
  const teamName = deriveTeamName(email, partition);

  if (!partition) {
    logger.warn(`[Provision] No partition in WorkOS token for user ${email}`);
  }

  logger.log(`[Provision] assignTeamToUser: userId=${userId}, teamName="${teamName}", partition=${partition || "none"}, orgId=${orgId || "none"}`);

  let team = await findTeamByName(teamName);
  let isTeamCreator = false;

  if (!team) {
    const initialSettings = partition ? { partition } : {};
    const teamId = await createTeam(teamName, userId, initialSettings);
    team = { id: teamId };
    isTeamCreator = true;
  }

  const memberId = await createMember(userId, team.id);
  if (memberId) {
    await createMemberRole(memberId, isTeamCreator ? "owner" : "member");
  }

  logger.log(
    `[Provision] assignTeamToUser result: user=${userId} team=${team.id} (${teamName}) role=${isTeamCreator ? "owner" : "member"} partition=${partition || "none"} newTeam=${isTeamCreator}`
  );

  return { userId, teamId: team.id };
}

/**
 * Ensure a team has the partition value in its settings.
 * Used when an existing team is found but may not yet have the partition set.
 */
async function ensureTeamPartition(teamId, partition) {
  const query = `
    query GetTeamSettings($id: uuid!) {
      teams_by_pk(id: $id) {
        settings
      }
    }
  `;
  const result = await fetchGraphQL(query, { id: teamId });
  const currentSettings = result.data?.teams_by_pk?.settings || {};

  if (currentSettings.partition === partition) {
    return; // Already set
  }

  const mutation = `
    mutation SetTeamPartition($id: uuid!, $settings: jsonb!) {
      update_teams_by_pk(pk_columns: { id: $id }, _set: { settings: $settings }) {
        id
      }
    }
  `;

  const newSettings = { ...currentSettings, partition };
  await fetchGraphQL(mutation, { id: teamId, settings: newSettings });
  logger.log(`[Provision] Set partition=${partition} on team ${teamId}`);
}

export default provisionUser;
