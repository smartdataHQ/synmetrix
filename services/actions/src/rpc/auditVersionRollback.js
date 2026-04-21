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

const BRANCH_DATASOURCE_QUERY = `
  query BranchWithDatasource($id: uuid!) {
    branches_by_pk(id: $id) {
      id
      datasource_id
    }
  }
`;

/**
 * audit_version_rollback — Hasura event trigger handler.
 *
 * Fires AFTER a `versions.insert` commits. Because the trigger in
 * tables.yaml matches `insert with columns: '*'`, we filter here for
 * `origin = 'rollback'` to ignore normal authoring/smart_gen inserts.
 */
export default async (session, input) => {
  const row = input?.event?.data?.new;
  if (!row?.id || row.origin !== "rollback") {
    return { ok: true, skipped: true };
  }

  const sessionVars = input?.event?.session_variables || session || {};
  const userId =
    sessionVars["x-hasura-user-id"] ||
    sessionVars["X-Hasura-User-Id"] ||
    row.user_id ||
    null;

  let datasourceId = null;
  if (row.branch_id) {
    try {
      const br = await fetchGraphQL(BRANCH_DATASOURCE_QUERY, {
        id: row.branch_id,
      });
      datasourceId = br?.data?.branches_by_pk?.datasource_id || null;
    } catch {
      // non-fatal
    }
  }

  try {
    const res = await fetchGraphQL(INSERT_AUDIT, {
      action: "version_rollback",
      user_id: userId,
      datasource_id: datasourceId,
      branch_id: row.branch_id || null,
      target_id: row.id,
      outcome: "success",
      error_code: null,
      payload: { origin: row.origin, checksum: row.checksum },
    });
    const id = res?.data?.insert_audit_logs_one?.id;
    return { ok: true, auditLogId: id };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
};
