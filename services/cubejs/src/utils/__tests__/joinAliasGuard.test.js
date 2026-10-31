import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertNoJoinAliasPaths } from "../queryRewrite.js";

const map = new Map([
  ["orders", { sourceTable: "orders", dimensions: new Set(["created_at", "status"]) }],
]);

describe("join-alias member paths under row rules", () => {
  it("allows cube.member and a time dimension with a granularity", () => {
    assertNoJoinAliasPaths(
      {
        measures: ["orders.count"],
        dimensions: ["orders.status", "orders.created_at.month"],
        order: { "orders.created_at.month": "asc" },
      },
      map,
    );
  });

  it("rejects a path through a join alias wherever the query names it", () => {
    for (const query of [
      { dimensions: ["orders.customer.city"] },
      { measures: ["orders.count"], filters: [{ member: "orders.customer.city", operator: "set" }] },
      { measures: ["orders.count"], filters: [{ or: [{ member: "orders.customer.city", operator: "set" }] }] },
      { measures: ["orders.count"], timeDimensions: [{ dimension: "orders.customer.signed_up" }] },
      { measures: ["orders.count"], order: [["orders.customer.city", "asc"]] },
      { measures: ["orders.customer.lifetime.value"] },
    ]) {
      assert.throws(
        () => assertNoJoinAliasPaths(query, map),
        (err) => err.type === "UserError" && /join alias/.test(err.message),
      );
    }
  });

  it("rejects a three-segment path on a cube it cannot read", () => {
    assert.throws(
      () => assertNoJoinAliasPaths({ dimensions: ["unknown.created_at.month"] }, map),
      /join alias/,
    );
  });
});
