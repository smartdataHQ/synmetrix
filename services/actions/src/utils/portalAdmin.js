import { fetchGraphQL } from "./graphql.js";

const PORTAL_ADMIN_DOMAIN = "@snjallgogn.is";

const accountEmailQuery = `
  query GetAccountEmail($user_id: uuid!) {
    auth_accounts(where: { user_id: { _eq: $user_id } }, limit: 1) {
      email
    }
  }
`;

/**
 * Check if a user is a portal admin by verifying their email domain.
 * @param {string} userId - The user's UUID
 * @returns {Promise<boolean>}
 */
export async function isPortalAdmin(userId) {
  if (!userId) return false;

  const result = await fetchGraphQL(accountEmailQuery, { user_id: userId });
  const email = result?.data?.auth_accounts?.[0]?.email;

  if (!email) return false;
  return email.endsWith(PORTAL_ADMIN_DOMAIN);
}
