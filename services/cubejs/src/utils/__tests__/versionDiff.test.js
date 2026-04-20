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
});
