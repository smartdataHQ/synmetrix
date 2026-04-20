import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let handler;

describe("auditLogsRetention RPC", () => {
  let originalError;

  beforeEach(async () => {
    originalError = console.error;
    console.error = () => {};
    ({ default: handler } = await import("../auditLogsRetention.js"));
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("returns a structured error when Hasura is unreachable", async () => {
    const prev = process.env.HASURA_ENDPOINT;
    process.env.HASURA_ENDPOINT =
      "http://127.0.0.1:1/unreachable-retention-test";
    try {
      const res = await handler();
      assert.ok(res);
      assert.ok(
        typeof res.error === "string" && res.error.length > 0,
        "expected structured error on unreachable Hasura"
      );
    } finally {
      if (prev == null) delete process.env.HASURA_ENDPOINT;
      else process.env.HASURA_ENDPOINT = prev;
    }
  });
});
