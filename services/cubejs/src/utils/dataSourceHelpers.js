import { fetchGraphQL } from "./graphql.js";
import { fetchWorkOSUserProfile } from "./workosAuth.js";

// --- User scope cache: keyed by userId, 30s TTL ---
const userCache = new Map();
const USER_CACHE_TTL = 30_000;
const USER_CACHE_MAX_SIZE = 500;

// --- WorkOS identity mapping cache: keyed by WorkOS sub, 5min TTL ---
// Stores { userId, membershipVerified, time } to avoid re-reconciling membership on every cache miss
const workosSubCache = new Map();
const WORKOS_SUB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const WORKOS_SUB_CACHE_MAX_SIZE = 1000;

// Singleflight map: dedup concurrent provision calls for the same sub
const inflightProvisions = new Map();

export function getWorkosSubCacheEntry(sub) {
  const entry = workosSubCache.get(sub);
  if (!entry) return null;
  if (Date.now() - entry.time > WORKOS_SUB_CACHE_TTL) {
    workosSubCache.delete(sub);
    return null;
  }
  return entry;
}

export function setWorkosSubCacheEntry(sub, userId, membershipVerified = false) {
  if (workosSubCache.size >= WORKOS_SUB_CACHE_MAX_SIZE) {
    const oldest = workosSubCache.keys().next().value;
    workosSubCache.delete(oldest);
  }
  workosSubCache.set(sub, { userId, membershipVerified, time: Date.now() });
}

export function invalidateWorkosSubCache(sub) {
  if (sub) {
    workosSubCache.delete(sub);
  } else {
    workosSubCache.clear();
  }
}

function getUserCacheEntry(userId) {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.time > USER_CACHE_TTL) {
    userCache.delete(userId);
    return null;
  }
  return entry.data;
}

function setUserCacheEntry(userId, data) {
  // Evict oldest entries if cache is full
  if (userCache.size >= USER_CACHE_MAX_SIZE) {
    const oldest = userCache.keys().next().value;
    userCache.delete(oldest);
  }
  userCache.set(userId, { data, time: Date.now() });
}

export function invalidateUserCache(userId) {
  if (userId) {
    userCache.delete(userId);
  } else {
    userCache.clear();
  }
}

const sourceFragment = `
  id
  name
  db_type
  db_params
  team_id
`;

const modelsFragment = `
  id
  name
  code
`;

const branchesFragment = `
  id
  name
  status
`;

const membersFragment = `
  members {
    id
    team_id
    member_roles {
      id
      team_role
      access_list {
        config
      }
    }
  }
`;

const versionsFragment = `
  versions (limit: 1, order_by: {created_at: desc}) {
    id
    dataschemas {
      ${modelsFragment}
    }
  }
`;

const activeBranchModelsFragment = `
  branches(where: {status: {_eq: active}}) {
    ${branchesFragment}
    ${versionsFragment}
  }
`;

const selectedBranchModelsFragment = `
  branches_by_pk(id: $branchId) {
    ${branchesFragment}
    ${versionsFragment}
  }
`;

const userQuery = `
  query ($userId: uuid!) {
    members(where: {user_id: {_eq: $userId}}) {
      id
      team_id
      properties
      team {
        settings
        datasources {
          ${sourceFragment}
          branches {
            ${branchesFragment}
            ${versionsFragment}
          }
        }
      }
      member_roles {
        id
        team_role
        access_list {
          config
        }
      }
    }
  }
`;

const sourcesQuery = `
  {
    datasources {
      ${sourceFragment}
      ${activeBranchModelsFragment}
    }
  }
`;

const branchSchemasQuery = `
  query ($branchId: uuid!) {
    ${selectedBranchModelsFragment}
  }
`;

const upsertVersionMutation = `
  mutation ($object: versions_insert_input!) {
    insert_versions_one(
      object: $object
    ) {
      id
    }
  }
`;

const sqlCredentialsQuery = `
  query ($username: String!) {
    sql_credentials(where: {username: {_eq: $username}}) {
      id
      user_id
      user {
        ${membersFragment}
      }
      password
      username
      datasource {
        ${sourceFragment}
        ${activeBranchModelsFragment}
      }
    }
  }
`;

const dataschemasQuery = `
  query GetSchemas($_in: [uuid!]) {
    dataschemas(where: {id: {_in: $_in}}) {
      code
      name
      id
    }
  }
`;

