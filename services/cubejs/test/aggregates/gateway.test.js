/**
 * The hook inside a real Cube gateway, wired the way index.js wires it: which
 * table each query surface reads, what stays untouched, and what a consumer
 * can see. Needs the disposable ClickHouse (docker-compose.clickhouse.yml).
 */
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import * as h from "./harness.js";

await h.stubSchemaLoader(mock, () => [{ id: "f1", name: "line_items.yml", code: h.MODEL }]);

const AGGREGATE = "agg_test.sales__agg_1day";
const SOURCE = "agg_test.sales";
const m = (name) => `line_items.${name}`;
const over = (granularity, from, to) => [
  { dimension: m("timestamp"), ...(granularity ? { granularity } : {}), dateRange: [from, to] },
];
const SUITABLE = { measures: [m("units"), m("avg_units")], dimensions: [m("main_category")], timeDimensions: over("month", "2026-01-01", "2026-03-31") };

let routed;
let plain;
const reasonOf = (service) => /reason=(\S+)/.exec(service.lines.at(-1))?.[1];
const gatewayCall = async (service, method, args) => {
  let answer;
  await service.apiGateway()[method]({ ...args, res: (body) => { answer = body; } });
  return answer;
};
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

before(async () => {
  await h.loadFixture("sales_like");
  await h.fillAll(await h.structureOf(AGGREGATE));
  await h.reloadCatalog();
  routed = await h.service({ routing: true });
  plain = await h.service({ routing: false });
});

after(async () => {
  await h.close();
});

describe("every query surface applies the same decision (US1, FR-018)", () => {
  it("sql reads the aggregate table and no other", async () => {
    const [statement] = await h.sqlAll(routed, SUITABLE, h.requestContext());
    assert.deepEqual(h.tablesOf(statement), [AGGREGATE]);
    assert.match(routed.lines.at(-1), /cube=line_items {2}aggregate=agg_test\.sales__agg_1day$/);
  });

  it("a dry run is decided the same way and succeeds on the variant", async () => {
    const context = h.requestContext();
    const answer = await gatewayCall(routed, "dryRun", { query: { timezone: "UTC", ...SUITABLE }, context });
    assert.ok(!answer.error, answer.error);
    assert.equal(context.aggregateRouting.aggregate, AGGREGATE);
    assert.deepEqual(answer.normalizedQueries[0].measures, SUITABLE.measures);
  });

  it("the path of load, streaming and export reads the aggregate table", async () => {
    const context = h.requestContext();
    const gateway = routed.apiGateway();
    const [, queries] = await gateway.getNormalizedQueries({ timezone: "UTC", ...SUITABLE }, context);
    const [generated] = await gateway.getSqlQueriesInternal(context, queries);
    assert.deepEqual(h.tablesOf({ text: generated.sql[0] }), [AGGREGATE]);
  });

  it("routes both ranges of a compared date range", async () => {
    const query = {
      measures: [m("units")],
      timeDimensions: [{ dimension: m("timestamp"), granularity: "day", compareDateRange: [["2026-02-01", "2026-02-07"], ["2026-01-01", "2026-01-07"]] }],
    };
    const statements = await h.sqlAll(routed, query, h.requestContext());
    assert.equal(statements.length, 2);
    for (const statement of statements) assert.deepEqual(h.tablesOf(statement), [AGGREGATE]);
  });

  it("shows the same model to users before and after a routed query", async () => {
    const members = async (service) => {
      const meta = await gatewayCall(service, "meta", { context: h.requestContext() });
      return meta.cubes.map((cube) => ({
        name: cube.name,
        title: cube.title,
        measures: cube.measures.map((member) => [member.name, member.type, member.title]),
        dimensions: cube.dimensions.map((member) => [member.name, member.type]),
        segments: cube.segments.map((member) => member.name),
      }));
    };
    const before = await members(routed);
    await h.sqlAll(routed, SUITABLE, h.requestContext());
    const afterwards = await members(routed);
    assert.deepEqual(afterwards, before);
    assert.deepEqual(afterwards, await members(plain));
    assert.deepEqual(afterwards.map((cube) => cube.name), ["line_items"]);
    assert.ok(afterwards[0].measures.some(([name]) => name === m("transactions"))); // also what the aggregate cannot answer
  });
});

