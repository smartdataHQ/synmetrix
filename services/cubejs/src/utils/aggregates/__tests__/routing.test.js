import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ApiGateway } from "@cubejs-backend/api-gateway";

import { replay } from "./fixtures/ast/replay.js";
import { structure } from "./fixtures/salesAggregate.js";

// The default schema loader talks to Hasura; every test here injects its own.
mock.module("../../dataSourceHelpers.js", {
  namedExports: { findDataSchemasByIds: async () => { throw new Error("not used in unit tests"); } },
});
const { ANSWER_MARK_HEADER, aggregateAppIdSuffix, answerMark, clearVariants, derivedFilesFor, installAggregateRouting } = await import("../routing.js");

const MODEL = readFileSync(new URL("./fixtures/sales_model.yml", import.meta.url), "utf8");
const NOW = Date.UTC(2026, 10, 20, 12);
const COVERED = Date.UTC(2026, 10, 1);
const AGGREGATE = () => structure(undefined, undefined, { verifiedAt: NOW - 3600_000, coveredUntil: COVERED });

const m = (name) => `line_items.${name}`;
const SUITABLE = {
  measures: [m("units")],
  dimensions: [m("main_category")],
  timeDimensions: [{ dimension: m("timestamp"), granularity: "month", dateRange: ["2026-01-01T00:00:00.000", "2026-03-31T23:59:59.999"] }],
  filters: [{ member: m("sold_location"), operator: "equals", values: ["store1-secret-value"] }],
  timezone: "UTC",
};
const UNSUITABLE = { ...SUITABLE, measures: [m("transactions")] };

const securityContext = (patch = {}) => ({
  authorityRevision: "rev",
  userScope: {
    dataSource: {
      dbType: "clickhouse", dataSourceVersion: "dsv", schemaVersion: "sv1", files: ["f1"], fileChecksums: { f1: "c1" },
      dbParams: { database: "default" },
      ...patch,
    },
  },
});
const variantOf = (context) => context.securityContext?.userScope?.dataSource?.aggregateVariant;

/** The hook installed on a fake gateway whose normalized queries are the input itself. */
function setup({ entry = { loadedAt: 0, serverNowAtLoad: NOW, aggregates: [AGGREGATE()], rejected: [] }, schemas, gateway, ...overrides } = {}) {
  const seen = { calls: [], lines: [], statements: 0, loads: 0, released: 0 };
  const fake = gateway || {
    async getNormalizedQueries(input, context, ...rest) {
      seen.calls.push({ rest, variantAtCall: variantOf(context), markAtCall: context.aggregateRouting });
      const queries = Array.isArray(input) ? input : [input];
      return ["regularQuery", queries, queries];
    },
  };
  const clock = { ms: 0 };
  const installed = installAggregateRouting(
    { apiGateway: () => fake },
    {
      enabled: true,
      catalog: { lookup: () => entry },
      loadSchemas: async () => {
        seen.loads += 1;
        return schemas || [{ id: "f1", name: "line_items.yml", code: MODEL }];
      },
      driverFor: async () => ({
        query: async (sql) => { seen.statements += 1; return replay(sql); },
        release: async () => { seen.released += 1; },
      }),
      log: (line) => seen.lines.push(line),
      now: () => clock.ms,
      ...overrides,
    },
  );
  const run = async (query, context = { securityContext: securityContext(), requestId: "req-1" }, ...rest) => {
    const result = await fake.getNormalizedQueries(query, context, ...rest);
    return { result, context };
  };
  return { seen, run, clock, installed, gateway: fake };
}

beforeEach(() => clearVariants());