export const findUser = async ({ userId }) => {
  const cached = getUserCacheEntry(userId);
  if (cached) return cached;

  const res = await fetchGraphQL(userQuery, { userId });

  const members = res?.data?.members || [];

  // Aggregate datasources from all team memberships
  const dataSourcesMap = new Map();
  members.forEach((member) => {
    const teamDatasources = member?.team?.datasources || [];
    teamDatasources.forEach((ds) => {
      // Use Map to dedupe by datasource id
      if (!dataSourcesMap.has(ds.id)) {
        dataSourcesMap.set(ds.id, ds);
      }
    });
  });

  const dataSources = Array.from(dataSourcesMap.values());

  const result = { dataSources, members };
  setUserCacheEntry(userId, result);
  return result;
};

export const findSqlCredentials = async (username) => {
  const res = await fetchGraphQL(sqlCredentialsQuery, { username });
  const sqlCredentials = res?.data?.sql_credentials?.[0];

  return sqlCredentials;
};

export const getDataSources = async () => {
  let res = await fetchGraphQL(sourcesQuery);
  res = res?.data?.datasources;

  return res;
};

export const createDataSchema = async (object) => {
  const { authToken, ...version } = object;

  let res = await fetchGraphQL(
    upsertVersionMutation,
    { object: version },
    authToken
  );
  res = res?.data?.insert_versions_one;

  return res;
};

export const findDataSchemas = async ({ branchId, authToken }) => {
  const res = await fetchGraphQL(branchSchemasQuery, { branchId }, authToken);

  const dataSchemas =
    res?.data?.branches_by_pk?.versions?.[0]?.dataschemas || [];

  return dataSchemas;
};

export const findDataSchemasByIds = async ({ ids }) => {
  const res = await fetchGraphQL(dataschemasQuery, { _in: ids });

  const dataSchemas = res?.data?.dataschemas || [];

  return dataSchemas;
};

// --- Identity resolution functions (T007) ---

const findAccountByWorkosIdQuery = `
  query FindAccountByWorkosId($workos_user_id: String!) {
    accounts: auth_accounts(where: { workos_user_id: { _eq: $workos_user_id } }, limit: 1) {
      id
      user_id
      email
      workos_user_id
    }
  }
`;

const findAccountByEmailQuery = `
  query FindAccountByEmail($email: citext!) {
    accounts: auth_accounts(where: { email: { _eq: $email } }, limit: 1) {
      id
      user_id
      email
      workos_user_id
    }
  }
`;

const backfillWorkosIdMutation = `
  mutation BackfillWorkosId($id: uuid!, $workos_user_id: String!) {
    update_auth_accounts_by_pk(pk_columns: { id: $id }, _set: { workos_user_id: $workos_user_id }) {
      id
    }
  }
`;

export async function findAccountByWorkosId(workosUserId) {
  const result = await fetchGraphQL(findAccountByWorkosIdQuery, {
    workos_user_id: workosUserId,
  });
  return result.data?.accounts?.[0] || null;
}

export async function findAccountByEmail(email) {
  const result = await fetchGraphQL(findAccountByEmailQuery, { email });
  return result.data?.accounts?.[0] || null;
}

export async function backfillWorkosId(accountId, workosUserId) {
  await fetchGraphQL(backfillWorkosIdMutation, {
    id: accountId,
    workos_user_id: workosUserId,
  });
}

// --- JIT Provisioning (T009) ---
// NOTE: team derivation logic duplicated in services/{actions,cubejs} — keep in sync

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

function deriveTeamName(email, partition) {
  if (partition) {
    return partition.toLowerCase().trim();
  }
  const emailDomain = email.split("@")[1]?.toLowerCase().trim();
  return (isConsumerDomain(emailDomain) ? email : emailDomain)
    .toLowerCase()
    .trim();
}

const findTeamByNameQuery = `
  query FindTeamByName($name: String!) {
    teams(where: { name: { _eq: $name } }, limit: 1) {
      id
      user_id
    }
  }
`;

const createUserMutation = `
  mutation CreateUser($display_name: String, $avatar_url: String) {
    insert_users_one(object: { display_name: $display_name, avatar_url: $avatar_url }) {
      id
    }
  }
`;

