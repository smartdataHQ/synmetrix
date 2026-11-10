import { fetchGraphQL } from "../utils/graphql.js";
import { provisionDefaultDatasources } from "../utils/provisionDefaultDatasources.js";
import logger from "../utils/logger.js";

const teamsQuery = `
  query Teams($where: teams_bool_exp!) {
    teams(where: $where) {
      id
      user_id
    }
  }
`;

// With `team_id` only that team is provisioned (the CubeJS login flow calls
// this for a team it has just created); without it every team is backfilled.
export default async (session, input) => {
  const where = input?.team_id ? { id: { _eq: input.team_id } } : {};
  const res = await fetchGraphQL(teamsQuery, { where });
  const teams = res.data?.teams || [];

  logger.log(
    `[ProvisionDS] Backfill starting for ${teams.length} team(s)`
  );

  let totalCreated = 0;
  let totalSkipped = 0;
  const results = [];

  for (const team of teams) {
    const userId = team.user_id || session?.["x-hasura-user-id"];

    if (!userId) {
      logger.warn(
        `[ProvisionDS] Skipping team ${team.id}: no user_id`
      );
      results.push({ team_id: team.id, error: "no user_id" });
      continue;
    }

    const created = await provisionDefaultDatasources({
      teamId: team.id,
      userId,
    });

    totalCreated += created.length;
    results.push({ team_id: team.id, created });
  }

  logger.log(
    `[ProvisionDS] Backfill complete: ${totalCreated} created across ${teams.length} teams`
  );

  return {
    teams_processed: teams.length,
    datasources_created: totalCreated,
    results,
  };
};