describe("installAggregateRouting", () => {
  it("relies on a gateway method the installed Cube version has", () => {
    assert.equal(typeof ApiGateway.prototype.getNormalizedQueries, "function");
    assert.equal(typeof ApiGateway.prototype.getSqlQueriesInternal, "function");
  });

  it("does nothing unless it is switched on", async () => {
    const untouched = async (enabled, environment) => {
      const gateway = { async getNormalizedQueries(input) { return ["regularQuery", [input], [input]]; } };
      const original = gateway.getNormalizedQueries;
      const saved = process.env.AGGREGATE_ROUTING_ENABLED;
      if (environment === undefined) delete process.env.AGGREGATE_ROUTING_ENABLED;
      else process.env.AGGREGATE_ROUTING_ENABLED = environment;
      let probes = 0;
      try {
        const installed = installAggregateRouting(
          { apiGateway: () => gateway },
          { ...(enabled === undefined ? {} : { enabled }), catalog: { lookup: () => { probes += 1; return null; } }, log: () => {} },
        );
        await gateway.getNormalizedQueries(SUITABLE, { securityContext: securityContext(), requestId: "r" });
        return [installed, gateway.getNormalizedQueries === original, probes];
      } finally {
        if (saved === undefined) delete process.env.AGGREGATE_ROUTING_ENABLED;
        else process.env.AGGREGATE_ROUTING_ENABLED = saved;
      }
    };
    assert.deepEqual(await untouched(undefined, undefined), [false, true, 0]);
    assert.deepEqual(await untouched(undefined, "false"), [false, true, 0]);
    assert.deepEqual(await untouched(undefined, "1"), [false, true, 0]);
    assert.deepEqual(await untouched(false, "true"), [false, true, 0]);
    assert.deepEqual(await untouched(undefined, "true"), [true, false, 1]);
  });

  it("does not install itself on a gateway without that method", () => {
    const { installed, seen } = setup({ gateway: {} });
    assert.equal(installed, false);
    assert.match(seen.lines[0], /not installed/);
  });

  it("returns the gateway's result unchanged and passes its arguments on", async () => {
    const { run, seen, installed } = setup();
    const { result } = await run(SUITABLE, undefined, true, false, "stale-if-slow");
    assert.equal(installed, true);
    assert.deepEqual(result, ["regularQuery", [SUITABLE], [SUITABLE]]);
    assert.deepEqual(seen.calls[0].rest, [true, false, "stale-if-slow"]);
  });

  it("marks a copy of the security context for a suitable request and leaves the original untouched", async () => {
    const { run } = setup();
    const original = securityContext();
    const snapshot = structuredClone(original);
    const { context } = await run(SUITABLE, { securityContext: original, requestId: "req-1" });

    assert.match(variantOf(context), /^[a-f0-9]{32}$/);
    assert.notEqual(context.securityContext, original);
    assert.deepEqual(original, snapshot);
    const { aggregateVariant: _marker, ...rest } = context.securityContext.userScope.dataSource;
    assert.deepEqual({ ...context.securityContext, userScope: { dataSource: rest } }, snapshot);
  });

  it("names the variant in the app id and serves its files", async () => {
    const { run } = setup();
    const { context } = await run(SUITABLE);
    assert.equal(aggregateAppIdSuffix(context), `_AGG_${variantOf(context)}`);
    assert.equal(aggregateAppIdSuffix({ securityContext: securityContext() }), "");
    assert.equal(aggregateAppIdSuffix(undefined), "");

    const files = derivedFilesFor(context.securityContext);
    assert.equal(files.length, 1);
    assert.match(files[0].content, /FROM agg_test\.sales__agg_1day/);
    assert.equal(derivedFilesFor(securityContext()), null);
    assert.equal(derivedFilesFor(securityContext({ aggregateVariant: "unknown" })), null);
  });

  it("says what the answer covers on a routed request only", async () => {
    const { run } = setup();
    const routed = await run(SUITABLE);
    assert.deepEqual(routed.context.aggregateRouting, { aggregate: "agg_test.sales__agg_1day", coveredUntil: COVERED });
    const unrouted = await run(UNSUITABLE);
    assert.equal(unrouted.context.aggregateRouting, undefined);

    assert.equal(ANSWER_MARK_HEADER, "x-synmetrix-aggregate-covered-until");
    assert.equal(answerMark(routed.context), "2026-11-01T00:00:00.000Z");
    assert.equal(answerMark(unrouted.context), null);
    assert.equal(answerMark(undefined), null);
    assert.equal(answerMark({ aggregateRouting: { aggregate: "x", coveredUntil: null } }), null);
  });

  it("logs one line per request with the request id, cube and aggregate, and no query values", async () => {
    const { run, seen } = setup();
    await run(SUITABLE);
    assert.deepEqual(seen.lines, ["aggregate routing  requestId=req-1  cube=line_items  aggregate=agg_test.sales__agg_1day"]);
    assert.doesNotMatch(seen.lines.join("\n"), /store1-secret-value|2026-01-01|sv1|dsv/);
  });

  it("logs a reason when nothing is routed", async () => {
    const { run, seen } = setup();
    const { context } = await run(UNSUITABLE);
    assert.equal(variantOf(context), undefined);
    assert.deepEqual(seen.lines, [
      "aggregate routing  requestId=req-1  cube=line_items  reason=member_unavailable:line_items.transactions:column_not_in_aggregate",
    ]);
  });

  it("derives a cube once per schema version and aggregate", async () => {
    const { run, seen } = setup();
    await run(SUITABLE);
    await run(SUITABLE);
    await run(UNSUITABLE);
    assert.deepEqual([seen.loads, seen.statements, seen.released], [1, 1, 1]);
    await run(SUITABLE, { securityContext: securityContext({ schemaVersion: "sv2" }), requestId: "req-2" });
    assert.deepEqual([seen.loads, seen.statements], [2, 2]);
  });

  it("recomputes on every call, so a reused context does not keep an old decision", async () => {
    const { run, seen } = setup();
    const context = { securityContext: securityContext(), requestId: "req-1" };
    await run(SUITABLE, context);
    assert.ok(variantOf(context));
    await run(UNSUITABLE, context);
    assert.equal(variantOf(context), undefined);
    assert.equal(context.aggregateRouting, undefined);
    // the gateway itself always works on the canonical model
    assert.deepEqual(seen.calls.map((call) => [call.variantAtCall, call.markAtCall]), [[undefined, undefined], [undefined, undefined]]);
  });

  it("keeps at most 200 variants and evicts the least recently used", async () => {
    const { run } = setup();
    const contextFor = (index) => ({ securityContext: securityContext({ schemaVersion: `sv-${index}` }), requestId: `req-${index}` });
    const marked = [];
    for (let index = 0; index < 200; index += 1) marked.push((await run(SUITABLE, contextFor(index))).context.securityContext);
    await run(SUITABLE, contextFor(0)); // variant 0 is used again
    marked.push((await run(SUITABLE, contextFor(200))).context.securityContext); // the 201st
    assert.ok(derivedFilesFor(marked[0]));
    assert.equal(derivedFilesFor(marked[1]), null);
    assert.ok(derivedFilesFor(marked[2]));
    assert.ok(derivedFilesFor(marked[200]));
  });
});

