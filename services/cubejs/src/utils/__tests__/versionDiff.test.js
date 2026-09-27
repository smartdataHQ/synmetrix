import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { diffVersions } from "../versionDiff.js";

function mkRow(name, code, checksum) {
  return { id: name, name, code, checksum: checksum || null };
}

const ordersV1 = `cubes:
  - name: orders
    sql_table: public.orders
    measures:
      - name: count
        type: count
    dimensions:
      - name: id
        type: number
        sql: id
        primary_key: true
`;

const ordersV2 = `cubes:
  - name: orders
    sql_table: public.orders
    measures:
      - name: count
        type: count
      - name: revenue
        type: sum
        sql: amount
    dimensions:
      - name: id
        type: number
        sql: id
        primary_key: true
`;

const customers = `cubes:
  - name: customers
    sql_table: public.customers
    measures:
      - name: count
        type: count
    dimensions:
      - name: id
        type: number
        sql: id
        primary_key: true
`;

describe("diffVersions", () => {
  it("returns all empty arrays when both versions are identical", () => {
    const out = diffVersions({
      fromDataschemas: [mkRow("orders.yml", ordersV1)],
      toDataschemas: [mkRow("orders.yml", ordersV1)],
    });
    assert.deepEqual(out.addedCubes, []);
    assert.deepEqual(out.removedCubes, []);
    assert.deepEqual(out.modifiedCubes, []);
  });

  it("skips byte-identical files even when code strings differ by checksum match", () => {
    const out = diffVersions({
      fromDataschemas: [mkRow("orders.yml", ordersV1, "same")],
      toDataschemas: [mkRow("orders.yml", ordersV1, "same")],
    });
    assert.deepEqual(out.modifiedCubes, []);
  });

  it("detects an added cube (new file in toDataschemas)", () => {
    const out = diffVersions({
      fromDataschemas: [mkRow("orders.yml", ordersV1)],
      toDataschemas: [
        mkRow("orders.yml", ordersV1),
        mkRow("customers.yml", customers),
      ],
    });
    assert.equal(out.addedCubes.length, 1);
    assert.equal(out.addedCubes[0].cubeName, "customers");
    assert.equal(out.addedCubes[0].file, "customers.yml");
    assert.deepEqual(out.removedCubes, []);
    assert.deepEqual(out.modifiedCubes, []);
  });

  it("detects a removed cube (file missing from toDataschemas)", () => {
    const out = diffVersions({
      fromDataschemas: [
        mkRow("orders.yml", ordersV1),
        mkRow("customers.yml", customers),
      ],
      toDataschemas: [mkRow("orders.yml", ordersV1)],
    });
    assert.deepEqual(out.addedCubes, []);
    assert.equal(out.removedCubes.length, 1);
    assert.equal(out.removedCubes[0].cubeName, "customers");
  });

  it("detects modified cubes with per-measure field changes", () => {
    const out = diffVersions({
      fromDataschemas: [mkRow("orders.yml", ordersV1)],
      toDataschemas: [mkRow("orders.yml", ordersV2)],
    });
    assert.deepEqual(out.addedCubes, []);
    assert.deepEqual(out.removedCubes, []);
    assert.equal(out.modifiedCubes.length, 1);
    const mod = out.modifiedCubes[0];
    assert.equal(mod.cubeName, "orders");
    assert.equal(mod.file, "orders.yml");
    assert.ok(Array.isArray(mod.changes));
    assert.ok(mod.changes.length >= 1);
    const measures = mod.changes.find((c) => c.field === "measures");
    assert.ok(measures, "expected a measures-level change entry");
    assert.ok(measures.added.includes("revenue"));
  });

  it("reports attribute-level changes the old type-only diff ignored", () => {
    const edited = ordersV1
      .replace("sql_table: public.orders", "sql_table: public.orders_v2")
      .replace(
        "        sql: id\n        primary_key: true",
        "        sql: id\n        title: Order id\n        primary_key: true"
      );
    const out = diffVersions({
      fromDataschemas: [mkRow("orders.yml", ordersV1)],
      toDataschemas: [mkRow("orders.yml", edited)],
    });
    assert.equal(out.modifiedCubes.length, 1);
    const mod = out.modifiedCubes[0];
    assert.equal(mod.kind, "cube");
    assert.deepEqual(mod.changedAttributes.sort(), [
      "dimensions.id.title",
      "sql_table",
    ]);
    const dims = mod.changes.find((c) => c.field === "dimensions");
    assert.deepEqual(dims.modified, ["id"]);
    assert.deepEqual(out.modifiedFiles, [
      { file: "orders.yml", cubeNames: ["orders"] },
    ]);
  });

  it("diffs joins, pre-aggregations and views member by member", () => {
    const from = `cubes:
  - name: orders
    sql_table: public.orders
    joins:
      - name: customers
        sql: "{CUBE}.customer_id = {customers}.id"
        relationship: many_to_one
views:
  - name: sales
    cubes:
      - join_path: orders
        includes: "*"
`;
    const to = from
      .replace("relationship: many_to_one", "relationship: one_to_one")
      .replace('includes: "*"', "includes: [count]");
    const out = diffVersions({
      fromDataschemas: [mkRow("m.yml", from)],
      toDataschemas: [mkRow("m.yml", to)],
    });
    const byName = Object.fromEntries(
      out.modifiedCubes.map((c) => [c.cubeName, c])
    );
    assert.deepEqual(byName.orders.changedAttributes, [
      "joins.customers.relationship",
    ]);
    assert.equal(byName.sales.kind, "view");
    assert.deepEqual(byName.sales.changedAttributes, ["cubes"]);
  });

  it("reports cubes added inside an existing file as added", () => {
    const out = diffVersions({
      fromDataschemas: [mkRow("all.yml", ordersV1)],
      toDataschemas: [mkRow("all.yml", ordersV1 + customers.slice("cubes:\n".length))],
    });
    assert.deepEqual(out.addedCubes, [
      { cubeName: "customers", file: "all.yml", kind: "cube" },
    ]);
    assert.deepEqual(out.modifiedCubes, []);
  });

  it("always lists a file whose code differs, even without a semantic change", () => {
    const out = diffVersions({
      fromDataschemas: [mkRow("orders.yml", ordersV1)],
      toDataschemas: [mkRow("orders.yml", `# note\n${ordersV1}`)],
    });
    assert.deepEqual(out.modifiedCubes, []);
    assert.deepEqual(out.modifiedFiles, [{ file: "orders.yml", cubeNames: [] }]);
  });

  it("parses JS files that also declare views", () => {
    const js = (title) => `cube(\`orders\`, {
  sql_table: \`public.orders\`,
  measures: { count: { type: \`count\`, title: \`${title}\` } },
});
view(\`sales\`, { cubes: [{ join_path: \`orders\`, includes: \`*\` }] });
`;
    const out = diffVersions({
      fromDataschemas: [mkRow("orders.js", js("Orders"))],
      toDataschemas: [mkRow("orders.js", js("Order count"))],
    });
    assert.equal(out.modifiedCubes.length, 1);
    assert.deepEqual(out.modifiedCubes[0].changedAttributes, [
      "measures.count.title",
    ]);
  });

  it("does not report cubes of an unparseable file as removed", () => {
    const out = diffVersions({
      fromDataschemas: [mkRow("orders.yml", ordersV1)],
      toDataschemas: [mkRow("orders.yml", "cubes: [\n  broken")],
    });
    assert.deepEqual(out.removedCubes, []);
    assert.deepEqual(out.modifiedFiles, [{ file: "orders.yml", cubeNames: [] }]);
  });
});
