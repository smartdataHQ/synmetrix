import { hostname } from "node:os";

import { emitSemanticEvent } from "./eventEmitter.js";
import { incrementBillingMetric } from "./billingMetrics.js";
import {
  BILLING_ATTEMPTS_HASH,
  BILLING_DLQ_STREAM,
  BILLING_GROUP,
  BILLING_STREAM,
} from "./billingOutbox.js";

function fieldsToObject(fields) {
  const result = {};
  for (let index = 0; index < (fields || []).length; index += 2) {
    result[fields[index]] = fields[index + 1];
  }
  return result;
}

export async function processBillingEntry(
  redis,
  [streamId, fields],
  {
    send = emitSemanticEvent,
    maxAttempts = Number(process.env.BILLING_OUTBOX_MAX_ATTEMPTS || 8),
  } = {},
) {
  const data = fieldsToObject(fields);
  let envelope;
  let context;
  try {
    envelope = JSON.parse(data.envelope);
    context = JSON.parse(data.context || "{}");
  } catch {
    envelope = null;
    context = {};
  }

  let delivered = false;
  let failure = "invalid_outbox_payload";
  if (envelope) {
    try {
      const result = await send(envelope, context);
      delivered = result?.ok === true;
      if (!delivered) failure = "ingress_rejected";
    } catch (error) {
      failure = error?.message || "ingress_error";
    }
  }

  if (delivered) {
    await redis.xack(BILLING_STREAM, BILLING_GROUP, streamId);
    await redis.hdel(BILLING_ATTEMPTS_HASH, streamId);
    incrementBillingMetric("delivered");
    return "acknowledged";
  }

  const attempts = Number(
    await redis.hincrby(BILLING_ATTEMPTS_HASH, streamId, 1),
  );
  if (attempts < maxAttempts) {
    incrementBillingMetric("retried");
    return "pending";
  }

  await redis.xadd(
    BILLING_DLQ_STREAM,
    "*",
    "envelope",
    data.envelope || "null",
    "context",
    data.context || "{}",
    "source_id",
    streamId,
    "attempts",
    String(attempts),
    "failure",
    String(failure).slice(0, 512),
  );
  await redis.xack(BILLING_STREAM, BILLING_GROUP, streamId);
  await redis.hdel(BILLING_ATTEMPTS_HASH, streamId);
  incrementBillingMetric("dead_lettered");
  return "dead_lettered";
}

export class BillingOutboxWorker {
  constructor(
    redis,
    {
      consumer = `${hostname()}-${process.pid}`,
      blockMs = 5_000,
      reclaimIdleMs = 30_000,
      batchSize = 25,
      send = emitSemanticEvent,
    } = {},
  ) {
    this.redis = redis;
    this.consumer = consumer;
    this.blockMs = blockMs;
    this.reclaimIdleMs = reclaimIdleMs;
    this.batchSize = batchSize;
    this.send = send;
    this.running = false;
    this.loopPromise = null;
  }

  async ensureGroup() {
    try {
      await this.redis.xgroup(
        "CREATE",
        BILLING_STREAM,
        BILLING_GROUP,
        "0",
        "MKSTREAM",
      );
    } catch (error) {
      if (!String(error?.message || error).includes("BUSYGROUP")) throw error;
    }
  }

  async process(entries) {
    for (const entry of entries || []) {
      await processBillingEntry(this.redis, entry, { send: this.send });
    }
  }

  async reclaim() {
    const result = await this.redis.xautoclaim(
      BILLING_STREAM,
      BILLING_GROUP,
      this.consumer,
      this.reclaimIdleMs,
      "0-0",
      "COUNT",
      this.batchSize,
    );
    await this.process(result?.[1] || []);
  }

  async loop() {
    await this.ensureGroup();
    await this.reclaim();
    while (this.running) {
      const response = await this.redis.xreadgroup(
        "GROUP",
        BILLING_GROUP,
        this.consumer,
        "COUNT",
        this.batchSize,
        "BLOCK",
        this.blockMs,
        "STREAMS",
        BILLING_STREAM,
        ">",
      );
      await this.process(response?.[0]?.[1] || []);
    }
  }

  start() {
    if (this.running) return this.loopPromise;
    this.running = true;
    this.loopPromise = this.loop().catch((error) => {
      this.running = false;
      console.error("billing outbox worker stopped", error);
    });
    return this.loopPromise;
  }

  async stop() {
    this.running = false;
    await this.loopPromise;
  }
}
