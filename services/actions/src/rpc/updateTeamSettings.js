import apiError from "../utils/apiError.js";
import { fetchGraphQL } from "../utils/graphql.js";

const updateTeamSettingsMutation = `
  mutation ($team_id: uuid!, $settings: jsonb!) {
    update_teams_by_pk(pk_columns: {id: $team_id}, _set: {settings: $settings}) {
      id
      settings
    }
  }
`;

const memberRoleQuery = `
  query ($userId: uuid!, $teamId: uuid!) {
    members(where: {user_id: {_eq: $userId}, team_id: {_eq: $teamId}}) {
      member_roles {
        team_role
      }
    }
  }
`;

export default async (session, input, headers) => {
  const { team_id: teamId, settings } = input || {};
  const userId = session?.["x-hasura-user-id"];

  if (!teamId || !settings) {
    return {
      code: "invalid_input",
      message: "team_id and settings are required",
    };
  }

  try {
    // Verify caller is team owner
    const roleRes = await fetchGraphQL(
      memberRoleQuery,
      { userId, teamId },
      headers?.authorization
    );

    const memberRoles = roleRes?.data?.members?.[0]?.member_roles || [];
    const isOwner = memberRoles.some((r) => r.team_role === "owner");

    if (!isOwner) {
      return {
        code: "forbidden",
        message: "Only team owners can update team settings",
      };
    }

    // Validate settings shape
    if (settings.partition !== undefined && typeof settings.partition !== "string") {
      return {
        code: "invalid_input",
        message: "partition must be a string",
      };
    }

    if (settings.internal_tables !== undefined && !Array.isArray(settings.internal_tables)) {
      return {
        code: "invalid_input",
        message: "internal_tables must be an array of strings",
      };
    }

    // Update team settings
    const res = await fetchGraphQL(
      updateTeamSettingsMutation,
      { team_id: teamId, settings },
      headers?.authorization
    );

    if (res?.data?.update_teams_by_pk) {
      return {
        code: "ok",
        message: "Team settings updated successfully",
      };
    }

    return {
      code: "update_failed",
      message: "Failed to update team settings",
    };
  } catch (err) {
    return apiError(err);
  }
};