describe("anything else is generated exactly as without the hook (US2)", () => {
  const cases = {
    "a member the aggregate cannot give": [{ ...SUITABLE, measures: [m("transactions")] }, "member_unavailable:line_items.transactions:column_not_in_aggregate"],
    "an hourly bucket on a one-day grain": [{ measures: [m("units")], timeDimensions: over("hour", "2026-02-01", "2026-02-02") }, "granularity"],
    "a range that starts inside a bucket": [{ measures: [m("units")], timeDimensions: over("day", "2026-02-01T12:00:00.000", "2026-02-10T23:59:59.999") }, "range_not_aligned"],
    "a time zone other than UTC": [{ ...SUITABLE, timezone: "Atlantic/Reykjavik" }, "timezone"],
    "a date filter that is not a range": [{ ...SUITABLE, timeDimensions: [], filters: [{ member: m("timestamp"), operator: "beforeDate", values: ["2026-02-01"] }] }, "time_filter"],
    "a short window that reaches the present": [{ measures: [m("units")], timeDimensions: over("day", daysAgo(6), today()) }, "window_too_short"],
  };

  for (const [label, [query, expected]] of Object.entries(cases)) {
    it(`${label}: ${expected.split(":")[0]}`, async () => {
      const withHook = await h.sqlAll(routed, query, h.requestContext());
      const without = await h.sqlAll(plain, query, h.requestContext());
      assert.deepEqual(withHook, without);
      assert.deepEqual(h.tablesOf(withHook[0]), [SOURCE]);
      assert.equal(reasonOf(routed), expected);
    });
  }

  it("routes no query of a request when one of them is unsuitable", async () => {
    const request = [
      { measures: [m("units")], timeDimensions: over("day", "2026-02-01", "2026-02-07") },
      { measures: [m("transactions")], timeDimensions: over("day", "2026-02-01", "2026-02-07") },
    ];
    const withHook = await h.sqlAll(routed, request, h.requestContext());
    assert.deepEqual(withHook, await h.sqlAll(plain, request, h.requestContext()));
    assert.deepEqual(withHook.map((statement) => h.tablesOf(statement)), [[SOURCE], [SOURCE]]);
    assert.equal(reasonOf(routed), "request_mixed");
  });

  it("keeps a row rule on a grouping column and routes; a rule on anything else stays on the source", async () => {
    const withRule = (member, value) =>
      h.service({
        routing: true,
        queryRewrite: async (query) => ({ ...query, filters: [...(query.filters || []), { member, operator: "equals", values: [value] }] }),
      });

    const tenantRule = await withRule(m("partition"), "rule-tenant-value");
    const [statement] = await h.sqlAll(tenantRule, SUITABLE, h.requestContext());
    assert.deepEqual(h.tablesOf(statement), [AGGREGATE]);
    assert.ok(statement.values.includes("rule-tenant-value"));
    assert.match(statement.text, /`line_items`\.partition = \?/);
    assert.match(statement.text, /WHERE partition = 't1'/); // the cube's own restriction, verbatim

    const otherRule = await withRule(m("checkout_id"), "c1");
    const [onSource] = await h.sqlAll(otherRule, SUITABLE, h.requestContext());
    assert.deepEqual(h.tablesOf(onSource), [SOURCE]);
    assert.equal(reasonOf(otherRule), "member_unavailable:line_items.checkout_id:column_not_in_aggregate");
  });

  it("issues no statement of its own when it is switched off", async () => {
    assert.equal(plain.routingInstalled, false);
    assert.equal(routed.routingInstalled, true);
    const before = h.issued.statements;
    await h.sqlAll(plain, SUITABLE, h.requestContext());
    await h.sqlAll(plain, { measures: [m("transactions")] }, h.requestContext());
    assert.equal(h.issued.statements, before);
    assert.deepEqual(plain.lines, []);
  });
});

