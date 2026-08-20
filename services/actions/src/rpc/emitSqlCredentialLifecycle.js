import { fetchGraphQL } from "../utils/graphql.js";
import { emitLifecycleEvent } from "../utils/semanticEvents.js";

/**
 * emit_sql_credential_lifecycle — Hasura event-trigger handler (099 US7, FR-091, T089).
 *
 * Fires on `sql_credentials` INSERT and DELETE (raw-GraphQL, no JS chokepoint).
 * INSERT → `SQL Credential Created`, DELETE → `SQL Credential Deleted`. Emits the
 * canonical lifecycle event to the FraiOS ingress via the never-throw
 * `emitLifecycleEvent` substrate.
 *
 * Tenant: partition == the owning synmetrix team (team.settings.partition);
 * accountId == the team id — resolved from the credential's datasource → team
 * (admin-secret read). A legacy credential whose datasource has no FraiOS tenant
 * (no team / no partition) is skipped rather than filed under a synthetic tenant
 * (A4). ABOUT carries the credential id under the Secret family; the secret value
 * is NEVER included. Emission is fire-and-forget and never fails the trigger (FR-007).
 */
const DATASOURCE_TENANT = `
  query DatasourceTenant($id: uuid!) {
    datasources_by_pk(id: $id) {
      id
      name
      team_id
      team { id name settings }
    }
  }
`;

export default async (session, input) => {
  const op = input?.event?.op; // "INSERT" | "DELETE" | "MANUAL"
  const isDelete = op === "DELETE";
  const row = isDelete ? input?.event?.data?.old : input?.event?.data?.new;
  if (!row?.id || !row.datasource_id) {
    return { ok: true, skipped: true };
  }

  let datasource = null;
  try {
    const res = await fetchGraphQL(DATASOURCE_TENANT, { id: row.datasource_id });
    datasource = res?.data?.datasources_by_pk || null;
  } catch {
    // non-fatal
  }

  const team = datasource?.team || null;
  const partition = team?.settings?.partition ?? null;
  const accountId = team?.id ?? null;
  if (!accountId && !partition) {
    // Legacy credential with no FraiOS tenant → skip (A4).
    return { ok: true, skipped: true };
  }

  const sessionVars = input?.event?.session_variables || session || {};
  const userId =
    row.user_id ||
    sessionVars["x-hasura-user-id"] ||
    sessionVars["X-Hasura-User-Id"] ||
    null;

  const result = await emitLifecycleEvent({
    event: isDelete ? "SQL Credential Deleted" : "SQL Credential Created",
    partition,
    accountId,
    accountLabel: team?.name ?? null,
    userId,
    about: {
      entity_type: "Secret",
      id: row.id,
      label: row.username ?? null, // username only — the secret value is never emitted
    },
    status: isDelete ? "deleted" : "created",
    properties: {
      datasource_id: row.datasource_id,
      username: row.username ?? null,
    },
  });

  return { ok: true, emitted: !!result?.ok, skipped: !!result?.skipped };
};
