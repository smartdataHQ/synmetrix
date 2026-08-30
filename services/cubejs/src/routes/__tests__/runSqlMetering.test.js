import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { beforeEach, describe, it, mock } from "node:test";

const commitMock = mock.fn();
mock.module("../../utils/enrichmentMetering.js", {
  namedExports: { commitSqlEnrichmentBilling: commitMock },
});
mock.module("../../utils/queryRewrite.js", {
  namedExports: { loadRules: async () => [] },
});
mock.module("../../utils/enrichmentEntitlement.js", {
  namedExports: { assertSqlEnrichmentAuthorized: () => {} },
});
mock.module("../../utils/eventEmitter.js", {
  namedExports: { emitQueryEvent: () => {} },
});

const { default: runSql } = await import("../runSql.js");

class Response extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.payloads = [];
  }

  status(value) {
    this.statusCode = value;
    return this;
  }

  set() {
    return this;
  }

  type() {
    return this;
  }

  send(value) {
    this.headersSent = true;
    this.writableEnded = true;
    this.payloads.push(value);
    this.emit("finish");
    return this;
  }

  json(value) {
    return this.send(value);
  }
}

const request = () => ({
  body: { query: "SELECT * FROM enrich.day_context_v", format: "json" },
  securityContext: {
    userId: "person-1",
    tokenPayload: { accountId: "account-1", partition: "tenant.is" },
    userScope: {
      dataSource: { dataSourceId: "datasource-1", dbType: "clickhouse" },
    },
  },
  get: (name) => (name === "x-request-id" ? "request-1" : null),
});
const cubejs = {
  options: {
    driverFactory: async () => ({ query: async () => [{ value: 1 }] }),
  },
};

describe("run-sql billing commit", () => {
  beforeEach(() => {
    commitMock.mock.resetCalls();
    commitMock.mock.mockImplementation(async () => []);
  });

  it("durably meters after execution and before returning a successful result", async () => {
    const res = new Response();
    await runSql(request(), res, cubejs);
    assert.equal(commitMock.mock.callCount(), 1);
    assert.equal(commitMock.mock.calls[0].arguments[1].returnedRows, 1);
    assert.equal(commitMock.mock.calls[0].arguments[1].surface, "run-sql");
    assert.equal(res.statusCode, 200);
    assert.equal(res.payloads[0], '[{"value":1}]');
  });

  it("returns an error instead of a successful result when enqueue fails", async () => {
    commitMock.mock.mockImplementation(async () => {
      const error = new Error("outbox unavailable");
      error.status = 503;
      throw error;
    });
    const res = new Response();
    await runSql(request(), res, cubejs);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.payloads, [
      { code: "run_sql_failed", message: "outbox unavailable" },
    ]);
  });
});
