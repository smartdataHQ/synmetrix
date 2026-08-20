import { devLogger } from "@cubejs-backend/server-core/dist/src/core/logger.js";
import { emitQueryLog } from "./eventEmitter.js";
import redisClient from "./redis.js";

/**
 * Asynchronous function to log a message and an event.
 *
 * @param {string} message - The message to log.
 * @param {Object} event - The event to log.
 * @param {string} event.requestId - The ID of the request.
 * @param {string} event.path - The path of the request.
 * @param {Object} event.securityContext - The security context of the request.
 * @returns {Promise} - A promise that resolves when the logging is complete.
 *
 * @throws {Error} - Throws an error if the Redis client is not ready or if the Redis command fails.
 */
export const logging = async (message, event) => {
  const requestId = event?.requestId;

  const log = devLogger("info")(message, event);

  if (log) {
    console.log(log);
  }

  if (redisClient?.status !== "ready") {
    console.warn(
      "Redis is disabled. To view logs in UI, set the REDIS_ADDR or check the connection."
    );
    return;
  }

  if (!requestId || requestId?.includes("scheduler")) {
    return;
  }

  const data = event;
  data.event = message;

  if (data.path) {
    data.path = data.path?.split("?")?.[0];
  }

  data.timestamp = new Date().toISOString();

  if (data?.securityContext) {
    const sc = data.securityContext;
    data.userId = sc?.userId;
    data.dataSourceId = sc?.userScope?.dataSource?.dataSourceId;

    // 099 FR-091: mirror a COMPLETED cube analytical query into a buffered
    // `type='log'` `Query Executed` semantic event. ENQUEUE-ONLY — never awaited,
    // never throws — so query performance is untouched; a background flusher does
    // the ingression POSTs off the query path (see eventEmitter.emitQueryLog).
    if (message === "Load Request Success") {
      const ds = sc?.userScope?.dataSource;
      emitQueryLog({
        accountId: sc?.accountId ?? null,
        partition: sc?.partition ?? null,
        userId: sc?.userId ?? null,
        status: "ok",
        dimensions: {
          surface: "load",
          ...(ds?.dbType ? { datasource_type: ds.dbType } : {}),
        },
        metrics: Number.isFinite(Number(data?.duration))
          ? { duration_ms: Number(data.duration) }
          : {},
        properties: {
          ...(data.dataSourceId ? { datasource_id: String(data.dataSourceId) } : {}),
          ...(requestId ? { request_id: String(requestId) } : {}),
          ...(data.path ? { path: String(data.path) } : {}),
        },
      });
    }

    delete data.securityContext;
  }

  await redisClient.xadd(
    "streams:cubejs-logs-stream",
    "*",
    "data",
    JSON.stringify(data)
  );
};