describe("a routed answer says through what time it is complete (US4, FR-030)", () => {
  const HEADER = "x-synmetrix-aggregate-covered-until";
  const servers = [];
  let withHook;
  let without;
  let coveredUntil;

  /**
   * A server on a local port: Cube's own routes and, with `routing`, the
   * service's real ones in front of them. The service's router is one object
   * per process, so only one server can mount it; the other one is plain Cube.
   */
  async function listen(routing) {
    const { default: express } = await import("express");
    const { default: routes } = await import("../../src/routes/index.js");
    const basePath = "/api";
    const cubejs = await h.service({
      routing,
      basePath,
      checkAuth: (req) => { req.securityContext = h.securityContext(); },
    });
    const app = express();
    app.use(express.json());
    if (routing) app.use(routes({ basePath, cubejs }));
    cubejs.initApp(app);
    const server = await new Promise((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}${basePath}/v1/load`;
  }
  const load = async (url, query, format) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "test" },
      body: JSON.stringify({ query: { timezone: "UTC", ...query }, ...(format ? { format } : {}) }),
    });
    return { status: response.status, mark: response.headers.get(HEADER), text: await response.text() };
  };

  before(async () => {
    const entry = await h.reloadCatalog();
    coveredUntil = entry.aggregates.find((aggregate) => aggregate.table === AGGREGATE).coveredUntil;
    withHook = await listen(true);
    without = await listen(false);
  });

  after(() => {
    for (const server of servers) server.close();
  });

  it("carries the coverage boundary on a routed answer, and the body is what the source returns", async () => {
    const answer = await load(withHook, SUITABLE);
    assert.equal(answer.status, 200, answer.text.slice(0, 300));
    assert.equal(answer.mark, new Date(coveredUntil).toISOString());
    assert.match(answer.mark, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const plainAnswer = await load(without, SUITABLE);
    assert.equal(plainAnswer.status, 200);
    const [routedBody, plainBody] = [JSON.parse(answer.text), JSON.parse(plainAnswer.text)];
    h.assertSameRows(routedBody.data, plainBody.data, { label: "load" });
    assert.deepEqual(routedBody.annotation, plainBody.annotation);
    assert.ok(routedBody.data.length > 0);
  });

  it("carries no mark on an answer from the source, on an error, or with the switch off", async () => {
    const unrouted = await load(withHook, { ...SUITABLE, measures: [m("transactions")] });
    assert.deepEqual([unrouted.status, unrouted.mark], [200, null]);

    const failed = await load(withHook, { measures: [m("no_such_measure")] });
    assert.ok(failed.status >= 400, String(failed.status));
    assert.equal(failed.mark, null);

    const off = await load(without, SUITABLE);
    assert.deepEqual([off.status, off.mark], [200, null]);
  });

  it("carries the mark on an export as well, with the same rows", async () => {
    const exported = await load(withHook, SUITABLE, "csv");
    assert.equal(exported.status, 200, exported.text.slice(0, 300));
    assert.equal(exported.mark, new Date(coveredUntil).toISOString());
    const lines = exported.text.trim().split("\n");
    const { data } = JSON.parse((await load(without, SUITABLE)).text);
    assert.equal(lines.length, data.length + 1); // a header line and the rows the source returns
    assert.match(lines[0], /main_category/);

    const unrouted = await load(withHook, { ...SUITABLE, measures: [m("transactions")] }, "csv");
    assert.deepEqual([unrouted.status, unrouted.mark], [200, null]);
  });
});
