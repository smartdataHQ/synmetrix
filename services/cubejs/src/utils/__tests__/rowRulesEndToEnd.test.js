import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { prepareCompiler } from "@cubejs-backend/schema-compiler";

// orders -> customer (alias, users) -> events (plain join, cst.semantic_events)
const MODEL = `cubes:
  - name: orders
    sql_table: shop.orders
    joins:
      - name: users
        alias: customer
        relationship: many_to_one
        sql: "{CUBE}.customer_id = {customer}.id"
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: created_at
        sql: created_at
        type: time
    measures:
      - name: count
        type: count
  - name: users
    sql_table: shop.users
    joins:
      - name: events
        relationship: one_to_many
        sql: "{CUBE}.id = {events}.user_id"
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: city
        sql: city
        type: string
  - name: top
    sql_table: shop.top
    joins:
      - name: events
        alias: mid
        relationship: many_to_one
        sql: "{CUBE}.event_id = {mid}.id"
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: name
        sql: name
        type: string
  - name: leaf
    sql_table: shop.leaf
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: label
        sql: label
        type: string
  - name: events
    sql_table: cst.semantic_events
    joins:
      - name: leaf
        alias: lf
        relationship: many_to_one
        sql: "{CUBE}.leaf_id = {lf}.id"
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: event
        sql: event
        type: string
      - name: partition
        sql: partition
        type: string
    measures:
      - name: count
        type: count
`;

mock.module("../dataSourceHelpers.js", {
  namedExports: {
    findDataSchemasByIds: async () => [{ name: "m.yml", code: MODEL }],
  },
});
const { default: queryRewrite, memberPathHops } = await import("../queryRewrite.js");

const compilers = prepareCompiler(
  { dataSchemaFiles: async () => [{ fileName: "m.yml", content: MODEL }] },
  { adapter: "postgres" },
);
await compilers.compiler.compile();
// As index.js wires it: Cube's resolver plus every hop along the path.
const resolveMemberPath = (p) => {
  const resolved = compilers.cubeEvaluator.resolveMemberPath(p);
  return resolved && { ...resolved, hops: memberPathHops(p, compilers.cubeEvaluator.evaluatedCubes) };
};

let version = 0;
const context = () => ({
  resolveMemberPath,
  securityContext: {
    queryRules: [
      { cube_name: "semantic_events", dimension: "partition", operator: "equals", property_source: "team", property_key: "partition" },
    ],
    userScope: {
      role: "owner",
      hasAccessList: false,
      teamProperties: { partition: "tenant-a" },
      memberProperties: {},
      // A fresh schemaVersion per call: the model map is cached by it.
      dataSource: { schemaVersion: `v${(version += 1)}`, files: ["f"], fileChecksums: {} },
    },
  },
});

describe("row rules on Cube 1.8 member paths (end to end)", () => {
  it("rules the cube reached through an alias and then a plain join", async () => {
    const query = await queryRewrite(
      { measures: ["orders.count"], dimensions: ["orders.customer.events.event"] },
      context(),
    );
    assert.deepEqual(query.filters, [
      { member: "orders.customer.events.partition", operator: "equals", values: ["tenant-a"] },
    ]);
  });

  it("rules a ruled cube joined in the middle of a multi-hop path", async () => {
    const query = await queryRewrite(
      { dimensions: ["top.name", "top.mid.lf.label"] },
      context(),
    );
    assert.deepEqual(query.filters, [
      { member: "top.mid.partition", operator: "equals", values: ["tenant-a"] },
    ]);
  });

  it("rules the cubes of SQL API member expressions, and refuses ones it can't read", async () => {
    const query = await queryRewrite(
      { dimensions: [{ cubeName: "events", name: "e", expression: ["events", "LOWER(events.event)"] }], measures: ["events.count"] },
      context(),
    );
    assert.deepEqual(query.filters, [
      { member: "events.partition", operator: "equals", values: ["tenant-a"] },
    ]);
    await assert.rejects(
      queryRewrite({ dimensions: [{ name: "x", expression: { type: "Unknown" } }] }, context()),
      (err) => err.type === "UserError",
    );
  });

  it("rules a cube a PatchMeasure reaches only through its filters", async () => {
    const query = await queryRewrite(
      {
        measures: [{
          cubeName: "orders",
          name: "m",
          expression: {
            type: "PatchMeasure",
            sourceMeasure: "orders.count",
            replaceAggregationType: null,
            addFilters: [["events", "{events.event} LIKE 'SECRET%'"]],
          },
        }],
      },
      context(),
    );
    assert.deepEqual(query.filters, [
      { member: "events.partition", operator: "equals", values: ["tenant-a"] },
    ]);
  });

  it("rules cubes the SQL API names only in a subquery join or a join hint", async () => {
    const viaSubquery = await queryRewrite(
      {
        dimensions: ["orders.id"],
        subqueryJoins: [{
          sql: "SELECT 'tenant-b' p",
          on: { cubeName: "events", name: "on", expression: ["events", "{events.partition} = sq.p"] },
          joinType: "INNER",
          alias: "sq",
        }],
      },
      context(),
    );
    assert.deepEqual(viaSubquery.filters, [
      { member: "events.partition", operator: "equals", values: ["tenant-a"] },
    ]);
    const viaHint = await queryRewrite(
      { dimensions: ["orders.id"], joinHints: [["orders", "events"]] },
      context(),
    );
    assert.deepEqual(viaHint.filters, [
      { member: "events.partition", operator: "equals", values: ["tenant-a"] },
    ]);
  });

  it("never runs a blocked query without its sentinel, time-dimension-only included", async () => {
    const ctx = context();
    ctx.securityContext.userScope.teamProperties = {};
    const query = await queryRewrite(
      { timeDimensions: [{ dimension: "events.id", dateRange: "last 7 days" }] },
      ctx,
    );
    assert.deepEqual(query.filters, [
      { member: "events.id", operator: "equals", values: ["__blocked_by_access_control__"] },
    ]);
    const filterOnly = context();
    filterOnly.securityContext.userScope.teamProperties = {};
    await assert.rejects(
      queryRewrite({ filters: [{ member: "events.event", operator: "set" }] }, filterOnly),
      /403/,
    );
  });
});
