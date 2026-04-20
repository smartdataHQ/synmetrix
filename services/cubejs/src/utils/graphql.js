import fetch from "node-fetch";

const HASURA_ENDPOINT = process.env.HASURA_ENDPOINT;
const HASURA_GRAPHQL_ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;

/**
 * Call Hasura GraphQL.
 *
 * Legacy behaviour (default): on `res.errors`, throw with `status = 503`.
 *
 * Opt-in (`{preserveErrors: true}`): return `{data, errors, status}` without
 * throwing, so callers that need FR-017-compliant error mapping can read
 * Hasura's original `extensions.code` values (e.g. `permission-error`,
 * `not-exists`) and map them to stable Model-Management error codes.
 *
 * @param {string} query
 * @param {object} [variables]
 * @param {string} [authToken]
 * @param {{preserveErrors?: boolean}} [options]
 */
export const fetchGraphQL = async (
  query,
  variables,
  authToken,
  options = {}
) => {
  const headers = {
    "x-hasura-admin-secret": HASURA_GRAPHQL_ADMIN_SECRET,
  };

  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
    delete headers["x-hasura-admin-secret"];
  }

  const result = await fetch(HASURA_ENDPOINT, {
    method: "POST",
    body: JSON.stringify({
      query,
      variables,
    }),
    headers,
  });

  const res = await result.json();

  if (res.errors) {
    if (options?.preserveErrors) {
      return {
        data: res.data ?? null,
        errors: res.errors,
        status: result.status,
      };
    }
    const error = new Error(JSON.stringify(res.errors));
    error.status = 503;
    throw error;
  }

  return res;
};
