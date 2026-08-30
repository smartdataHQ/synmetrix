import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  billingMetricsSnapshot,
  incrementBillingMetric,
  readBillingOutboxGauges,
  renderBillingMetrics,
  resetBillingMetricsForTest,
} from "../billingMetrics.js";

describe("bounded billing Prometheus metrics", () => {
  beforeEach(() => resetBillingMetricsForTest());

  it("accepts only the closed counter vocabulary", () => {
    incrementBillingMetric("emitted", 2);
    incrementBillingMetric("deduplicated");
    assert.equal(billingMetricsSnapshot().emitted, 2);
    assert.equal(billingMetricsSnapshot().deduplicated, 1);
    assert.throws(
      () => incrementBillingMetric("tenant-account-1"),
      /unknown billing metric/,
    );
  });

  it("reads aggregate stream, pending, DLQ, and oldest-age gauges", async () => {
    const nowMs = 2_000_000;
    const redis = {
      xlen: async () => 3,
      xpending: async () => [4, "1000000-0", "1900000-0", []],
      xinfo: async () => [
        [
          "name",
          "synmetrix-billing-delivery",
          "pending",
          4,
          "last-delivered-id",
          "1100000-0",
          "lag",
          8,
        ],
      ],
      xrange: async () => [["1200000-0", []]],
    };
    assert.deepEqual(await readBillingOutboxGauges(redis, { nowMs }), {
      backlog: 12,
      pending: 4,
      dlq: 3,
      oldestUndeliveredAgeSeconds: 1000,
    });
  });

  it("renders no sensitive labels or values", () => {
    incrementBillingMetric("unmeterable");
    const output = renderBillingMetrics(
      billingMetricsSnapshot(),
      {
        backlog: 2,
        pending: 1,
        dlq: 0,
        oldestUndeliveredAgeSeconds: 4,
      },
      { workerUp: true },
    );
    assert.match(output, /synmetrix_billing_unmeterable_total 1/);
    assert.match(output, /synmetrix_billing_outbox_worker_up 1/);
    assert.doesNotMatch(
      output,
      /account|partition|tenant|coordinate|geohash|execution|query|sql/i,
    );
  });
});
