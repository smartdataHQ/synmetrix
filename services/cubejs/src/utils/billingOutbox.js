import { incrementBillingMetric } from "./billingMetrics.js";

export const BILLING_STREAM = "streams:synmetrix-billing-outbox";
export const BILLING_DLQ_STREAM = "streams:synmetrix-billing-dlq";
export const BILLING_GROUP = "synmetrix-billing-delivery";
export const BILLING_ATTEMPTS_HASH = "synmetrix-billing-attempts";
const DEDUPE_PREFIX = "synmetrix-billing-dedupe:";
const DEFAULT_MAX_LENGTH = 100_000;
const DEFAULT_DEDUPE_TTL_SECONDS = 400 * 24 * 60 * 60;

const ENQUEUE_SCRIPT = `
local existing = redis.call('GET', KEYS[2])
if existing then return 'duplicate' end
local stream_id = redis.call(
  'XADD', KEYS[1], 'MAXLEN', '~', ARGV[4], '*',
  'envelope', ARGV[1], 'context', ARGV[2], 'idempotency_key', ARGV[3]
)
redis.call('SET', KEYS[2], stream_id, 'EX', ARGV[5])
return stream_id
`;

const ENQUEUE_BATCH_SCRIPT = `
local count = tonumber(ARGV[1])
local max_length = ARGV[2]
local ttl = ARGV[3]
local result = {}

for index = 1, count do
  local key_index = index + 1
  if redis.call('GET', KEYS[key_index]) then
    result[index] = 'duplicate'
  end
end

for index = 1, count do
  if not result[index] then
    local offset = 3 + ((index - 1) * 3)
    local envelope = ARGV[offset + 1]
    local context = ARGV[offset + 2]
    local idempotency_key = ARGV[offset + 3]
    local stream_id = redis.call(
      'XADD', KEYS[1], 'MAXLEN', '~', max_length, '*',
      'envelope', envelope, 'context', context,
      'idempotency_key', idempotency_key
    )
    redis.call('SET', KEYS[index + 1], stream_id, 'EX', ttl)
    result[index] = stream_id
  end
end
return result
`;

export async function enqueueBillingEvent(
  redis,
  envelope,
  context,
  {
    idempotencyKey = envelope?.message_id,
    maxLength = DEFAULT_MAX_LENGTH,
    dedupeTtlSeconds = DEFAULT_DEDUPE_TTL_SECONDS,
  } = {},
) {
  if (!redis || !envelope || !String(idempotencyKey || "").trim()) {
    throw new Error(
      "billing outbox requires Redis, an envelope, and an idempotency key",
    );
  }
  const key = String(idempotencyKey);
  let result;
  try {
    result = await redis.eval(
      ENQUEUE_SCRIPT,
      2,
      BILLING_STREAM,
      `${DEDUPE_PREFIX}${key}`,
      JSON.stringify(envelope),
      JSON.stringify(context || {}),
      key,
      String(maxLength),
      String(dedupeTtlSeconds),
    );
  } catch (error) {
    incrementBillingMetric("enqueue_failures");
    throw error;
  }
  incrementBillingMetric(result === "duplicate" ? "deduplicated" : "emitted");
  return result === "duplicate"
    ? { enqueued: false, duplicate: true }
    : { enqueued: true, streamId: result };
}

/**
 * Atomically enqueue every charge for one logical result commit. This avoids
 * returning a result after only one item from a multi-item query was recorded.
 */
export async function enqueueBillingBatch(
  redis,
  entries,
  {
    maxLength = DEFAULT_MAX_LENGTH,
    dedupeTtlSeconds = DEFAULT_DEDUPE_TTL_SECONDS,
  } = {},
) {
  if (!redis || !Array.isArray(entries) || entries.length === 0) {
    throw new Error("billing batch requires Redis and at least one entry");
  }

  const normalized = entries.map(({ envelope, context, idempotencyKey }) => {
    const key = String(idempotencyKey || envelope?.message_id || "").trim();
    if (!envelope || !key) {
      throw new Error(
        "billing batch entry requires an envelope and idempotency key",
      );
    }
    return { envelope, context: context || {}, key };
  });
  const keys = [
    BILLING_STREAM,
    ...normalized.map(({ key }) => `${DEDUPE_PREFIX}${key}`),
  ];
  const args = [
    String(normalized.length),
    String(maxLength),
    String(dedupeTtlSeconds),
    ...normalized.flatMap(({ envelope, context, key }) => [
      JSON.stringify(envelope),
      JSON.stringify(context),
      key,
    ]),
  ];
  let results;
  try {
    results = await redis.eval(
      ENQUEUE_BATCH_SCRIPT,
      keys.length,
      ...keys,
      ...args,
    );
  } catch (error) {
    incrementBillingMetric("enqueue_failures");
    throw error;
  }

  incrementBillingMetric(
    "deduplicated",
    results.filter((value) => value === "duplicate").length,
  );
  incrementBillingMetric(
    "emitted",
    results.filter((value) => value !== "duplicate").length,
  );

  return normalized.map(({ key }, index) => {
    const value = results?.[index];
    return value === "duplicate"
      ? { idempotencyKey: key, enqueued: false, duplicate: true }
      : { idempotencyKey: key, enqueued: true, streamId: value };
  });
}

export async function replayBillingDlqEntry(redis, dlqId, entry) {
  const replayKey = `${entry?.envelope?.message_id}:replay:${dlqId}`;
  const result = await enqueueBillingEvent(
    redis,
    entry?.envelope,
    entry?.context,
    {
      idempotencyKey: replayKey,
    },
  );
  if (result.enqueued) {
    await redis.xdel(BILLING_DLQ_STREAM, dlqId);
    incrementBillingMetric("replayed");
  }
  return result;
}

function fieldsToObject(fields) {
  const result = {};
  for (let index = 0; index < (fields || []).length; index += 2) {
    result[fields[index]] = fields[index + 1];
  }
  return result;
}

export async function loadAndReplayBillingDlqEntry(redis, dlqId) {
  const rows = await redis.xrange(BILLING_DLQ_STREAM, dlqId, dlqId);
  if (!rows?.length) throw new Error("billing DLQ entry not found");
  const fields = fieldsToObject(rows[0][1]);
  return replayBillingDlqEntry(redis, dlqId, {
    envelope: JSON.parse(fields.envelope),
    context: JSON.parse(fields.context || "{}"),
  });
}
