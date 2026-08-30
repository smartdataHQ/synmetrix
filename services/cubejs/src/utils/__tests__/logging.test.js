import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

const emitQueryLogMock = mock.fn();
const xaddMock = mock.fn(async () => "stream-id");

mock.module("@cubejs-backend/server-core/dist/src/core/logger.js", {
  namedExports: { devLogger: () => () => null },
});
mock.module("../eventEmitter.js", {
  namedExports: { emitQueryLog: emitQueryLogMock },
});
mock.module("../redis.js", {
  defaultExport: { status: "ready", xadd: xaddMock },
});

const { logging } = await import("../logging.js");

const successEvent = (overrides = {}) => ({
  requestId: "request-1",
  path: "/cubejs-api/v1/load?query=redacted",
  duration: 12,
  query: { measures: ["Orders.count"] },
  securityContext: {
    userId: "person-1",
    tokenPayload: { accountId: "account-1", partition: "tenant.is" },
    userScope: {
      dataSource: {
        dataSourceId: "datasource-1",
        dbType: "clickhouse",
        partition: "datasource-partition.is",
      },
    },
  },
  ...overrides,
});

describe("Query Executed logger attribution", () => {
  beforeEach(() => {
    emitQueryLogMock.mock.resetCalls();
    xaddMock.mock.resetCalls();
  });

  it("uses the verified token attribution stored by checkAuth", async () => {
    await logging("Load Request Success", successEvent());

    assert.equal(emitQueryLogMock.mock.callCount(), 1);
    assert.deepEqual(emitQueryLogMock.mock.calls[0].arguments[0], {
      accountId: "account-1",
      partition: "tenant.is",
      userId: "person-1",
      status: "ok",
      dimensions: { surface: "load", datasource_type: "clickhouse" },
      metrics: { duration_ms: 12 },
      properties: {
        datasource_id: "datasource-1",
        request_id: "request-1",
        path: "/cubejs-api/v1/load",
      },
    });
  });

  it("falls back to the tenant-scoped datasource partition", async () => {
    const event = successEvent();
    event.securityContext.tokenPayload.partition = null;
    event.securityContext.tokenPayload.accountId = null;

    await logging("Load Request Success", event);

    assert.equal(
      emitQueryLogMock.mock.calls[0].arguments[0].partition,
      "datasource-partition.is",
    );
  });

  it("does not copy query payloads into semantic-event properties", async () => {
    await logging("Load Request Success", successEvent());

    const emitted = emitQueryLogMock.mock.calls[0].arguments[0];
    assert.equal(emitted.properties.query, undefined);
    assert.equal(emitted.properties.sql, undefined);
    assert.deepEqual(Object.keys(emitted.properties).sort(), [
      "datasource_id",
      "path",
      "request_id",
    ]);
  });
});
