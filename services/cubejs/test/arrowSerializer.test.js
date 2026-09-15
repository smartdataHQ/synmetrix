import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { tableFromIPC } from "apache-arrow";
import { deriveExportColumnsFromLoad, getLoadRequestQuery } from "../src/utils/loadExportUtils.js";

import {
  rowsToArrowColumns,
  serializeRowsToArrow,
  writeRowStreamAsArrow,
} from "../src/utils/arrowSerializer.js";

describe("arrowSerializer", () => {
  it("returns an error instead of silently truncating the buffered load response", async () => {
    const source = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
    const start = source.indexOf("    const transform = async (cubeResponse) => {");
    const end = source.indexOf("    res.json =", start);
    assert.ok(start >= 0 && end > start);
    let body;
    let status = 200;
    const headers = {};
    const transform = runInNewContext(source.slice(start, end) + "\ntransform;", {
      format: "arrow",
      req: { method: "POST", body: { query: { dimensions: ["Orders.id"] } } },
      res: {
        headersSent: false,
        set: (key, value) => { headers[key] = value; },
        status: (value) => { status = value; },
      },
      originalSend: (value) => { body = value; },
      sendJson: (value) => { body = value; headers["Content-Type"] = "application/json"; },
      console: { error() {} },
      serializeRowsToArrow,
      deriveExportColumnsFromLoad,
      getLoadRequestQuery,
    });
    const rows = Array(100_001).fill({ "Orders.id": 1 });
    await transform({ data: rows });
    assert.equal(status, 413);
    assert.equal(rows.length, 100_001);
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["Content-Disposition"], undefined);
    assert.match(body.error, /Failed to transform/);
    status = 200;
    await transform({ data: [{ "Orders.id": 7 }] });
    assert.equal(status, 200);
    assert.equal(headers["Content-Type"], "application/vnd.apache.arrow.stream");
    assert.equal(tableFromIPC(body).getChild("Orders.id").get(0), 7);
  });

  it("rejects oversized buffered exports without truncating or reading row values", () => {
    let reads = 0;
    const row = { get id() { reads++; return 1; } };
    const rows = Array(100_001).fill(row);
    assert.throws(() => serializeRowsToArrow(rows), {
      name: "RangeError",
      status: 413,
    });
    assert.equal(rows.length, 100_001);
    assert.equal(reads, 0);
    const boundary = Array.from({ length: 100_000 }, (_, index) => ({ id: index }));
    const table = tableFromIPC(serializeRowsToArrow(boundary));
    assert.equal(table.numRows, 100_000);
    assert.equal(table.getChild("id").get(99_999), 99_999);
    assert.equal(boundary.length, 100_000);
  });

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
