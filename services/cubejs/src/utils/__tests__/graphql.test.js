import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import zlib from "node:zlib";

describe("fetchGraphQL", () => {
  let server;
  let fetchGraphQL;

  before(async () => {
    const body = zlib.gzipSync(
      JSON.stringify({
        data: {
          datasources: Array.from({ length: 2000 }, (_, id) => ({
            id,
            name: `ds-${Math.random()}`,
          })),
        },
      }),
    );
    // Hasura answers gzip with a Content-Length; the connection drops halfway.
    server = http.createServer((req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": body.length,
      });
      res.write(body.subarray(0, body.length >> 1), () => res.socket.destroy());
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.HASURA_ENDPOINT = `http://127.0.0.1:${server.address().port}/v1/graphql`;
    ({ fetchGraphQL } = await import("../graphql.js"));
  });

  after(() => server.close());

  // node-fetch 2 left this pending forever, which froze the refresh
  // scheduler for every tenant at its next datasource lookup.
  it("rejects when Hasura's response is cut off mid-body", async () => {
    const outcome = await Promise.race([
      fetchGraphQL("{ datasources { id } }").then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 2000)),
    ]);

    assert.equal(outcome, "rejected");
  });
});
