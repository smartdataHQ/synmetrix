const COUNTER_NAMES = Object.freeze([
  "emitted",
  "deduplicated",
  "delivered",
  "retried",
  "replayed",
  "enqueue_failures",
  "dead_lettered",
  "unknown_pricing",
  "unmeterable",
]);

const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));

export function incrementBillingMetric(name, count = 1) {
  if (!Object.hasOwn(counters, name)) {
    throw new Error(`unknown billing metric: ${name}`);
  }
  const value = Number(count);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("billing metric increments must be non-negative integers");
  }
  counters[name] += value;
}

export function billingMetricsSnapshot() {
  return { ...counters };
}

export function resetBillingMetricsForTest() {
  for (const name of COUNTER_NAMES) counters[name] = 0;
}

export function recordBillingFailure(error) {
  const message = String(error?.message || error || "");
  if (/price|pricing|amount|currency|legacy_runtime_rate/i.test(message)) {
    incrementBillingMetric("unknown_pricing");
  } else {
    incrementBillingMetric("unmeterable");
  }
}

export async function readBillingOutboxGauges(
  redis,
  { nowMs = Date.now() } = {},
) {
  if (!redis) throw new Error("billing Redis is unavailable");
  const [dlq, pendingSummary, groups] = await Promise.all([
    redis.xlen("streams:synmetrix-billing-dlq"),
    redis.xpending(
      "streams:synmetrix-billing-outbox",
      "synmetrix-billing-delivery",
    ),
    redis.xinfo("GROUPS", "streams:synmetrix-billing-outbox"),
  ]);
  const group = (groups || []).find((fields) => {
    const values = Object.fromEntries(
      Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => [
        fields[index * 2],
        fields[index * 2 + 1],
      ]),
    );
    return values.name === "synmetrix-billing-delivery";
  });
  if (!group) throw new Error("billing consumer group is unavailable");
  const groupValues = Object.fromEntries(
    Array.from({ length: Math.floor(group.length / 2) }, (_, index) => [
      group[index * 2],
      group[index * 2 + 1],
    ]),
  );
  const pending = Number(pendingSummary?.[0] || 0);
  const lag = Number(groupValues.lag || 0);
  const pendingOldestId = pending ? String(pendingSummary?.[1] || "") : "";
  let lagOldestId = "";
  if (lag > 0) {
    const rows = await redis.xrange(
      "streams:synmetrix-billing-outbox",
      `(${groupValues["last-delivered-id"] || "0-0"}`,
      "+",
      "COUNT",
      1,
    );
    lagOldestId = String(rows?.[0]?.[0] || "");
  }
  const ages = [pendingOldestId, lagOldestId]
    .filter(Boolean)
    .map((id) => Number(id.split("-", 1)[0]))
    .filter(Number.isFinite)
    .map((timestamp) => Math.max(0, (nowMs - timestamp) / 1000));
  return {
    backlog: pending + lag,
    pending,
    dlq: Number(dlq || 0),
    oldestUndeliveredAgeSeconds: ages.length ? Math.max(...ages) : 0,
  };
}

const metricLine = (name, help, type, value) =>
  `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}`;

export function renderBillingMetrics(
  snapshot,
  gauges,
  { workerUp = false } = {},
) {
  const lines = COUNTER_NAMES.map((name) =>
    metricLine(
      `synmetrix_billing_${name}_total`,
      `Bounded billing ${name.replaceAll("_", " ")} count.`,
      "counter",
      Number(snapshot[name] || 0),
    ),
  );
  lines.push(
    metricLine(
      "synmetrix_billing_outbox_backlog_entries",
      "Undelivered billing entries (consumer-group lag plus pending).",
      "gauge",
      gauges.backlog,
    ),
    metricLine(
      "synmetrix_billing_outbox_pending_entries",
      "Entries currently pending in the billing consumer group.",
      "gauge",
      gauges.pending,
    ),
    metricLine(
      "synmetrix_billing_outbox_dlq_entries",
      "Entries currently retained in the billing dead-letter stream.",
      "gauge",
      gauges.dlq,
    ),
    metricLine(
      "synmetrix_billing_outbox_oldest_undelivered_age_seconds",
      "Age of the oldest lagging or pending billing entry.",
      "gauge",
      gauges.oldestUndeliveredAgeSeconds,
    ),
    metricLine(
      "synmetrix_billing_outbox_worker_up",
      "Whether this Cube process has a running billing delivery worker.",
      "gauge",
      workerUp ? 1 : 0,
    ),
  );
  return `${lines.join("\n")}\n`;
}

export function createBillingMetricsHandler({ redis, worker }) {
  return async (_req, res) => {
    try {
      const gauges = await readBillingOutboxGauges(redis);
      res.type("text/plain; version=0.0.4");
      return res.send(
        renderBillingMetrics(billingMetricsSnapshot(), gauges, {
          workerUp: Boolean(worker?.running),
        }),
      );
    } catch {
      return res.status(503).type("text/plain").send("billing metrics unavailable\n");
    }
  };
}
