import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { prepareCompiler } from "@cubejs-backend/schema-compiler";

import { applyPartitionPruning, memberInstance, queryInstances } from "../queryRewrite.js";

const require = createRequire(import.meta.url);

const modelMap = () => {
  const map = new Map([
    ["orders", { sourceTable: "orders", dimensions: new Set(["status", "created_at"]), joinAliases: new Map([["customer", "users"], ["manager", "users"]]) }],
    ["users", { sourceTable: "semantic_events", dimensions: new Set(["city", "partition", "timestamp", "signed_up"]), joinAliases: new Map([["address", "addresses"]]) }],
    ["addresses", { sourceTable: "addresses", dimensions: new Set(["zip"]), joinAliases: new Map() }],
  ]);
  map.joinAliases = new Set(["customer", "manager", "address"]);
  return map;
};

describe("row rules follow join aliases (Cube 1.8)", () => {
  it("resolves a path to the cube instance it reads", () => {
    const map = modelMap();
    assert.deepEqual(memberInstance("orders.status", map), { instance: "orders", cube: "orders" });
    assert.deepEqual(memberInstance("orders.created_at.month", map), { instance: "orders", cube: "orders" });
    assert.deepEqual(memberInstance("orders.customer.city", map), { instance: "orders.customer", cube: "users" });
    assert.deepEqual(memberInstance("orders.customer.address.zip", map), { instance: "orders.customer.address", cube: "addresses" });
    assert.deepEqual(memberInstance("sales_view.created_at.month", map), { instance: "sales_view", cube: "sales_view" });
  });

  it("collects every instance a query reads, order included", () => {
    const instances = queryInstances(
      {
        measures: ["orders.count"],
        filters: [{ or: [{ member: "orders.manager.city", operator: "set" }] }],
        order: [["orders.customer.city", "asc"]],
      },
      modelMap(),
    );
    assert.deepEqual([...instances], [
      ["orders", "orders"],
      ["orders.manager", "users"],
      ["orders.customer", "users"],
    ]);
  });

  it("refuses a path through an alias it cannot resolve instead of reading it unruled", () => {
    for (const member of ["orders.vendor.x.y", "child.customer.city"]) {
      const map = modelMap();
      map.joinAliases.add("vendor");
      assert.throws(
        () => memberInstance(member, map),
        (err) => err.type === "UserError" && /join alias/.test(err.message),
        member,
      );
    }
  });

  it("prunes each aliased instance by its own date range only", () => {
    const query = applyPartitionPruning(
      {
        measures: ["orders.count"],
        timeDimensions: [{ dimension: "orders.customer.signed_up", dateRange: ["2026-06-01", "2026-06-07"] }],
      },
      modelMap(),
      { semantic_events: { dimension: "timestamp", marginDays: 1 } },
    );
    assert.deepEqual(query.filters, [
      { member: "orders.customer.timestamp", operator: "inDateRange", values: ["2026-05-31", "2026-06-08"] },
    ]);
  });

  it("a filter on the alias path lands on the aliased table in Tesseract's SQL", async () => {
    const { ClickHouseQuery } = require("@cubejs-backend/schema-compiler/dist/src/adapter/ClickHouseQuery.js");
    const content = `cubes:
  - name: orders
    sql_table: orders
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
    measures:
      - name: count
        type: count
  - name: users
    sql_table: semantic_events
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: city
        sql: city
        type: string
      - name: partition
        sql: partition
        type: string
`;
    const compilers = prepareCompiler(
      { dataSchemaFiles: async () => [{ fileName: "m.yml", content }] },
      { adapter: "clickhouse" },
    );
    await compilers.compiler.compile();
    const [sql, params] = new ClickHouseQuery(compilers, {
      measures: ["orders.count"],
      dimensions: ["orders.customer.city"],
      // what the row rule adds for the instance
      filters: [{ member: "orders.customer.partition", operator: "equals", values: ["elko.is"] }],
      timezone: "UTC",
      useNativeSqlPlanner: true,
    }).buildSqlAndParams();
    assert.match(sql, /JOIN\s+semantic_events\s+AS `orders__customer`/);
    assert.match(sql, /`orders__customer`\.partition = \?/);
    assert.deepEqual(params, ["elko.is"]);
  });
});
