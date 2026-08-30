import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  enqueueBillingBatch,
  enqueueBillingEvent,
  loadAndReplayBillingDlqEntry,
  replayBillingDlqEntry,
} from "../billingOutbox.js";
import {
  BillingOutboxWorker,
  processBillingEntry,
} from "../billingOutboxWorker.js";

const ENVELOPE = {
  event: "Connection Called",
  message_id: "billing-message-1",
  involves: [],
};
const CONTEXT = { accountId: "account-1", partition: "tenant.is" };

describe("durable billing outbox", () => {
  it("atomically enqueues a complete multi-item result commit", async () => {
    let evalArgs;
    const redis = {
      eval: async (...args) => {
        evalArgs = args;
        return ["1700000000000-0", "duplicate"];
      },
    };
    const results = await enqueueBillingBatch(redis, [
      { envelope: ENVELOPE, context: CONTEXT },
      {
        envelope: { ...ENVELOPE, message_id: "billing-message-2" },
        context: CONTEXT,
      },
    ]);
    assert.match(evalArgs[0], /for index = 1, count/);
    assert.match(evalArgs[0], /XADD/);
    assert.equal(evalArgs[1], 3);
    assert.equal(results[0].enqueued, true);
    assert.equal(results[1].duplicate, true);
  });

  it("atomically deduplicates enqueue by deterministic message id", async () => {
    const calls = [];
    const redis = {
      eval: async (...args) => {
        calls.push(args);
        return calls.length === 1 ? "1700000000000-0" : "duplicate";
      },
    };
    const first = await enqueueBillingEvent(redis, ENVELOPE, CONTEXT);
    const second = await enqueueBillingEvent(redis, ENVELOPE, CONTEXT);
    assert.equal(first.enqueued, true);
    assert.equal(second.enqueued, false);
    assert.match(calls[0][0], /XADD/);
    assert.match(calls[0][0], /SET/);
    assert.equal(calls[0].at(-3), ENVELOPE.message_id);
    assert.match(calls[0][0], /MAXLEN/);
  });

  it("acknowledges only after ingress success", async () => {
    const calls = [];
    const redis = {
      xack: async (...args) => calls.push(["ack", ...args]),
      hdel: async (...args) => calls.push(["hdel", ...args]),
    };
    const result = await processBillingEntry(
      redis,
      [
        "1-0",
        [
          "envelope",
          JSON.stringify(ENVELOPE),
          "context",
          JSON.stringify(CONTEXT),
        ],
      ],
      { send: async () => ({ ok: true }) },
    );
    assert.equal(result, "acknowledged");
    assert.equal(calls[0][0], "ack");
  });

  it("leaves a failed entry pending for restart/reclaim before the retry limit", async () => {
    const calls = [];
    const redis = {
      hincrby: async () => 2,
      xack: async (...args) => calls.push(["ack", ...args]),
      xadd: async (...args) => calls.push(["dlq", ...args]),
    };
    const result = await processBillingEntry(
      redis,
      [
        "2-0",
        [
          "envelope",
          JSON.stringify(ENVELOPE),
          "context",
          JSON.stringify(CONTEXT),
        ],
      ],
      { send: async () => ({ ok: false }), maxAttempts: 3 },
    );
    assert.equal(result, "pending");
    assert.deepEqual(calls, []);
  });

  it("moves poison entries to a DLQ and acknowledges the original", async () => {
    const calls = [];
    const redis = {
      hincrby: async () => 3,
      xadd: async (...args) => calls.push(["dlq", ...args]),
      xack: async (...args) => calls.push(["ack", ...args]),
      hdel: async (...args) => calls.push(["hdel", ...args]),
    };
    const result = await processBillingEntry(
      redis,
      [
        "3-0",
        [
          "envelope",
          JSON.stringify(ENVELOPE),
          "context",
          JSON.stringify(CONTEXT),
        ],
      ],
      { send: async () => ({ ok: false }), maxAttempts: 3 },
    );
    assert.equal(result, "dead_lettered");
    assert.equal(calls[0][0], "dlq");
    assert.equal(calls[1][0], "ack");
  });

  it("replays a DLQ entry with a distinct replay idempotency key", async () => {
    let evalArgs;
    const redis = {
      eval: async (...args) => {
        evalArgs = args;
        return "4-0";
      },
      xdel: async () => 1,
    };
    const result = await replayBillingDlqEntry(redis, "9-0", {
      envelope: ENVELOPE,
      context: CONTEXT,
    });
    assert.equal(result.enqueued, true);
    assert.match(evalArgs.at(-3), /billing-message-1:replay:9-0/);
  });

  it("loads an exact DLQ stream id for operator replay", async () => {
    const redis = {
      xrange: async () => [
        [
          "9-1",
          [
            "envelope",
            JSON.stringify(ENVELOPE),
            "context",
            JSON.stringify(CONTEXT),
          ],
        ],
      ],
      eval: async () => "10-0",
      xdel: async () => 1,
    };
    const result = await loadAndReplayBillingDlqEntry(redis, "9-1");
    assert.equal(result.enqueued, true);
  });

  it("reclaims pending entries after a worker restart", async () => {
    const calls = [];
    const redis = {
      xautoclaim: async (...args) => {
        calls.push(["claim", ...args]);
        return [
          "0-0",
          [
            [
              "7-0",
              [
                "envelope",
                JSON.stringify(ENVELOPE),
                "context",
                JSON.stringify(CONTEXT),
              ],
            ],
          ],
        ];
      },
      xack: async (...args) => calls.push(["ack", ...args]),
      hdel: async () => 1,
    };
    const worker = new BillingOutboxWorker(redis, {
      consumer: "replacement-worker",
      send: async () => ({ ok: true }),
    });
    await worker.reclaim();
    assert.equal(calls[0][0], "claim");
    assert.equal(calls[1][0], "ack");
  });

  it("treats an existing consumer group as an idempotent restart", async () => {
    const worker = new BillingOutboxWorker({
      xgroup: async () => {
        throw new Error("BUSYGROUP Consumer Group name already exists");
      },
    });
    await assert.doesNotReject(worker.ensureGroup());
  });
});
