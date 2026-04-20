import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let handler;

describe("auditVersionRollback RPC", () => {
  let originalError;

  beforeEach(async () => {
    originalError = console.error;
    console.error = () => {};
    ({ default: handler } = await import("../auditVersionRollback.js"));
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("skips non-rollback inserts", async () => {
    const res = await handler(
      {},
      {
        event: {
          data: {
            new: { id: "v-1", origin: "user" },
          },
        },
      }
    );
    assert.deepEqual(res, { ok: true, skipped: true });
  });

  it("processes rollback inserts and reports Hasura errors gracefully", async () => {
    const prev = process.env.HASURA_ENDPOINT;
    process.env.HASURA_ENDPOINT =
      "http://127.0.0.1:1/unreachable-rollback-audit";
    try {
      const res = await handler(
        {},
        {
          event: {
            data: {
              new: {
                id: "00000000-0000-4000-8000-000000000099",
                origin: "rollback",
                branch_id: "00000000-0000-4000-8000-000000000050",
                user_id: "00000000-0000-4000-8000-000000000005",
                checksum: "abc",
              },
            },
            session_variables: {
              "x-hasura-user-id": "00000000-0000-4000-8000-000000000005",
            },
          },
        }
      );
      assert.equal(res.ok, false);
      assert.ok(typeof res.error === "string");
    } finally {
      if (prev == null) delete process.env.HASURA_ENDPOINT;
      else process.env.HASURA_ENDPOINT = prev;
    }
  });
});
