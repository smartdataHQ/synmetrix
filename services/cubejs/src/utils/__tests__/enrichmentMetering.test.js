import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectResolvedMembers } from "../enrichmentEntitlement.js";
import {
  buildEnrichmentBillingBatch,
  deterministicBillingMessageId,
  installEnrichmentGatewayMetering,
} from "../enrichmentMetering.js";
import {
  parseEnrichmentCodePricing,
  resolveEnrichmentCodePrice,
} from "../enrichmentPricing.js";

const SECURITY_CONTEXT = {
  userId: "person-1",
  tokenPayload: { accountId: "account-real-1", partition: "tenant.is" },
  userScope: { teamProperties: { partition: "tenant.is" } },
};
const PRICING = Object.freeze({
  pricingCodeVersion: "ctx-pricing-v1",
  items: Object.freeze({
    "ctx:day-archetype": Object.freeze({
      amount: "0.10",
      currency: "ISK",
      connectionId: "connection-day-real",
    }),
    "ctx:weather-archetype": Object.freeze({
      amount: "0.25",
      currency: "ISK",
      connectionId: "connection-weather-real",
    }),
  }),
});
const ITEM_BY_CUBE = new Map([
  ["CtxDayContext", "ctx:day-archetype"],
  ["CtxWeatherContext", "ctx:weather-archetype"],
]);

const resolveItems = async (query) => [
  ...new Set(
    collectResolvedMembers(query)
      .map((member) => ITEM_BY_CUBE.get(member.split(".", 1)[0]))
      .filter(Boolean),
  ),
];
const resolvePrice = (item) =>
  resolveEnrichmentCodePrice(item, { config: PRICING });
const request = (query, overrides = {}) => ({
  query,
  apiType: "rest",
  context: {
    requestId: "logical-1",
    securityContext: SECURITY_CONTEXT,
  },
  ...overrides,
});
const response = (data = [], extra = {}) => ({ data, ...extra });
const build = (req, result, options = {}) =>
  buildEnrichmentBillingBatch(req, result, {
    resolveItems,
    resolvePrice,
    ...options,
  });