const createAccountMutation = `
  mutation CreateAccount($user_id: uuid!, $email: citext!, $workos_user_id: String!) {
    insert_auth_accounts_one(
      object: {
        user_id: $user_id,
        email: $email,
        workos_user_id: $workos_user_id,
        active: true,
        default_role: "user"
      },
      on_conflict: { constraint: accounts_email_key, update_columns: [workos_user_id] }
    ) {
      id
      user_id
    }
  }
`;

const createTeamMutation = `
  mutation CreateTeam($name: String!, $user_id: uuid!, $settings: jsonb) {
    insert_teams_one(
      object: { name: $name, user_id: $user_id, settings: $settings },
      on_conflict: { constraint: teams_name_unique, update_columns: [] }
    ) {
      id
    }
  }
`;

const createMemberMutation = `
  mutation CreateMember($user_id: uuid!, $team_id: uuid!) {
    insert_members_one(
      object: { user_id: $user_id, team_id: $team_id },
      on_conflict: { constraint: members_user_id_team_id_key, update_columns: [] }
    ) {
      id
    }
  }
`;

const createMemberRoleMutation = `
  mutation CreateMemberRole($member_id: uuid!, $team_role: team_roles_enum!) {
    insert_member_roles_one(
      object: { member_id: $member_id, team_role: $team_role },
      on_conflict: { constraint: member_roles_member_id_team_role_key, update_columns: [] }
    ) {
      id
    }
  }
`;

const findMemberByUserAndTeamQuery = `
  query FindMember($user_id: uuid!, $team_id: uuid!) {
    members(where: { user_id: { _eq: $user_id }, team_id: { _eq: $team_id } }, limit: 1) {
      id
      member_roles { id }
    }
  }
`;

async function findTeamByName(name) {
  const normalized = name.toLowerCase().trim();
  const result = await fetchGraphQL(findTeamByNameQuery, { name: normalized });
  return result.data?.teams?.[0] || null;
}

/**
 * Ensure a user has membership + role in the org's team.
 * Matches the Actions flow's ensureOrgTeam() in provision.js:230.
 * Handles: existing account with missing membership, or membership with missing role.
 */
async function ensureTeamMembership(userId, email, partition) {
  const teamName = deriveTeamName(email, partition);
  let team = await findTeamByName(teamName);

  if (!team) {
    // Team doesn't exist yet — create it with this user as owner
    const initialSettings = partition ? { partition } : {};
    const teamResult = await fetchGraphQL(createTeamMutation, {
      name: teamName,
      user_id: userId,
      settings: Object.keys(initialSettings).length > 0 ? initialSettings : null,
    });
    const teamId = teamResult.data?.insert_teams_one?.id;
    if (teamId) {
      team = { id: teamId };
    } else {
      team = await findTeamByName(teamName);
    }
  }

  if (!team) return; // Can't reconcile without a team

  // Ensure membership exists (on_conflict handles duplicate)
  const memberResult = await fetchGraphQL(createMemberMutation, {
    user_id: userId,
    team_id: team.id,
  });
  let memberId = memberResult.data?.insert_members_one?.id;

  // If on_conflict returned null, membership already exists — look it up
  // and ensure member role exists (fixes partial provisioning retry)
  if (!memberId) {
    const existing = await fetchGraphQL(findMemberByUserAndTeamQuery, {
      user_id: userId,
      team_id: team.id,
    });
    const member = existing.data?.members?.[0];
    if (member) {
      memberId = member.id;
      // If role already exists, skip
      if (member.member_roles?.length > 0) return;
    }
  }

  if (memberId) {
    await fetchGraphQL(createMemberRoleMutation, {
      member_id: memberId,
      team_role: "member",
    });
  }
}

/**
 * Provision a new user from WorkOS JWT payload.
 * Identity resolution chain:
 * 1. Check identity cache for payload.sub
 * 2. DB lookup by workos_user_id
 * 3. Fetch email from WorkOS API, DB lookup by email
 * 4. If email match found, backfill workos_user_id
 * 5. If no account found, create user + account + team + membership + role
 *
 * @param {Object} workosPayload - Verified WorkOS JWT payload
 * @returns {Promise<string>} userId
 */
