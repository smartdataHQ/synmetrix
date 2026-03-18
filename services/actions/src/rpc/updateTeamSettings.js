import apiError from "../utils/apiError.js";
import { invalidateAllUserCaches } from "../utils/cubeCache.js";
import { fetchGraphQL } from "../utils/graphql.js";
import { isPortalAdmin } from "../utils/portalAdmin.js";

const getTeamQuery = `
  query GetTeamSettings($team_id: uuid!) {
    teams_by_pk(id: $team_id) {
      settings
    }
  }
`;

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

const protectedKeysQuery = `
  query {
    query_rewrite_rules(where: { property_source: { _eq: "team" } }) {
      property_key
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
    // Check if caller is portal admin (alternative authorization path)
    const admin = await isPortalAdmin(userId);

    if (!admin) {
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
          message: "Only team owners or portal admins can update team settings",
        };
      }

      // Strip access-control keys from owner's payload to prevent overwriting
      // security properties like `partition`
      const protectedRes = await fetchGraphQL(protectedKeysQuery);
      const protectedKeys = new Set(
        (protectedRes?.data?.query_rewrite_rules || []).map((r) => r.property_key)
      );

      if (protectedKeys.size > 0) {
        for (const key of protectedKeys) {
          if (key in settings) {
            delete settings[key];
          }
        }
      }
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

    // Read current settings and merge to avoid overwriting existing keys
    const currentRes = await fetchGraphQL(getTeamQuery, { team_id: teamId });
    const currentSettings = currentRes?.data?.teams_by_pk?.settings || {};
    const merged = { ...currentSettings };
    for (const [key, value] of Object.entries(settings)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }

    // Update team settings
    const res = await fetchGraphQL(
      updateTeamSettingsMutation,
      { team_id: teamId, settings: merged },
      headers?.authorization
    );

    if (res?.data?.update_teams_by_pk) {
      invalidateAllUserCaches();
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