describe("routing: reasons before any query is examined", () => {
  it("has no catalog yet, or a context without a data source", async () => {
    const first = setup({ entry: null });
    await first.run(SUITABLE);
    assert.match(first.seen.lines[0], /cube=-  reason=no_catalog$/);
    assert.equal(first.seen.loads, 0);

    const second = setup({ entry: null });
    const { context } = await second.run(SUITABLE, { securityContext: {}, requestId: "req-1" });
    assert.match(second.seen.lines[0], /reason=no_catalog$/);
    assert.deepEqual(context.securityContext, {});
  });

  it("does not load the model when the data source has no aggregate", async () => {
    const { run, seen } = setup({
      entry: { loadedAt: 0, serverNowAtLoad: NOW, aggregates: [], rejected: [{ table: "agg_test.broken", reason: "invalid_binding" }] },
    });
    await run(SUITABLE);
    assert.equal(seen.loads, 0);
    assert.deepEqual(seen.lines, [
      "aggregate routing  requestId=req-1  cube=line_items  reason=no_aggregate  rejected=agg_test.broken:invalid_binding",
    ]);
  });

  it("has no aggregate for the table this cube reads", async () => {
    const { run, seen } = setup({ entry: { loadedAt: 0, serverNowAtLoad: NOW, aggregates: [{ ...AGGREGATE(), source: "agg_test.returns" }], rejected: [] } });
    await run(SUITABLE);
    assert.match(seen.lines[0], /cube=line_items  reason=no_aggregate$/);
    assert.equal(seen.statements, 0);
  });

  it("reads a cube that is not defined in YAML, or not as a plain read", async () => {
    const javascript = setup({ schemas: [{ id: "f1", name: "line_items.js", code: "cube(`line_items`, { sql: `SELECT 1` });" }] });
    await javascript.run(SUITABLE);
    assert.match(javascript.seen.lines[0], /reason=cube_not_eligible:not_yaml$/);

    const grouped = setup({ schemas: [{ id: "f1", name: "m.yml", code: "cubes:\n  - name: line_items\n    sql: SELECT a FROM agg_test.sales GROUP BY a\n" }] });
    await grouped.run(SUITABLE);
    assert.match(grouped.seen.lines[0], /reason=cube_not_eligible:not_plain_read$/);

    const broken = setup({ schemas: [{ id: "f1", name: "m.yml", code: "cubes: [" }, { id: "f2", name: "views.yml", code: "views:\n  - name: v\n" }] });
    await broken.run(SUITABLE);
    assert.match(broken.seen.lines[0], /reason=cube_not_eligible:not_yaml$/);
  });
});

