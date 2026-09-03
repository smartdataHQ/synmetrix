import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildConnectionCalled } from "../eventEmitter.js";

const PRICING = {
  amount: "0.42",
  currency: "ISK",
  pricing: "estimated",
  pricingSource: "legacy_runtime_rate",
  components: [
    {
      meter: "request",
      units: "1",
      unit_size: "1",
      rate: "0.42",
      subtotal: "0.42",
      source: "legacy_runtime_rate",
    },
  ],
  legacyRateSource: "enrichment-pricing-2026-08-30",
};

const BASE = {
  partition: "tenant.is",
  accountId: "account-real-1",
  connectionId: "connection-real-1",
  provider: "synmetrix",
  item: "ctx:day-archetype",
  billingMode: true,
  messageId: "d0ad3bb0-7508-5b09-9764-42b7b61ac19f",
  logicalExecutionId: "logical-execution-1",
  surface: "rest-load",
  accountingScope: "customer_usage",
  cacheStatus: "cache_hit",
  returnedRows: 0,
  recordCount: 1,
  unitAmount: "0.42",
  pricingCodeVersion: "enrichment-pricing-2026-08-30",
  pricingResolution: PRICING,
  timestamp: "2026-08-30T10:00:00.000Z",
};

describe("strict Connection Called billing builder", () => {
  it("preserves a caller-supplied deterministic message id", () => {
    const event = buildConnectionCalled(BASE);
    assert.equal(event.message_id, BASE.messageId);
    assert.equal(event.metrics.record_count, 1);
  });

  it("requires real Account and Connection identities without partition fallback", () => {
    for (const missing of ["accountId", "connectionId"]) {
      assert.throws(
        () => buildConnectionCalled({ ...BASE, [missing]: null }),
        /billing requires real Account and Connection identities/,
      );
    }
    const event = buildConnectionCalled(BASE);
    assert.ok(
      event.involves.some(
        (edge) => edge.role === "OWNED_BY" && edge.id === BASE.accountId,
      ),
    );
    assert.ok(
      event.involves.some(
        (edge) =>
          edge.role === "USES_CONNECTION" && edge.id === BASE.connectionId,
      ),
    );
  });

  it("freezes currency, amount, unit amount, pricing source, and code version as historic facts", () => {
    const event = buildConnectionCalled(BASE);
    assert.deepEqual(event.analysis[0], {
      item: BASE.item,
      provider: BASE.provider,
      variant: null,
      amount: 0.42,
      currency: "ISK",
    });
    assert.equal(event.properties.pricing, "estimated");
    assert.equal(event.properties.pricing_source, "legacy_runtime_rate");
    assert.equal(
      event.properties.pricing_code_version,
      BASE.pricingCodeVersion,
    );
    assert.equal(event.properties.unit_amount, BASE.unitAmount);
    assert.equal(
      event.properties.logical_execution_id,
      BASE.logicalExecutionId,
    );
    assert.equal(event.properties.returned_rows, 0);
    assert.equal(event.properties.cache_status, "cache_hit");
    assert.equal(event.dimensions.accounting_scope, "customer_usage");
    assert.equal(event.properties.accounting_scope, undefined);
    assert.equal(event.dimensions.surface, "rest-load");
    assert.equal(event.dimensions.accounting_scope, "customer_usage");
  });

  it("rejects incomplete historic pricing facts in billing mode", () => {
    for (const missing of [
      "messageId",
      "logicalExecutionId",
      "surface",
      "accountingScope",
      "pricingCodeVersion",
      "unitAmount",
    ]) {
      assert.throws(
        () => buildConnectionCalled({ ...BASE, [missing]: null }),
        /billing requires/,
      );
    }
  });
});
