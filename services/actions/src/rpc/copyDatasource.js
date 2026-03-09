import { isPortalAdmin } from "../utils/portalAdmin.js";
import apiError from "../utils/apiError.js";
import { fetchGraphQL } from "../utils/graphql.js";

const getDatasourceQuery = `
  query ($id: uuid!) {
    datasources_by_pk(id: $id) {
      id
      name
      db_type
      db_params
    }
  }
`;

const insertDatasourceMutation = `
  mutation ($name: String!, $db_type: String!, $db_params: jsonb!, $team_id: uuid!, $user_id: uuid!) {
    insert_datasources_one(object: {
      name: $name,
      db_type: $db_type,
      db_params: $db_params,
      team_id: $team_id,
      user_id: $user_id,
      branches: {
        data: [{ user_id: $user_id, status: active, name: "main" }]
      }
    }) {
      id
      name
    }
  }
`;

export default async (session, input) => {
  const userId = session?.["x-hasura-user-id"];
  const { datasource_id, target_team_id } = input || {};

  try {
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const admin = await isPortalAdmin(userId);
    if (!admin) {
      throw new Error("Only portal admins can copy datasources between teams");
    }

    if (!datasource_id || !target_team_id) {
      throw new Error("datasource_id and target_team_id are required");
    }

    // Fetch the source datasource with raw (unmasked) db_params
    const sourceResult = await fetchGraphQL(getDatasourceQuery, { id: datasource_id });
    const source = sourceResult?.data?.datasources_by_pk;

    if (!source) {
      throw new Error("Datasource not found");
    }

    // Insert a copy into the target team
    const result = await fetchGraphQL(insertDatasourceMutation, {
      name: source.name,
      db_type: source.db_type,
      db_params: source.db_params,
      team_id: target_team_id,
      user_id: userId,
    });

    const newDatasource = result?.data?.insert_datasources_one;
    if (!newDatasource) {
      throw new Error("Failed to create datasource copy");
    }

    return newDatasource;
  } catch (err) {
    return apiError(err);
  }
};
