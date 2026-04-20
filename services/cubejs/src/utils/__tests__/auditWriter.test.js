import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let writeAuditLog;

describe("writeAuditLog", () => {
  let originalError;
  let captured;

  beforeEach(async () => {
    captured = [];
    originalError = console.error;
    console.error = (msg) => captured.push(msg);
    ({ writeAuditLog } = await import("../auditWriter.js"));
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("rejects incomplete calls and emits a structured stderr line", async () => {
    const res = await writeAuditLog({
      action: "dataschema_delete",
      userId: null,
      targetId: "t1",
      outcome: "failure",
    });
    assert.deepEqual(res, { ok: false });

    assert.equal(captured.length, 1);
    const parsed = JSON.parse(captured[0]);
    assert.equal(parsed.event, "audit_write_failed");
    assert.equal(parsed.reason, "missing_required_fields");
  });

  it("retries on transient failures and eventually returns {ok:false}", async () => {
    // HASURA_ENDPOINT is unset (or unreachable) in this test env — fetchGraphQL
    // throws on every attempt, so the retry loop exhausts its 3 attempts and
    // the stderr line is emitted. We assert shape, not timing.
    const originalEndpoint = process.env.HASURA_ENDPOINT;
    process.env.HASURA_ENDPOINT =
      "http://127.0.0.1:1/unreachable-audit-writer-test";
    try {
      const res = await writeAuditLog({
        action: "version_rollback",
        userId: "00000000-0000-4000-8000-000000000001",
        targetId: "00000000-0000-4000-8000-000000000002",
        outcome: "failure",
        errorCode: "rollback_version_not_on_branch",
      });
      assert.deepEqual(res, { ok: false });

      const writeFailedLine = captured
        .map((m) => {
          try {
            return JSON.parse(m);
          } catch {
            return null;
          }
        })
        .find((m) => m && m.event === "audit_write_failed");
      assert.ok(writeFailedLine, "expected audit_write_failed stderr line");
      assert.equal(writeFailedLine.action, "version_rollback");
      assert.equal(writeFailedLine.outcome, "failure");
    } finally {
      if (originalEndpoint == null) {
        delete process.env.HASURA_ENDPOINT;
      } else {
        process.env.HASURA_ENDPOINT = originalEndpoint;
      }
    }
  });
});
