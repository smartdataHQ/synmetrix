import { fetchGraphQL } from "./graphql.js";

// --- User scope cache: keyed by userId, 30s TTL ---
const userCache = new Map();
const USER_CACHE_TTL = 30_000;
const USER_CACHE_MAX_SIZE = 500;

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
