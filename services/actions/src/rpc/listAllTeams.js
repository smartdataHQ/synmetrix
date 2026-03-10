import apiError from "../utils/apiError.js";
import { fetchGraphQL } from "../utils/graphql.js";
import { isPortalAdmin } from "../utils/portalAdmin.js";

const teamsQuery = `
  query ListAllTeams($limit: Int, $offset: Int, $where: teams_bool_exp) {
    teams(limit: $limit, offset: $offset, where: $where, order_by: { created_at: desc }) {
      id
      name
      settings
      created_at
      members_aggregate {
        aggregate {
          count
        }
      }
      datasources_aggregate {
        aggregate {
          count
        }
      }
    }
    teams_aggregate(where: $where) {
      aggregate {
        count
      }
    }
  }
`;

export default async (session, input) => {
  const userId = session?.["x-hasura-user-id"];

  try {
    const admin = await isPortalAdmin(userId);
    if (!admin) {
      return { teams: [], total: 0 };
    }

    const { limit = 50, offset = 0, search } = input || {};

    const where = search
      ? { name: { _ilike: `%${search}%` } }
      : {};

    const res = await fetchGraphQL(teamsQuery, { limit, offset, where });

    const teams = (res?.data?.teams || []).map((t) => ({
      id: t.id,
      name: t.name,
      settings: t.settings,
      member_count: t.members_aggregate?.aggregate?.count || 0,
      datasource_count: t.datasources_aggregate?.aggregate?.count || 0,
      created_at: t.created_at,
    }));

    const total = res?.data?.teams_aggregate?.aggregate?.count || 0;

    return { teams, total };
  } catch (err) {
    return apiError(err);
  }
};
