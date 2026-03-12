import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  escapeCSVField,
  rowToCSV,
  serializeRowsToCSV,
  writeRowsAsCSV,
} from "../src/utils/csvSerializer.js";

describe("escapeCSVField", () => {
  it("returns plain string unchanged", () => {
    assert.equal(escapeCSVField("hello"), "hello");
  });

  it("wraps value in quotes when it contains a comma", () => {
    assert.equal(escapeCSVField("one,two"), '"one,two"');
  });

  it("escapes double quotes as double-double quotes", () => {
    assert.equal(escapeCSVField('say "hi"'), '"say ""hi"""');
  });

  it("wraps value in quotes when it contains a newline", () => {
    assert.equal(escapeCSVField("line1\nline2"), '"line1\nline2"');
  });

  it("wraps value in quotes when it contains a carriage return", () => {
    assert.equal(escapeCSVField("line1\r\nline2"), '"line1\r\nline2"');
  });

  it("returns empty string for null", () => {
    assert.equal(escapeCSVField(null), "");
  });

  it("returns empty string for undefined", () => {
    assert.equal(escapeCSVField(undefined), "");
  });

  it("returns empty string for empty string", () => {
    assert.equal(escapeCSVField(""), "");
  });

  it("converts numbers to string", () => {
    assert.equal(escapeCSVField(42), "42");
    assert.equal(escapeCSVField(3.14), "3.14");
    assert.equal(escapeCSVField(0), "0");
  });

  it("converts boolean to string", () => {
    assert.equal(escapeCSVField(true), "true");
    assert.equal(escapeCSVField(false), "false");
  });

  it("base64 encodes Buffer (binary/non-UTF8 data)", () => {
    const buf = Buffer.from([0x00, 0xff, 0x80, 0x01]);
    assert.equal(escapeCSVField(buf), buf.toString("base64"));
  });

  it("handles string with both commas and quotes", () => {
    assert.equal(escapeCSVField('a,"b"'), '"a,""b"""');
  });
});

describe("rowToCSV", () => {
  it("maintains column ordering from provided columns array", () => {
    const row = { name: "Alice", age: "30", city: "NYC" };
    const columns = ["city", "name", "age"];
    assert.equal(rowToCSV(row, columns), "NYC,Alice,30");
  });

  it("handles missing keys as empty", () => {
    const row = { name: "Bob" };
    const columns = ["name", "age", "city"];
    assert.equal(rowToCSV(row, columns), "Bob,,");
  });

  it("escapes fields that need escaping", () => {
    const row = { name: "O'Brien, Jr.", note: 'said "hello"' };
    const columns = ["name", "note"];
    assert.equal(rowToCSV(row, columns), '"O\'Brien, Jr.","said ""hello"""');
  });
});

describe("serializeRowsToCSV", () => {
  it("returns empty string for empty array", () => {
    assert.equal(serializeRowsToCSV([]), "");
  });

  it("produces header row from first row keys plus data rows", () => {
    const rows = [
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ];
    const result = serializeRowsToCSV(rows);
    assert.equal(result, "id,name\r\n1,Alice\r\n2,Bob\r\n");
  });

  it("produces header and one data line for single row", () => {
    const rows = [{ x: "10", y: "20" }];
    const result = serializeRowsToCSV(rows);
    assert.equal(result, "x,y\r\n10,20\r\n");
  });

  it("uses CRLF line endings per RFC 4180", () => {
    const rows = [{ a: "1" }, { a: "2" }];
    const result = serializeRowsToCSV(rows);
    // Every line should end with \r\n
    const lines = result.split("\r\n");
    // Last split element is empty string after trailing \r\n
    assert.equal(lines[lines.length - 1], "");
    assert.equal(lines.length, 4); // header, row1, row2, trailing empty
    // Ensure no bare \n without \r
    assert.equal(result.includes("\n") && !result.includes("\r\n"), false);
  });

  it("handles values needing escaping in full serialization", () => {
    const rows = [
      { greeting: "hello", message: 'say "bye"' },
    ];
    const result = serializeRowsToCSV(rows);
    assert.equal(result, 'greeting,message\r\nhello,"say ""bye"""\r\n');
  });
});

describe("writeRowsAsCSV", () => {
  it("writes the same CSV payload as serializeRowsToCSV", async () => {
    const rows = [
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ];
    const writable = new MockWritable();

    await writeRowsAsCSV(writable, rows);

    assert.equal(writable.output, serializeRowsToCSV(rows));
  });

  it("flushes in chunks and waits for backpressure to clear", async () => {
    const rows = [
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
      { id: "3", name: "Cara" },
    ];
    const writable = new MockWritable({ stallOnWrite: 2 });

    await writeRowsAsCSV(writable, rows, { chunkSize: 12 });

    assert.equal(writable.output, serializeRowsToCSV(rows));
    assert.ok(writable.writeCalls >= 2, "expected multiple chunk writes");
    assert.ok(writable.drainWaits >= 1, "expected to wait for drain at least once");
  });
});

class MockWritable extends EventEmitter {
  constructor(options = {}) {
    super();
    this.output = "";
    this.writeCalls = 0;
    this.drainWaits = 0;
    this.stallOnWrite = options.stallOnWrite ?? 0;
  }

  write(chunk) {
    this.output += chunk;
    this.writeCalls++;
    if (this.stallOnWrite > 0 && this.writeCalls === this.stallOnWrite) {
      this.drainWaits++;
      setImmediate(() => this.emit("drain"));
      return false;
    }
    return true;
  }
}
