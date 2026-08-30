import { createHash, randomUUID } from "node:crypto";

import { enqueueBillingBatch } from "./billingOutbox.js";
import { recordBillingFailure } from "./billingMetrics.js";
import { buildConnectionCalled } from "./eventEmitter.js";
import { resolveEnrichmentCodePrice } from "./enrichmentPricing.js";
import { resolveEnrichmentBillingItems } from "./queryRewrite.js";
import { sqlEnrichmentBillingItems } from "./enrichmentEntitlement.js";

function billingError(message) {
  const error = new Error(`enrichment billing unavailable: ${message}`);
  error.status = 503;
  error.code = "enrichment_billing_unavailable";
  return error;
}

export function deterministicBillingMessageId(logicalExecutionId, item) {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${logicalExecutionId}\u0000${item}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function logicalExecutionIdForRequest(request = {}, childIndex = null) {
  const context = request.context || {};
  const headers = request.headers || {};
  const base = String(
    request.logicalExecutionId ||
      headers["x-idempotency-key"] ||
      headers["x-request-id"] ||
      context.requestId ||
      randomUUID(),
  );
  return childIndex == null ? base : `${base}:query:${childIndex}`;
}

function rootResults(message) {
  if (message?.isWrapper && typeof message.getRootResultObject === "function") {
    const root = message.getRootResultObject();
    return Array.isArray(root) ? root : [root];
  }
  if (Array.isArray(message?.results)) return message.results;
  return [message || {}];
}

function returnedRowsFor(message, index) {
  const result = rootResults(message)[index] || {};
  return Array.isArray(result?.data) ? result.data.length : 0;
}

function cacheStatusFor(message, index, fallback = "unknown") {
  const result = rootResults(message)[index] || {};
  const value = result.cacheStatus || result.cache_status;
  return value === "hit" || value === "cache_hit"
    ? "cache_hit"
    : value === "miss" || value === "cache_miss"
      ? "cache_miss"
      : fallback;
}

function queriesFor(request) {
  const query = request?.query;
  if (!query) return [];
  return Array.isArray(query) ? query : [query];
}

export function isSystemEnrichmentExecution(request = {}) {
  const context = request.context || {};
  return Boolean(
    request.systemOperation ||
    request.preAggregation ||
    request.scheduledRefresh ||
    context.systemOperation ||
    context.preAggregation ||
    context.scheduledRefresh ||
    context.requestId?.includes("scheduler"),
  );
}

export function isCancelledEnrichmentExecution(request = {}) {
  const context = request.context || {};
  return Boolean(
    request.aborted ||
      request.cancelled ||
      request.signal?.aborted ||
      context.aborted ||
      context.cancelled ||
      context.signal?.aborted,
  );
}

export async function buildEnrichmentBillingBatch(
  request,
  message,
  {
    resolveItems = resolveEnrichmentBillingItems,
    resolvePrice = resolveEnrichmentCodePrice,
    surface = request?.apiType === "sql" ? "sql-api" : "rest",
    cacheStatus = "unknown",
    returnedRows = null,
  } = {},
) {
  if (
    isSystemEnrichmentExecution(request) ||
    isCancelledEnrichmentExecution(request)
  ) {
    return [];
  }
  const queries = queriesFor(request);
  if (queries.length === 0 || message?.error) return [];

  const securityContext = request.context?.securityContext || {};
  const token = securityContext.tokenPayload || {};
  const accountId = String(token.accountId || "").trim();
  const partition = String(
    token.partition ||
      securityContext.userScope?.teamProperties?.partition ||
      "",
  ).trim();

  const entries = [];
  for (let index = 0; index < queries.length; index += 1) {
    const items = await resolveItems(queries[index], securityContext);
    if (!items.length) continue;
    if (!accountId || !partition) {
      throw billingError("real Account and tenant partition are required");
    }
    const logicalExecutionId = logicalExecutionIdForRequest(
      request,
      queries.length > 1 ? index : null,
    );
    for (const item of [...new Set(items)].sort()) {
      const price = resolvePrice(item);
      const messageId = deterministicBillingMessageId(logicalExecutionId, item);
      const envelope = buildConnectionCalled({
        partition,
        accountId,
        userId: securityContext.userId || null,
        provider: "ctx",
        item,
        connectionId: price.connectionId,
        billingMode: true,
        messageId,
        logicalExecutionId,
        surface,
        accountingScope: "customer_usage",
        cacheStatus: cacheStatusFor(message, index, cacheStatus),
        returnedRows:
          returnedRows == null
            ? returnedRowsFor(message, index)
            : Number(returnedRows),
        recordCount: 1,
        unitAmount: price.unitAmount,
        pricingCodeVersion: price.pricingCodeVersion,
        pricingResolution: price.pricingResolution,
      });
      entries.push({
        envelope,
        context: {
          accountId,
          partition,
          userId: securityContext.userId || null,
        },
        idempotencyKey: `${logicalExecutionId}:${item}`,
      });
    }
  }
  return entries;
}

export async function commitSqlEnrichmentBilling(
  redis,
  {
    sql,
    securityContext,
    logicalExecutionId,
    surface,
    returnedRows,
    cacheStatus = "unknown",
    signal = null,
  },
  options = {},
) {
  const items = sqlEnrichmentBillingItems(sql);
  if (!items.length) return [];
  return commitEnrichmentBilling(
    redis,
    {
      query: {},
      logicalExecutionId,
      signal,
      context: { securityContext },
    },
    { data: [] },
    {
      ...options,
      resolveItems: async () => items,
      surface,
      returnedRows,
      cacheStatus,
    },
  );
}

export async function commitEnrichmentBilling(
  redis,
  request,
  message,
  options,
) {
  try {
    const entries = await buildEnrichmentBillingBatch(request, message, options);
    if (!entries.length) return [];
    if (!redis) throw billingError("durable Redis outbox is required");
    return await enqueueBillingBatch(redis, entries);
  } catch (error) {
    recordBillingFailure(error);
    throw error;
  }
}

/**
 * Cube awaits this result callback after query execution and before writing the
 * HTTP/SQL response. Wrapping it gives billing a real result-commit boundary:
 * an enqueue failure becomes a gateway error and no successful result is sent.
 */
export function installEnrichmentGatewayMetering(
  cubejs,
  redis,
  { commit = commitEnrichmentBilling } = {},
) {
  const gateway = cubejs.apiGateway();
  if (gateway.__enrichmentMeteringInstalled) return gateway;

  for (const methodName of ["load", "sqlApiLoad"]) {
    if (typeof gateway[methodName] !== "function") continue;
    const original = gateway[methodName].bind(gateway);
    gateway[methodName] = async (request) => {
      const originalResponse = request.res;
      return original({
        ...request,
        res: async (message, responseOptions) => {
          await commit(redis, request, message, {
            surface: methodName === "sqlApiLoad" ? "sql-api" : "rest",
          });
          return originalResponse(message, responseOptions);
        },
      });
    };
  }
  gateway.__enrichmentMeteringInstalled = true;
  return gateway;
}
