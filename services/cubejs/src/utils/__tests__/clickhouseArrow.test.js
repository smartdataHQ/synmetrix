import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  execClickHouseArrowStream,
  isForbiddenClickHouseArrowCompressionError
} from "../clickhouseArrow.js";

describe("clickhouseArrow", () => {
  it("detects the readonly Arrow compression SET error", () => {
    assert.equal(
      isForbiddenClickHouseArrowCompressionError(
        new Error(
          "Cannot modify 'output_format_arrow_compression_method' setting in readonly mode."
        )
      ),
      true
    );
    assert.equal(
      isForbiddenClickHouseArrowCompressionError(new Error("timeout")),
      false
    );
  });

  it("retries without the compression override after a readonly SET error", async () => {
    const settingsByCall = [];
    const driver = {
      config: { clickhouseSettings: { max_execution_time: 30 } },
      client: {
        exec: async (opts) => {
          settingsByCall.push(opts.clickhouse_settings);
          if (settingsByCall.length === 1) {
            throw new Error(
              "Cannot modify 'output_format_arrow_compression_method' setting in readonly mode."
            );
          }
          return { ok: true, query: opts.query };
        }
      }
    };

    const result = await execClickHouseArrowStream({
      driver,
      sql: "SELECT 1;",
      signal: undefined
    });

    assert.equal(result.ok, true);
    assert.match(result.query, /FORMAT ArrowStream/);
    assert.equal(settingsByCall.length, 2);
    assert.equal(settingsByCall[0].max_execution_time, 30);
    assert.equal(settingsByCall[0].output_format_arrow_compression_method, "none");
    assert.equal(settingsByCall[1].max_execution_time, 30);
    assert.equal(
      settingsByCall[1].output_format_arrow_compression_method,
      undefined
    );
  });
});
