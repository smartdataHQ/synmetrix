import { fetchGraphQL } from "../utils/graphql.js";
import { emitLifecycleEvent } from "../utils/semanticEvents.js";

/**
 * emit_branch_lifecycle — Hasura event-trigger handler (099 US7, FR-091, T087).
 *
 * Fires on `branches` INSERT and DELETE (both raw-GraphQL, no JS chokepoint). One
 * handler covers both ops: INSERT → `Branch Created`, DELETE → `Branch Deleted`.
 * Emits the canonical lifecycle event to the FraiOS ingress via the never-throw
 * `emitLifecycleEvent` substrate.
 *
 * Tenant: partition == the owning synmetrix team (team.settings.partition);
 * accountId == the team id — resolved from the branch's datasource → team
 * (admin-secret read). On DELETE the tenant is resolved from the OLD row's
 * datasource_id (the datasource itself is not cascaded away by a branch delete).
 * Emission is fire-and-forget and NEVER blocks or fails the trigger (FR-007).
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
    return { ok: true, skipped: true };
  }

  const sessionVars = input?.event?.session_variables || session || {};
  const userId =
    row.user_id ||
    sessionVars["x-hasura-user-id"] ||
    sessionVars["X-Hasura-User-Id"] ||
    null;

  const result = await emitLifecycleEvent({
    event: isDelete ? "Branch Deleted" : "Branch Created",
    partition,
    accountId,
    accountLabel: team?.name ?? null,
    userId,
    about: {
      entity_type: "Data Model",
      id: row.id,
      label: row.name ?? null,
    },
    status: isDelete ? "deleted" : "created",
    properties: {
      branch_name: row.name ?? null,
      datasource_id: row.datasource_id,
      branch_status: row.status ?? null,
    },
  });

  return { ok: true, emitted: !!result?.ok, skipped: !!result?.skipped };
};
