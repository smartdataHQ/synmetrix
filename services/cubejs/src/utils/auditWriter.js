import { fetchGraphQL } from "./graphql.js";

const INSERT_AUDIT_LOG = `
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

const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * writeAuditLog — durable audit writer for persistent mutating operations
 * (FR-016). Handlers call this directly on every failure branch; success
 * inserts are captured by Hasura event triggers.
 *
 * Best-effort with 3 attempts and exponential backoff. If every attempt fails,
 * a structured stderr line is emitted as a last-resort observation. The
 * caller is not informed of the write failure — audit bookkeeping must never
 * block a user response.
 *
 * The admin-secret path is used (no authToken passed to fetchGraphQL) so
 * permission policies on `audit_logs` (admin-only) do not reject the write.
 *
 * @param {object} args
 * @param {'dataschema_delete'|'version_rollback'} args.action
 * @param {string} args.userId
 * @param {string} args.targetId
 * @param {string} [args.datasourceId]
 * @param {string} [args.branchId]
 * @param {'success'|'failure'} args.outcome
 * @param {string} [args.errorCode]   - required when outcome==='failure'
 * @param {object} [args.payload]     - operation-specific detail (jsonb)
 * @returns {Promise<{ok:true, id:string} | {ok:false}>}
 */
export async function writeAuditLog({
  action,
  userId,
  datasourceId = null,
  branchId = null,
  targetId,
  outcome,
  errorCode = null,
  payload = null,
} = {}) {
  if (!action || !userId || !targetId || !outcome) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "audit_write_failed",
        reason: "missing_required_fields",
        action,
        userId,
        targetId,
        outcome,
        ts: new Date().toISOString(),
      })
    );
    return { ok: false };
  }

  const variables = {
    action,
    user_id: userId,
    datasource_id: datasourceId,
    branch_id: branchId,
    target_id: targetId,
    outcome,
    error_code: errorCode,
    payload,
  };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetchGraphQL(INSERT_AUDIT_LOG, variables);
      const id = res?.data?.insert_audit_logs_one?.id;
      if (id) return { ok: true, id };
      lastErr = new Error("insert_audit_logs_one returned no id");
    } catch (err) {
      lastErr = err;
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }

  console.error(
    JSON.stringify({
      level: "error",
      event: "audit_write_failed",
      reason: lastErr?.message || "unknown",
      action,
      userId,
      targetId,
      outcome,
      errorCode,
      ts: new Date().toISOString(),
    })
  );
  return { ok: false };
}
