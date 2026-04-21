import { fetchGraphQL } from "../utils/graphql.js";

const DELETE_STALE = `
  mutation DeleteStaleAuditLogs($cutoff: timestamptz!) {
    delete_audit_logs(where: {created_at: {_lt: $cutoff}}) {
      affected_rows
    }
  }
`;

/**
 * audit_logs_retention — Hasura cron trigger handler.
 *
 * Deletes `audit_logs` rows older than 90 days (FR-016 retention clause).
 * Scheduled daily by `audit_logs_retention_90d` in
 * services/hasura/metadata/cron_triggers.yaml.
 */
export default async () => {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await fetchGraphQL(DELETE_STALE, { cutoff });
    const affected =
      res?.data?.delete_audit_logs?.affected_rows ?? 0;
    return { deleted: affected, cutoff };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
};