describe("enrichment result-commit metering", () => {
  it("detects logical members in filters and every order shape, not SQL text", async () => {
    const result = await build(
      request({
        dimensions: ["Events.id"],
        filters: [
          {
            and: [
              {
                member: "CtxDayContext.isHoliday",
                operator: "equals",
                values: ["1"],
              },
            ],
          },
        ],
        order: { "CtxDayContext.localDate": "asc" },
        generatedSql: "SELECT * FROM enrich.weather_context_v",
      }),
      response([{ "Events.id": "1" }]),
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].envelope.dimensions.item, "ctx:day-archetype");
  });

  it("deduplicates members from one item and charges both distinct items", async () => {
    const result = await build(
      request({
        dimensions: [
          "CtxDayContext.isHoliday",
          "CtxDayContext.seasonName",
          "CtxWeatherContext.temperature",
        ],
      }),
      response([]),
    );
    assert.deepEqual(
      result.map((entry) => entry.envelope.dimensions.item),
      ["ctx:day-archetype", "ctx:weather-archetype"],
    );
  });

  it("charges successful cache hits and zero-row results", async () => {
    const [entry] = await build(
      request({ dimensions: ["CtxWeatherContext.temperature"] }),
      response([], { cacheStatus: "hit" }),
    );
    assert.equal(entry.envelope.properties.returned_rows, 0);
    assert.equal(entry.envelope.properties.cache_status, "cache_hit");
    assert.equal(entry.envelope.metrics.record_count, 1);
  });

  it("uses stable retry identities and child ids for multi-query requests", async () => {
    const query = { dimensions: ["CtxDayContext.isHoliday"] };
    const first = await build(request(query), response([]));
    const retry = await build(request(query), response([]));
    assert.equal(first[0].idempotencyKey, retry[0].idempotencyKey);
    assert.equal(
      first[0].envelope.message_id,
      deterministicBillingMessageId("logical-1", "ctx:day-archetype"),
    );

    const children = await build(request([query, query]), {
      results: [response([]), response([{ value: 1 }])],
    });
    assert.deepEqual(
      children.map((entry) => entry.envelope.properties.logical_execution_id),
      ["logical-1:query:0", "logical-1:query:1"],
    );
    assert.deepEqual(
      children.map((entry) => entry.envelope.properties.returned_rows),
      [0, 1],
    );
  });

  it("does not charge errors, disconnects, non-enrichment, scheduled refreshes, or pre-aggregations", async () => {
    const enrichment = { dimensions: ["CtxDayContext.isHoliday"] };
    assert.deepEqual(
      await build(request(enrichment), { error: "failure" }),
      [],
    );
    assert.deepEqual(
      await build(
        request(enrichment, { signal: { aborted: true } }),
        response([]),
      ),
      [],
    );
    assert.deepEqual(
      await build(request({ dimensions: ["Events.id"] }), response([])),
      [],
    );
    assert.deepEqual(
      await build(
        request(enrichment, { scheduledRefresh: true }),
        response([]),
      ),
      [],
    );
    assert.deepEqual(
      await build(request(enrichment, { preAggregation: true }), response([])),
      [],
    );
  });

  it("requires real account/connection and never falls back to partition", async () => {
    const req = request({ dimensions: ["CtxDayContext.isHoliday"] });
    req.context.securityContext = {
      ...SECURITY_CONTEXT,
      tokenPayload: { accountId: null, partition: "tenant.is" },
    };
    await assert.rejects(build(req, response([])), /real Account/);
  });

  it("does not commit a result when durable enqueue fails", async () => {
    let responseCommitted = false;
    const gateway = {
      load: async (req) => req.res(response([])),
      sqlApiLoad: async (req) => req.res(response([])),
    };
    installEnrichmentGatewayMetering(
      { apiGateway: () => gateway },
      {},
      {
        commit: async () => {
          throw new Error("redis unavailable");
        },
      },
    );
    await assert.rejects(
      gateway.load({
        ...request({ dimensions: ["CtxDayContext.isHoliday"] }),
        res: async () => {
          responseCommitted = true;
        },
      }),
      /redis unavailable/,
    );
    assert.equal(responseCommitted, false);
  });

  it("commits billing before REST and SQL API responses", async () => {
    const order = [];
    const gateway = {
      load: async (req) => req.res(response([])),
      sqlApiLoad: async (req) => req.res(response([])),
    };
    installEnrichmentGatewayMetering(
      { apiGateway: () => gateway },
      {},
      {
        commit: async (_redis, _request, _message, options) =>
          order.push(options.surface),
      },
    );
    const base = {
      ...request({ dimensions: ["CtxDayContext.isHoliday"] }),
      res: async () => order.push("response"),
    };
    await gateway.load(base);
    await gateway.sqlApiLoad(base);
    assert.deepEqual(order, ["rest", "response", "sql-api", "response"]);
  });

  it("uses legacy_runtime_rate without requiring or querying Convex pricing", () => {
    const parsed = parseEnrichmentCodePricing(
      JSON.stringify({
        pricing_code_version: "ctx-pricing-v1",
        items: {
          "ctx:day-archetype": {
            amount: "0.10",
            currency: "isk",
            connection_id: "connection-day-real",
          },
        },
      }),
    );
    const options = { config: parsed };
    Object.defineProperty(options, "convexPricing", {
      get() {
        throw new Error("Convex pricing must not be queried");
      },
    });
    const price = resolveEnrichmentCodePrice("ctx:day-archetype", options);
    assert.equal(price.pricingResolution.pricingSource, "legacy_runtime_rate");
    assert.equal(price.pricingCodeVersion, "ctx-pricing-v1");
    assert.equal(price.unitAmount, "0.10");
  });
});
