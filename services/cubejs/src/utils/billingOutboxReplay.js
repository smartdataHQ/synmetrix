import Redis from "ioredis";

import { loadAndReplayBillingDlqEntry } from "./billingOutbox.js";

const dlqId = process.argv[2];
if (!dlqId || !process.env.REDIS_ADDR) {
  process.stderr.write(
    "Usage: REDIS_ADDR=redis://... node src/utils/billingOutboxReplay.js <dlq-stream-id>\n",
  );
  process.exitCode = 2;
} else {
  const redis = new Redis(process.env.REDIS_ADDR);
  try {
    const result = await loadAndReplayBillingDlqEntry(redis, dlqId);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await redis.quit();
  }
}
