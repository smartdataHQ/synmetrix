import apiError from "../utils/apiError.js";
import { invalidateAllUserCaches } from "../utils/cubeCache.js";
import { fetchGraphQL } from "../utils/graphql.js";
import { isPortalAdmin } from "../utils/portalAdmin.js";

const getTeamQuery = `
  query GetTeam($team_id: uuid!) {
    teams_by_pk(id: $team_id) {
      id
      settings
    }
  }
`;

const updateTeamMutation = `
  mutation UpdateTeamSettings($team_id: uuid!, $settings: jsonb!) {
    update_teams_by_pk(pk_columns: { id: $team_id }, _set: { settings: $settings }) {
      id
    }
  }
`;

export default async (session, input) => {
  const userId = session?.["x-hasura-user-id"];

  try {
    const admin = await isPortalAdmin(userId);
    if (!admin) {
      return { success: false };
    }

    const { team_id, properties } = input || {};
    if (!team_id || !properties) {
      return { success: false };
    }

    // Fetch current settings
    const teamRes = await fetchGraphQL(getTeamQuery, { team_id });
    const currentSettings = teamRes?.data?.teams_by_pk?.settings || {};

    // Merge properties: null values delete keys.
    // Also delete keys omitted from payload (UI remove action).
    const merged = { ...currentSettings };
    for (const key of Object.keys(currentSettings)) {
      if (!(key in properties)) {
        delete merged[key];
      }
    }
    for (const [key, value] of Object.entries(properties)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }

    await fetchGraphQL(updateTeamMutation, {
      team_id,
      settings: merged,
    });

    // Bust CubeJS user cache — team settings changed, affects all members
    invalidateAllUserCaches();

    return { success: true };
  } catch (err) {
    return apiError(err);
  }
};
