import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let handler;

describe("auditDataschemaDelete RPC", () => {
  let originalError;

  beforeEach(async () => {
    originalError = console.error;
    console.error = () => {};
    ({ default: handler } = await import("../auditDataschemaDelete.js"));
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("rejects payloads missing event.data.old.id", async () => {
    const res = await handler({}, { event: { data: { old: null } } });
    assert.equal(res.ok, false);
    assert.match(res.error, /no event.data.old payload/);
  });

  it("falls through to fetchGraphQL and returns a structured error when HASURA is unreachable", async () => {
    const prev = process.env.HASURA_ENDPOINT;
    process.env.HASURA_ENDPOINT =
      "http://127.0.0.1:1/unreachable-audit-test";
    try {
      const res = await handler(
        { "x-hasura-user-id": "user-1" },
        {
          event: {
            data: {
              old: {
                id: "00000000-0000-4000-8000-000000000001",
                datasource_id: "00000000-0000-4000-8000-000000000010",
                version_id: "00000000-0000-4000-8000-000000000020",
                user_id: "user-1",
              },
            },
            session_variables: { "x-hasura-user-id": "user-1" },
          },
        }
      );
      assert.equal(res.ok, false);
      assert.ok(typeof res.error === "string" && res.error.length > 0);
    } finally {
      if (prev == null) delete process.env.HASURA_ENDPOINT;
      else process.env.HASURA_ENDPOINT = prev;
    }
  });
});
