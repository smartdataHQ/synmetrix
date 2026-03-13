import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tableFromIPC } from "apache-arrow";

import {
  rowsToArrowColumns,
  serializeRowsToArrow,
} from "../src/utils/arrowSerializer.js";

describe("arrowSerializer", () => {
  it("serializes tabular rows to Arrow IPC stream bytes", () => {
    const bytes = serializeRowsToArrow([
      { id: 1, name: "alpha", active: true },
      { id: 2, name: null, active: false },
    ]);
    const table = tableFromIPC(bytes);

    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(table.numRows, 2);
    assert.deepStrictEqual(table.schema.fields.map((field) => field.name), ["id", "name", "active"]);
    assert.deepStrictEqual(Array.from(table.getChild("id")), [1, 2]);
    assert.deepStrictEqual(Array.from(table.getChild("name")), ["alpha", null]);
    assert.deepStrictEqual(Array.from(table.getChild("active")), [true, false]);
  });

  it("emits a valid empty Arrow table when only columns are known", () => {
    const bytes = serializeRowsToArrow([], { columns: ["country", "revenue"] });
    const table = tableFromIPC(bytes);

    assert.equal(table.numRows, 0);
    assert.deepStrictEqual(table.schema.fields.map((field) => field.name), ["country", "revenue"]);
  });

  it("normalizes binary and object-like values to Arrow-safe scalars", () => {
    const columns = rowsToArrowColumns([
      {
        payload: Buffer.from("ab"),
        meta: { a: 1 },
        values: [1, 2, null],
      },
      {
        payload: null,
        meta: null,
        values: null,
      },
    ]);

    assert.deepStrictEqual(columns.payload, ["YWI=", null]);
    assert.deepStrictEqual(columns.meta, ['{"a":1}', null]);
    assert.deepStrictEqual(columns.values, [[1, 2, null], null]);
  });
});
