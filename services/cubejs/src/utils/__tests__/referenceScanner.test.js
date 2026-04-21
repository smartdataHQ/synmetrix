import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scanCrossCubeReferences } from "../referenceScanner.js";

function mkCube(cubeName, fileName, code) {
  return { cubeName, fileName, code };
}

describe("scanCrossCubeReferences — FR-008 seven reference kinds", () => {
  it("detects `joins` by name reference", () => {
    const others = [
      mkCube(
        "order_items",
        "order_items.yml",
        `cubes:\n  - name: order_items\n    joins:\n      - name: orders\n        sql: "{CUBE}.order_id = {orders}.id"\n        relationship: many_to_one\n`
      ),
    ];
    const hits = scanCrossCubeReferences("orders", others);
    assert.ok(hits.some((h) => h.referenceKind === "joins"));
    assert.equal(hits[0].referringCube, "order_items");
    assert.equal(hits[0].file, "order_items.yml");
  });

  it("detects `extends` chain", () => {
    const others = [
      mkCube(
        "derived",
        "derived.yml",
        `cubes:\n  - name: derived\n    extends: orders\n    sql_table: derived\n`
      ),
    ];
    const hits = scanCrossCubeReferences("orders", others);
    assert.ok(hits.some((h) => h.referenceKind === "extends"));
  });

  it("detects measure/dimension `formula` reference via `{cube}.field`", () => {
    const others = [
      mkCube(
        "reports",
        "reports.yml",
        `cubes:\n  - name: reports\n    measures:\n      - name: derived\n        type: number\n        sql: "{orders.revenue}"\n`
      ),
    ];
    const hits = scanCrossCubeReferences("orders", others);
    assert.ok(hits.some((h) => h.referenceKind === "formula"));
  });

  it("detects `segment` inheritance via segment sql referencing another cube", () => {
    const others = [
      mkCube(
        "segs",
        "segs.yml",
        `cubes:\n  - name: segs\n    segments:\n      - name: active\n        sql: "{orders}.status = 'active'"\n`
      ),
    ];
    const hits = scanCrossCubeReferences("orders", others);
    assert.ok(hits.some((h) => h.referenceKind === "segment"));
  });

  it("detects `pre_aggregation` rollup references", () => {
    const others = [
      mkCube(
        "rollup_cube",
        "rollup.yml",
        `cubes:\n  - name: rollup_cube\n    pre_aggregations:\n      - name: daily\n        measures: [orders.count, orders.revenue]\n        time_dimension: orders.created_at\n        granularity: day\n`
      ),
    ];
    const hits = scanCrossCubeReferences("orders", others);
    assert.ok(hits.some((h) => h.referenceKind === "pre_aggregation"));
  });

  it("detects `filter_params` cross-cube reference", () => {
    const others = [
      mkCube(
        "other",
        "other.yml",
        `cubes:\n  - name: other\n    measures:\n      - name: count\n        type: count\n        sql: "CASE WHEN FILTER_PARAMS.orders.created_at.filter('created_at') THEN 1 ELSE 0 END"\n`
      ),
    ];
    const hits = scanCrossCubeReferences("orders", others);
    assert.ok(hits.some((h) => h.referenceKind === "filter_params"));
  });

  it("detects `sub_query` reference via sub_query + cross-cube sql", () => {
    const others = [
      mkCube(
        "stats",
        "stats.yml",
        `cubes:\n  - name: stats\n    dimensions:\n      - name: orders_total\n        sub_query: true\n        sql: "{orders.revenue}"\n        type: number\n`
      ),
    ];
    const hits = scanCrossCubeReferences("orders", others);
    assert.ok(hits.some((h) => h.referenceKind === "sub_query"));
  });

  it("returns empty array when no cube references the target", () => {
    const others = [
      mkCube(
        "lonely",
        "lonely.yml",
        `cubes:\n  - name: lonely\n    sql_table: lonely\n`
      ),
    ];
    const hits = scanCrossCubeReferences("orders", others);
    assert.deepEqual(hits, []);
  });

  it("does not match a cube on itself (self-reference guard)", () => {
    const others = [
      mkCube(
        "orders",
        "orders.yml",
        `cubes:\n  - name: orders\n    sql_table: public.orders\n    measures:\n      - name: count\n        type: count\n`
      ),
    ];
    const hits = scanCrossCubeReferences("orders", others);
    assert.deepEqual(hits, []);
  });

  it("emits line numbers (1-based) for each hit", () => {
    const code = `cubes:\n  - name: other\n    joins:\n      - name: orders\n        sql: "{CUBE}.id = {orders}.id"\n`;
    const hits = scanCrossCubeReferences("orders", [
      mkCube("other", "other.yml", code),
    ]);
    assert.ok(hits.length >= 1);
    for (const h of hits) {
      assert.ok(typeof h.line === "number" && h.line >= 1);
    }
  });
});
