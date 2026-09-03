import { fetchGraphQL } from "../utils/graphql.js";
import { emitLifecycleEvent } from "../utils/semanticEvents.js";

/**
 * emit_model_version_created — Hasura event-trigger handler (099 US7, FR-091, T087).
 *
 * Fires AFTER a `versions.insert` commits. The editor's "pure save" and other
 * raw-GraphQL version creations never pass through a cubejs code chokepoint, so
 * this trigger is the only place the version-creation fact can be observed. It
 * emits the canonical `Model Version Created` lifecycle event to the FraiOS
 * ingress via the never-throw `emitLifecycleEvent` substrate.
 *
 * Tenant: partition == the owning synmetrix team (team.settings.partition — the
 * exact key the semantic_events RLS filters on); accountId == the team id. Both
 * are resolved from the version's branch → datasource → team (admin-secret read,
 * so team.settings is visible). Emission is fire-and-forget and NEVER blocks or
 * fails the trigger (FR-007).
 */
const BRANCH_TENANT = `
  query BranchTenant($id: uuid!) {
    branches_by_pk(id: $id) {
      id
      name
      datasource_id
      datasource {
        id
        name
        team_id
        team { id name settings }
      }
    }
  }
`;

export default async (session, input) => {
  const row = input?.event?.data?.new;
  if (!row?.id || !row.branch_id) {
    return { ok: true, skipped: true };
  }

  let branch = null;
  try {
    const res = await fetchGraphQL(BRANCH_TENANT, { id: row.branch_id });
    branch = res?.data?.branches_by_pk || null;
  } catch {
    // non-fatal — never block the trigger on a tenant lookup
  }

  const team = branch?.datasource?.team || null;
  const partition = team?.settings?.partition ?? null;
  const accountId = team?.id ?? null;
  if (!accountId && !partition) {
    // No resolvable tenant → do not file under a synthetic one (A4).
    return { ok: true, skipped: true };
  }

  const sessionVars = input?.event?.session_variables || session || {};
  const userId =
    row.user_id ||
    sessionVars["x-hasura-user-id"] ||
    sessionVars["X-Hasura-User-Id"] ||
    null;

  const result = await emitLifecycleEvent({
    event: "Model Version Created",
    partition,
    accountId,
    accountLabel: team?.name ?? null,
    userId,
    about: {
      entity_type: "Data Model",
      id: row.branch_id,
      label: branch?.name ?? null,
    },
    status: "created",
    properties: {
      version_id: row.id,
      datasource_id: branch?.datasource_id ?? null,
      origin: row.origin ?? null,
      checksum: row.checksum ?? null,
    },
  });

  return { ok: true, emitted: !!result?.ok, skipped: !!result?.skipped };
};
