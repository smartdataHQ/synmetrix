import { fetchGraphQL } from "../utils/graphql.js";

const INSERT_AUDIT = `
  mutation InsertAuditLog(
    $action: String!
    $user_id: uuid!
    $datasource_id: uuid
    $branch_id: uuid
    $target_id: uuid!
    $outcome: String!
    $error_code: String
    $payload: jsonb
  ) {
    insert_audit_logs_one(object: {
      action: $action,
      user_id: $user_id,
      datasource_id: $datasource_id,
      branch_id: $branch_id,
      target_id: $target_id,
      outcome: $outcome,
      error_code: $error_code,
      payload: $payload
    }) {
      id
    }
  }
`;

const BRANCH_QUERY = `
  query BranchForVersion($id: uuid!) {
    versions_by_pk(id: $id) {
      id
      branch_id
    }
  }
`;

/**
 * audit_dataschema_delete — Hasura event trigger handler.
 *
 * Fires AFTER a `dataschemas.delete` commits. Writes the `outcome='success'`
 * audit row for FR-016. The handler-level failure paths in the CubeJS route
 * `deleteDataschema.js` write the matching `outcome='failure'` rows
 * directly — this handler covers only the success path (trigger only fires
 * on committed deletes).
 */
export default async (session, input) => {
  const row = input?.event?.data?.old;
  if (!row?.id) {
    return { ok: false, error: "no event.data.old payload" };
  }

  const sessionVars = input?.event?.session_variables || session || {};
  const userId =
    sessionVars["x-hasura-user-id"] ||
    sessionVars["X-Hasura-User-Id"] ||
    row.user_id ||
    null;

  // Resolve branch_id from the deleted row's version_id.
  let branchId = null;
  if (row.version_id) {
    try {
      const br = await fetchGraphQL(BRANCH_QUERY, { id: row.version_id });
      branchId = br?.data?.versions_by_pk?.branch_id || null;
    } catch {
      // non-fatal — audit row tolerates null branch_id
    }
  }

  try {
    const res = await fetchGraphQL(INSERT_AUDIT, {
      action: "dataschema_delete",
      user_id: userId,
      datasource_id: row.datasource_id || null,
      branch_id: branchId,
      target_id: row.id,
      outcome: "success",
      error_code: null,
      payload: row,
    });
    const id = res?.data?.insert_audit_logs_one?.id;
    return { ok: true, auditLogId: id };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
};
