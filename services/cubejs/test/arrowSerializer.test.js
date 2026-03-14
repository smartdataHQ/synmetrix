import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tableFromIPC } from "apache-arrow";

import {
  rowsToArrowColumns,
  serializeRowsToArrow,
  writeRowStreamAsArrow,
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

  it("streams semantic rows as Arrow IPC batches", async () => {
    const writable = new MockBinaryWritable();

    await writeRowStreamAsArrow(
      writable,
      createRowStream([
        {
          city: "Reykjavik",
          count: "2",
          active: "true",
          ts: "2024-01-01T00:00:00.000Z",
        },
        {
          city: "Akureyri",
          count: 1,
          active: false,
          ts: new Date("2024-01-02T00:00:00.000Z"),
        },
      ]),
      {
        columns: ["city", "count", "active", "ts"],
        annotation: {
          dimensions: {
            city: { type: "string" },
            active: { type: "boolean" },
          },
          measures: {
            count: { type: "count" },
          },
          timeDimensions: {
            ts: { type: "time" },
          },
        },
      }
    );

    const table = tableFromIPC(writable.output);

    assert.deepStrictEqual(
      table.schema.fields.map((field) => field.type.toString()),
      ["Utf8", "Float64", "Bool", "Timestamp<MILLISECOND>"]
    );
    assert.deepStrictEqual(table.toArray().map((row) => row.toJSON()), [
      {
        city: "Reykjavik",
        count: 2,
        active: true,
        ts: Date.parse("2024-01-01T00:00:00.000Z"),
      },
      {
        city: "Akureyri",
        count: 1,
        active: false,
        ts: Date.parse("2024-01-02T00:00:00.000Z"),
      },
    ]);
  });

  it("emits a valid empty Arrow stream when columns are known", async () => {
    const writable = new MockBinaryWritable();

    await writeRowStreamAsArrow(writable, createRowStream([]), {
      columns: ["city", "count"],
      annotation: {
        dimensions: {
          city: { type: "string" },
        },
        measures: {
          count: { type: "count" },
        },
      },
    });

    const table = tableFromIPC(writable.output);
    assert.equal(table.numRows, 0);
    assert.deepStrictEqual(
      table.schema.fields.map((field) => [field.name, field.type.toString()]),
      [
        ["city", "Utf8"],
        ["count", "Float64"],
      ]
    );
  });
});

async function* createRowStream(rows) {
  for (const row of rows) {
    yield row;
  }
}

class MockBinaryWritable {
  constructor() {
    this.output = Buffer.alloc(0);
    this.destroyed = false;
    this.writableEnded = false;
  }

  write(chunk) {
    this.output = Buffer.concat([
      this.output,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    return true;
  }

  once() {}

  off() {}
}
