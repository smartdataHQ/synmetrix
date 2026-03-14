import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canSemanticStreamLoadExport,
  resolveLoadExportCapabilities,
} from "../src/utils/loadExportCapabilities.js";

describe("resolveLoadExportCapabilities", () => {
  it("enables semantic row streaming for ClickHouse", () => {
    const capabilities = resolveLoadExportCapabilities({
      userScope: {
        dataSource: {
          dbType: "clickhouse",
        },
      },
    });

    assert.deepEqual(capabilities, {
      semanticRowStream: true,
      nativeCsvPassthrough: true,
      nativeArrowPassthrough: true,
      incrementalArrowEncode: true,
    });
  });

  it("falls back to buffered capabilities for other databases", () => {
    const capabilities = resolveLoadExportCapabilities({
      userScope: {
        dataSource: {
          dbType: "postgres",
        },
      },
    });

    assert.deepEqual(capabilities, {
      semanticRowStream: false,
      nativeCsvPassthrough: false,
      nativeArrowPassthrough: false,
      incrementalArrowEncode: false,
    });
  });
});

describe("canSemanticStreamLoadExport", () => {
  it("allows CSV when semantic row streaming is available", () => {
    assert.equal(
      canSemanticStreamLoadExport("csv", {
        semanticRowStream: true,
        incrementalArrowEncode: false,
      }),
      true
    );
  });

  it("allows Arrow when an incremental encoder exists", () => {
    assert.equal(
      canSemanticStreamLoadExport("arrow", {
        semanticRowStream: true,
        incrementalArrowEncode: true,
      }),
      true
    );
  });
});