export async function provisionUserFromWorkOS(workosPayload) {
  const sub = workosPayload.sub;
  const partition = workosPayload.partition;

  // Step 1: Check identity cache
  const cached = getWorkosSubCacheEntry(sub);
  if (cached) return cached.userId;

  // Singleflight: dedup concurrent provision calls for the same sub
  let inflight = inflightProvisions.get(sub);
  if (inflight) return inflight;

  const provision = _provisionUserFromWorkOS(sub, partition);
  inflightProvisions.set(sub, provision);
  provision.finally(() => inflightProvisions.delete(sub));
  return provision;
}

async function _provisionUserFromWorkOS(sub, partition) {
  // Re-check cache after acquiring singleflight (another request may have filled it)
  const cached = getWorkosSubCacheEntry(sub);
  if (cached) return cached.userId;

  // Step 2: DB lookup by workos_user_id
  let account = await findAccountByWorkosId(sub);
  if (account) {
    // Ensure membership exists in org team (matches Actions ensureOrgTeam)
    await ensureTeamMembership(account.user_id, account.email, partition);
    setWorkosSubCacheEntry(sub, account.user_id, true);
    return account.user_id;
  }

  // Step 3: Fetch email from WorkOS API
  const profile = await fetchWorkOSUserProfile(sub);

  // Step 4: DB lookup by email
  account = await findAccountByEmail(profile.email);
  if (account) {
    // Backfill workos_user_id if missing
    if (!account.workos_user_id) {
      await backfillWorkosId(account.id, sub);
    }
    // Ensure membership exists in org team (matches Actions ensureOrgTeam)
    await ensureTeamMembership(account.user_id, profile.email, partition);
    setWorkosSubCacheEntry(sub, account.user_id, true);
    return account.user_id;
  }

  // Step 5: Create new user, account, team, membership, role
  try {
    const displayName =
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
      profile.email;

    // Create user
    const userResult = await fetchGraphQL(createUserMutation, {
      display_name: displayName,
      avatar_url: profile.profilePictureUrl || null,
    });
    const userId = userResult.data?.insert_users_one?.id;
    if (!userId) {
      const error = new Error("503: Unable to provision user");
      error.status = 503;
      throw error;
    }

    // Create account (on_conflict: accounts_email_key)
    await fetchGraphQL(createAccountMutation, {
      user_id: userId,
      email: profile.email,
      workos_user_id: sub,
    });

    // Find or create team (on_conflict: teams_name_unique)
    const teamName = deriveTeamName(profile.email, partition);
    let team = await findTeamByName(teamName);
    let isTeamCreator = false;

    if (!team) {
      const initialSettings = partition ? { partition } : {};
      const teamResult = await fetchGraphQL(createTeamMutation, {
        name: teamName,
        user_id: userId,
        settings:
          Object.keys(initialSettings).length > 0 ? initialSettings : null,
      });

      const teamId = teamResult.data?.insert_teams_one?.id;
      if (teamId) {
        team = { id: teamId };
        isTeamCreator = true;
      } else {
        // on_conflict returned null — team was created concurrently, re-fetch
        team = await findTeamByName(teamName);
      }
    }

    if (!team) {
      const error = new Error("503: Unable to provision user");
      error.status = 503;
      throw error;
    }

    // Create membership (on_conflict: members_user_id_team_id_key)
    const memberResult = await fetchGraphQL(createMemberMutation, {
      user_id: userId,
      team_id: team.id,
    });
    let memberId = memberResult.data?.insert_members_one?.id;

    // If on_conflict returned null, membership exists — look up the ID
    // to ensure member role exists (retry-safety for partial provisioning)
    if (!memberId) {
      const existing = await fetchGraphQL(findMemberByUserAndTeamQuery, {
        user_id: userId,
        team_id: team.id,
      });
      const member = existing.data?.members?.[0];
      memberId = member?.id;
      // If role already exists, skip creation
      if (member?.member_roles?.length > 0) memberId = null;
    }

    // Create member role (on_conflict: member_roles_member_id_team_role_key)
    if (memberId) {
      await fetchGraphQL(createMemberRoleMutation, {
        member_id: memberId,
        team_role: isTeamCreator ? "owner" : "member",
      });
    }

    // Cache ONLY on full success (FR-013), mark membership verified
    setWorkosSubCacheEntry(sub, userId, true);
    return userId;
  } catch (err) {
    // Do NOT cache on failure — let next request retry
    if (err.status) throw err;
    const error = new Error("503: Unable to provision user");
    error.status = 503;
    throw error;
  }
}

