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
  - name: events
    sql_table: cst.semantic_events
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
const { default: queryRewrite } = await import("../queryRewrite.js");

const compilers = prepareCompiler(
  { dataSchemaFiles: async () => [{ fileName: "m.yml", content: MODEL }] },
  { adapter: "postgres" },
);
await compilers.compiler.compile();
const resolveMemberPath = (p) => compilers.cubeEvaluator.resolveMemberPath(p);

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
