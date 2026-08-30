import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mergeEnrichmentEntitlement,
  reconcileEnrichmentEntitlement,
  resolveEnrichmentEntitlement,
} from "../../utils/defaultModels/enrichmentEntitlement.js";

const KEY = "test-only-entitlement-key-with-at-least-32-bytes";
const BILLING_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-30T12:00:00.000Z");

const signedLease = (overrides = {}) => {
  const payload = {
    schema_version: 1,
    account_partition: "customer.is",
    enabled: true,
    entitlement_revision: "7",
    issued_at: "2026-08-30T11:55:00.000Z",
    valid_until: "2026-08-30T12:25:00.000Z",
    products: ["ctx:day-archetype", "ctx:weather-archetype"],
    billing_connection_id: BILLING_CONNECTION_ID,
    ...overrides,
  };
  return {
    payload,
    signature_version: "hmac-sha256-v1",
    signature: createHmac("sha256", KEY)
      .update(JSON.stringify(payload))
      .digest("base64url"),
  };
};

const config = {
  enrichmentEntitlementUrl:
    "http://cxs2.cxs2.svc.cluster.local/api/internal/semantic-layer/enrichment-entitlements",
  enrichmentServiceKey: "service-key",
  enrichmentSigningKey: KEY,
  enrichmentTimeoutMs: 1_000,
};

describe("enrichment entitlement reconciliation", () => {
  it("accepts a matching signed, unexpired lease", async () => {
    const result = await resolveEnrichmentEntitlement("customer.is", config, {
      now: () => NOW,
      fetchImpl: async () => ({ ok: true, json: async () => signedLease() }),
    });
    assert.equal(result.valid, true);
    assert.equal(result.enabled, true);
    assert.equal(result.lease.entitlement_revision, "7");
    assert.equal(result.lease.billing_connection_id, BILLING_CONNECTION_ID);
  });

  it("fails closed on signature tampering, expiry, and account mismatch", async () => {
    for (const lease of [
      { ...signedLease(), signature: "tampered" },
      signedLease({ valid_until: "2026-08-30T11:59:59.000Z" }),
      signedLease({ account_partition: "other.is" }),
      signedLease({ billing_connection_id: null }),
    ]) {
      const result = await resolveEnrichmentEntitlement("customer.is", config, {
        now: () => NOW,
        fetchImpl: async () => ({ ok: true, json: async () => lease }),
      });
      assert.equal(result.valid, false);
      assert.equal(result.enabled, false);
    }
  });

  it("fails closed when cxs2 is unavailable", async () => {
    const result = await resolveEnrichmentEntitlement("customer.is", config, {
      now: () => NOW,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    assert.equal(result.valid, false);
    assert.equal(result.enabled, false);
    assert.equal(result.reason, "authority_unavailable");
  });

  it("merges the lease without clobbering sibling team settings", () => {
    const settings = {
      partition: "customer.is",
      default_models: { opt_out: ["team-model"] },
      premium: { another_product: { enabled: true } },
    };
    const merged = mergeEnrichmentEntitlement(settings, {
      valid: true,
      enabled: true,
      lease: {
        enabled: true,
        entitlement_revision: "7",
        issued_at: "2026-08-30T11:55:00.000Z",
        valid_until: "2026-08-30T12:25:00.000Z",
        signature_version: "hmac-sha256-v1",
        signature: "opaque",
        products: ["ctx:day-archetype", "ctx:weather-archetype"],
        billing_connection_id: BILLING_CONNECTION_ID,
      },
    });
    assert.deepEqual(merged.default_models, settings.default_models);
    assert.deepEqual(merged.premium.another_product, { enabled: true });
    assert.equal(merged.premium.enrichment.enabled, true);
  });

  it("persists a disabled lease on outage so a prior grant is revoked", async () => {
    const persisted = [];
    const team = {
      id: "team-1",
      settings: {
        partition: "customer.is",
        premium: { enrichment: { enabled: true, entitlement_revision: "6" } },
      },
    };
    const result = await reconcileEnrichmentEntitlement(team, config, {
      resolve: async () => ({ valid: false, enabled: false, reason: "authority_unavailable" }),
      persist: async (teamId, settings) => persisted.push({ teamId, settings }),
    });
    assert.equal(result.team.settings.premium.enrichment.enabled, false);
    assert.equal(result.enrichmentEnabled, false);
    assert.equal(result.enrichmentRevokeRequired, true);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].settings.partition, "customer.is");
  });
});
