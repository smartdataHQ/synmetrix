import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertNoJoinAliasPaths } from "../queryRewrite.js";

const withAliases = (aliases) => {
  const map = new Map([
    ["orders", { sourceTable: "orders", dimensions: new Set(["created_at", "status"]) }],
  ]);
  map.joinAliases = new Set(aliases);
  return map;
};

describe("join-alias member paths under row rules", () => {
  it("allows cube.member and granularity paths, on cubes, views and inherited dimensions", () => {
    assertNoJoinAliasPaths(
      {
        measures: ["orders.count", "sales_view.count"],
        dimensions: ["orders.status", "orders.created_at.month"],
        order: [
          ["orders.created_at.month", "asc"],
          ["sales_view.created_at.month", "desc"], // a view: not in the map
          ["child_orders.inherited_at.day", "asc"], // dimension from `extends`
        ],
      },
      withAliases(["customer"]),
    );
  });

  it("rejects a path through a declared join alias wherever the query names it", () => {
    for (const query of [
      { dimensions: ["orders.customer.city"] },
      { measures: ["orders.count"], filters: [{ member: "orders.customer.city", operator: "set" }] },
      { measures: ["orders.count"], filters: [{ or: [{ member: "orders.customer.city", operator: "set" }] }] },
      { measures: ["orders.count"], timeDimensions: [{ dimension: "orders.customer.signed_up" }] },
      { measures: ["orders.count"], order: [["orders.customer.city", "asc"]] },
      { measures: ["orders.count"], order: [{ id: "orders.customer.city", desc: true }] },
      { measures: ["orders.customer.address.lifetime_value"] },
    ]) {
      assert.throws(
        () => assertNoJoinAliasPaths(query, withAliases(["customer"])),
        (err) => err.type === "UserError" && /join alias/.test(err.message),
        JSON.stringify(query),
      );
    }
  });

  it("does nothing when no model declares a join alias", () => {
    assertNoJoinAliasPaths({ dimensions: ["orders.customer.city"] }, withAliases([]));
  });
});
