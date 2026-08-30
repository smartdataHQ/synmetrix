import { createHmac, timingSafeEqual } from "node:crypto";

import { fetchGraphQL } from "../graphql.js";

const PRODUCTS = ["ctx:day-archetype", "ctx:weather-archetype"];

const UPDATE_TEAM_SETTINGS = `
  mutation ($teamId: uuid!, $settings: jsonb!) {
    update_teams_by_pk(pk_columns: { id: $teamId }, _set: { settings: $settings }) {
      id
    }
  }
`;

const canonicalPayload = (payload) =>
  JSON.stringify({
    schema_version: payload?.schema_version,
    account_partition: payload?.account_partition,
    enabled: payload?.enabled,
    entitlement_revision: payload?.entitlement_revision,
    issued_at: payload?.issued_at,
    valid_until: payload?.valid_until,
    products: payload?.products,
    billing_connection_id: payload?.billing_connection_id,
  });

const signaturesMatch = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
};

const disabled = (reason) => ({ valid: false, enabled: false, reason });

export const resolveEnrichmentEntitlement = async (
  partition,
  config,
  deps = {}
) => {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = (deps.now || (() => new Date()))();
  if (
    !partition ||
    !config?.enrichmentEntitlementUrl ||
    !config?.enrichmentServiceKey ||
    !config?.enrichmentSigningKey
  ) {
    return disabled("authority_unconfigured");
  }

  try {
    const url = new URL(config.enrichmentEntitlementUrl);
    url.searchParams.set("partition", partition);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${config.enrichmentServiceKey}` },
      signal: AbortSignal.timeout(config.enrichmentTimeoutMs || 5_000),
    });
    if (!response.ok) return disabled("authority_unavailable");
    const envelope = await response.json();
    const payload = envelope?.payload;
    if (
      envelope?.signature_version !== "hmac-sha256-v1" ||
      payload?.schema_version !== 1 ||
      payload?.account_partition !== partition ||
      typeof payload?.enabled !== "boolean" ||
      typeof payload?.entitlement_revision !== "string" ||
      !Array.isArray(payload?.products) ||
      payload.products.join(",") !== PRODUCTS.join(",") ||
      (payload.enabled
        ? !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            payload.billing_connection_id || "",
          )
        : payload.billing_connection_id !== null)
    ) {
      return disabled("lease_malformed");
    }
    const issuedAt = Date.parse(payload.issued_at);
    const validUntil = Date.parse(payload.valid_until);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(validUntil) ||
      issuedAt > now.getTime() ||
      validUntil <= now.getTime()
    ) {
      return disabled("lease_expired");
    }
    const expected = createHmac("sha256", config.enrichmentSigningKey)
      .update(canonicalPayload(payload))
      .digest("base64url");
    if (!signaturesMatch(expected, envelope.signature)) {
      return disabled("lease_signature_invalid");
    }

    return {
      valid: true,
      enabled: payload.enabled,
      lease: {
        enabled: payload.enabled,
        entitlement_revision: payload.entitlement_revision,
        issued_at: payload.issued_at,
        valid_until: payload.valid_until,
        signature_version: envelope.signature_version,
        signature: envelope.signature,
        products: [...payload.products],
        billing_connection_id: payload.billing_connection_id,
      },
    };
  } catch {
    return disabled("authority_unavailable");
  }
};

export const mergeEnrichmentEntitlement = (settings = {}, resolution) => {
  const current = settings?.premium?.enrichment || {};
  const enrichment = resolution.valid
    ? resolution.lease
    : {
        enabled: false,
        entitlement_revision: current.entitlement_revision || null,
        issued_at: null,
        valid_until: null,
        signature_version: null,
        signature: null,
        products: PRODUCTS,
        billing_connection_id: null,
        reason: resolution.reason || "invalid_lease",
      };
  return {
    ...settings,
    premium: {
      ...(settings.premium || {}),
      enrichment,
    },
  };
};

export const persistEnrichmentEntitlement = async (teamId, settings) => {
  await fetchGraphQL(UPDATE_TEAM_SETTINGS, { teamId, settings });
};

export const reconcileEnrichmentEntitlement = async (
  team,
  config,
  deps = {}
) => {
  const resolve = deps.resolve || resolveEnrichmentEntitlement;
  const persist = deps.persist || persistEnrichmentEntitlement;
  const resolution = await resolve(team.settings?.partition, config, deps);
  const hadLease = Boolean(team.settings?.premium?.enrichment);
  const settings =
    !hadLease && resolution.reason === "authority_unconfigured"
      ? team.settings || {}
      : mergeEnrichmentEntitlement(team.settings || {}, resolution);
  if (JSON.stringify(settings) !== JSON.stringify(team.settings || {})) {
    if (!deps.dryRun) await persist(team.id, settings);
  }
  return {
    team: { ...team, settings },
    enrichmentEnabled: resolution.valid && resolution.enabled === true,
    enrichmentRevokeRequired:
      !(resolution.valid && resolution.enabled === true) &&
      (hadLease ||
        Boolean(
          config?.enrichmentEntitlementUrl &&
            config?.enrichmentServiceKey &&
            config?.enrichmentSigningKey
        )),
    resolution,
  };
};

export const isEnrichmentTemplate = (template) =>
  template?.name === "ctx_day_context" || template?.name === "ctx_weather_context";

export const templatesForEntitlement = (templates, enabled) =>
  enabled ? templates : templates.filter((template) => !isEnrichmentTemplate(template));

export const ENRICHMENT_TEMPLATE_NAMES = [
  "ctx_day_context",
  "ctx_weather_context",
];
