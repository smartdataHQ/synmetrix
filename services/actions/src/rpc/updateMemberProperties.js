import apiError from "../utils/apiError.js";
import { invalidateAllUserCaches } from "../utils/cubeCache.js";
import { fetchGraphQL } from "../utils/graphql.js";
import { isPortalAdmin } from "../utils/portalAdmin.js";

const getMemberQuery = `
  query GetMember($member_id: uuid!) {
    members_by_pk(id: $member_id) {
      id
      properties
    }
  }
`;

const updateMemberMutation = `
  mutation UpdateMemberProperties($member_id: uuid!, $properties: jsonb!) {
    update_members_by_pk(pk_columns: { id: $member_id }, _set: { properties: $properties }) {
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

    const { member_id, properties } = input || {};
    if (!member_id || !properties) {
      return { success: false };
    }

    // Fetch current properties
    const memberRes = await fetchGraphQL(getMemberQuery, { member_id });
    const currentProps = memberRes?.data?.members_by_pk?.properties || {};

    // Merge properties: null values delete keys
    const merged = { ...currentProps };
    for (const [key, value] of Object.entries(properties)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }

    await fetchGraphQL(updateMemberMutation, {
      member_id,
      properties: merged,
    });

    // Bust CubeJS user cache — member properties changed
    invalidateAllUserCaches();

    return { success: true };
  } catch (err) {
    return apiError(err);
  }
};
