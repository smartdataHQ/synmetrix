import { fetchGraphQL } from "../utils/graphql.js";
import { provisionDefaultDatasources } from "../utils/provisionDefaultDatasources.js";
import logger from "../utils/logger.js";

const allTeamsQuery = `
  query AllTeams {
    teams {
      id
      user_id
    }
  }
`;

export default async (session, input) => {
  const res = await fetchGraphQL(allTeamsQuery);
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
