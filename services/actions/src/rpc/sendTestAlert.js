import sendExplorationScreenshot from "./sendExplorationScreenshot.js";

import apiError from "../utils/apiError.js";
import { fetchGraphQL } from "../utils/graphql.js";

const explorationQuery = `
  query ($id: uuid!) {
    explorations_by_pk(id: $id) {
      id
      datasource_id
      user_id
      playground_state
    }
  }
`;

export default async (_, input, headers) => {
  const { explorationId, name, deliveryConfig, deliveryType } = input || {};
  const authToken = headers?.authorization;

  // Read the exploration as the caller: the runner executes it as its owner,
  // so an admin-secret read would deliver any tenant's results. Without a
  // caller token fetchGraphQL would fall back to the admin secret.
  if (!authToken) {
    return apiError("Exploration not found");
  }

  const queryResult = await fetchGraphQL(
    explorationQuery,
    { id: explorationId },
    authToken
  );
  const exploration = queryResult?.data?.explorations_by_pk;

  if (!exploration) {
    return apiError("Exploration not found");
  }

  try {
    const { error } = await sendExplorationScreenshot({
      deliveryType,
      deliveryConfig,
      exploration,
      name: name,
    });

    if (error) {
      return apiError(error);
    }
  } catch (e) {
    return apiError(e);
  }

  return { error: false, result: { fired: true } };
};