describe("routing: failing safe", () => {
  const failsSafe = async (overrides) => {
    const { run, seen } = setup(overrides);
    const { result, context } = await run(SUITABLE);
    assert.deepEqual(result, ["regularQuery", [SUITABLE], [SUITABLE]]);
    assert.equal(variantOf(context), undefined);
    assert.equal(context.aggregateRouting, undefined);
    assert.equal(seen.lines.length, 2);
    assert.match(seen.lines[0], /^aggregate routing failed: /);
    assert.match(seen.lines[1], /reason=error$/);
    return seen;
  };

  it("returns the gateway's result when the catalog throws", async () => {
    await failsSafe({ catalog: { lookup: () => { throw new Error("catalog broke"); } } });
  });

  it("returns the gateway's result when the model cannot be loaded, and tries again next time", async () => {
    let fail = true;
    const { run, seen } = setup({ loadSchemas: async () => { if (fail) throw new Error("hasura down"); return [{ id: "f1", name: "m.yml", code: MODEL }]; } });
    const first = await run(SUITABLE);
    assert.equal(variantOf(first.context), undefined);
    assert.match(seen.lines[1], /reason=error$/);
    fail = false;
    assert.ok(variantOf((await run(SUITABLE)).context));
  });

  it("returns the gateway's result when the database refuses to parse, and waits a minute before trying again", async () => {
    let fail = true;
    const { run, seen, clock } = setup({
      driverFor: async () => ({
        query: async (sql) => { seen.statements += 1; if (fail) throw new Error("syntax error near value 'secret'"); return replay(sql); },
        release: async () => { seen.released += 1; },
      }),
    });
    const first = await run(SUITABLE);
    assert.equal(variantOf(first.context), undefined);
    assert.deepEqual([seen.statements, seen.released], [1, 1]);
    assert.doesNotMatch(seen.lines.join("\n"), /secret/);

    fail = false;
    await run(SUITABLE);
    assert.equal(seen.statements, 1); // not retried yet
    assert.match(seen.lines.at(-1), /reason=error$/);

    clock.ms = 60_000;
    assert.ok(variantOf((await run(SUITABLE)).context));
    assert.equal(seen.statements, 2);
  });

  it("lets an error of the gateway itself through, with the context unmarked", async () => {
    const gateway = { async getNormalizedQueries() { throw new Error("queryRewrite failed"); } };
    const { run } = setup({ gateway });
    const context = { securityContext: securityContext({ aggregateVariant: "left-over" }), requestId: "req-1", aggregateRouting: { aggregate: "x" } };
    await assert.rejects(run(SUITABLE, context), /queryRewrite failed/);
    assert.equal(variantOf(context), undefined);
    assert.equal(context.aggregateRouting, undefined);
  });
});
