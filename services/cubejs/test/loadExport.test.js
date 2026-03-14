import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tableFromIPC } from "apache-arrow";

import { maybeHandleLoadExport } from "../src/routes/loadExport.js";

describe("maybeHandleLoadExport", () => {
  it("streams CSV through the semantic export path when native passthrough is unavailable", async () => {
    const req = createRequest({
      format: "csv",
      query: {
        dimensions: ["Orders.city"],
        measures: ["Orders.count"],
      },
    });
    const res = new MockResponse();
    let nextCalls = 0;

    const cubejs = createMockCube({
      dbType: "clickhouse",
      normalizedQuery: req.body.query,
      sqlQuery: {
        sql: ["SELECT city AS city, count AS count FROM orders", []],
        aliasNameToMember: {
          city: "Orders.city",
          count: "Orders.count",
        },
      },
      metaConfig: createMetaConfig({
        measures: [{ name: "Orders.count", type: "count" }],
        dimensions: [{ name: "Orders.city", type: "string" }],
      }),
      streamRows: [
        { "Orders.city": "Reykjavik", "Orders.count": 2 },
        { "Orders.city": "Akureyri", "Orders.count": 1 },
      ],
    });

    await maybeHandleLoadExport(req, res, () => {
      nextCalls++;
    }, cubejs);

    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["Content-Type"], "text/csv");
    assert.equal(
      res.textOutput,
      "Orders.city,Orders.count\r\nReykjavik,2\r\nAkureyri,1\r\n"
    );
  });

  it("streams CSV through the native ClickHouse path and rewrites the header to semantic names", async () => {
    const req = createRequest({
      format: "csv",
      query: {
        dimensions: ["Orders.city"],
        measures: ["Orders.count"],
      },
    });
    const res = new MockResponse();

    const cubejs = createMockCube({
      dbType: "clickhouse",
      normalizedQuery: req.body.query,
      sqlQuery: {
        sql: ["SELECT city AS city_alias, count AS count_alias FROM orders", []],
        aliasNameToMember: {
          city_alias: "Orders.city",
          count_alias: "Orders.count",
        },
      },
      metaConfig: createMetaConfig({
        measures: [{ name: "Orders.count", type: "count" }],
        dimensions: [{ name: "Orders.city", type: "string" }],
      }),
      nativePreAggs: {
        preAggregationsTablesToTempTables: [],
        values: [],
      },
      driver: createClickHouseDriver({
        csvLines: [
          "city_alias,count_alias\n",
          "Reykjavik,2\n",
          "Akureyri,1\n",
        ],
      }),
    });

    await maybeHandleLoadExport(req, res, () => {
      throw new Error("next should not be called");
    }, cubejs);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["Content-Type"], "text/csv");
    assert.equal(
      res.textOutput,
      "Orders.city,Orders.count\r\nReykjavik,2\r\nAkureyri,1\r\n"
    );
  });

  it("streams Arrow through the semantic export path when native passthrough is unsafe", async () => {
    const req = createRequest({
      format: "arrow",
      query: {
        dimensions: ["Orders.city"],
        measures: ["Orders.count"],
        timeDimensions: [{ dimension: "Orders.createdAt", granularity: "day" }],
      },
    });
    const res = new MockResponse();

    const cubejs = createMockCube({
      dbType: "clickhouse",
      normalizedQuery: req.body.query,
      sqlQuery: {
        sql: ["SELECT city_alias, count_alias, created_day_alias FROM orders", []],
        aliasNameToMember: {
          city_alias: "Orders.city",
          count_alias: "Orders.count",
          created_day_alias: "Orders.createdAt.day",
        },
      },
      metaConfig: createMetaConfig({
        measures: [{ name: "Orders.count", type: "count" }],
        dimensions: [
          { name: "Orders.city", type: "string" },
          {
            name: "Orders.createdAt",
            type: "time",
            granularities: [{ name: "day", title: "day", interval: "1 day" }],
          },
          { name: "Orders.createdAt.day", type: "time" },
        ],
      }),
      streamRows: [
        {
          "Orders.city": "Reykjavik",
          "Orders.count": "2",
          "Orders.createdAt.day": "2024-01-01T00:00:00.000Z",
        },
      ],
      nativePreAggs: {
        preAggregationsTablesToTempTables: [],
        values: [],
      },
      driver: createClickHouseDriver({
        arrowChunks: [Buffer.from("native-arrow-should-not-be-used")],
      }),
    });

    await maybeHandleLoadExport(req, res, () => {
      throw new Error("next should not be called");
    }, cubejs);

    assert.equal(
      res.headers["Content-Type"],
      "application/vnd.apache.arrow.stream"
    );

    const parsed = tableFromIPC(res.binaryOutput);
    assert.deepEqual(parsed.toArray().map((row) => row.toJSON()), [
      {
        "Orders.city": "Reykjavik",
        "Orders.count": 2,
        "Orders.createdAt.day": Date.parse("2024-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("streams Arrow through the native ClickHouse path when aliases are already semantic", async () => {
    const req = createRequest({
      format: "arrow",
      query: {
        dimensions: ["Orders.city"],
      },
    });
    const res = new MockResponse();

    const nativeArrowBuffer = Buffer.from("arrow-stream-binary");

    const cubejs = createMockCube({
      dbType: "clickhouse",
      normalizedQuery: req.body.query,
      sqlQuery: {
        sql: ["SELECT city FROM orders", []],
        aliasNameToMember: {
          "Orders.city": "Orders.city",
        },
      },
      metaConfig: createMetaConfig({
        dimensions: [{ name: "Orders.city", type: "string" }],
      }),
      nativePreAggs: {
        preAggregationsTablesToTempTables: [],
        values: [],
      },
      driver: createClickHouseDriver({
        arrowChunks: [nativeArrowBuffer],
      }),
    });

    await maybeHandleLoadExport(req, res, () => {
      throw new Error("next should not be called");
    }, cubejs);

    assert.equal(
      res.headers["Content-Type"],
      "application/vnd.apache.arrow.stream"
    );
    assert.deepEqual(res.binaryOutput, nativeArrowBuffer);
  });

  it("falls through to the buffered path when semantic streaming is unavailable", async () => {
    const req = createRequest({
      format: "csv",
      query: {
        dimensions: ["Orders.city"],
      },
    });
    const res = new MockResponse();
    let nextCalls = 0;

    const cubejs = createMockCube({
      dbType: "postgres",
      normalizedQuery: req.body.query,
      sqlQuery: {
        sql: ["SELECT city FROM orders", []],
      },
      metaConfig: createMetaConfig({
        dimensions: [{ name: "Orders.city", type: "string" }],
      }),
    });

    await maybeHandleLoadExport(req, res, () => {
      nextCalls++;
    }, cubejs);

    assert.equal(nextCalls, 1);
    assert.equal(res.textOutput, "");
    assert.equal(res.headersSent, false);
  });

  it("falls through to the buffered path for non-regular query shapes", async () => {
    const req = createRequest({
      format: "csv",
      query: {
        dimensions: ["Orders.city"],
      },
    });
    const res = new MockResponse();
    let nextCalls = 0;

    const cubejs = createMockCube({
      dbType: "clickhouse",
      queryType: "compareDateRangeQuery",
      normalizedQuery: req.body.query,
      sqlQuery: {
        sql: ["SELECT city FROM orders", []],
      },
      metaConfig: createMetaConfig({
        dimensions: [{ name: "Orders.city", type: "string" }],
      }),
    });

    await maybeHandleLoadExport(req, res, () => {
      nextCalls++;
    }, cubejs);

    assert.equal(nextCalls, 1);
    assert.equal(res.headersSent, false);
  });
});

function createRequest({ format, query }) {
  return {
    method: "POST",
    body: { format, query },
    headers: {},
    get(name) {
      return this.headers[name.toLowerCase()];
    },
  };
}

function createMetaConfig({ measures = [], dimensions = [], segments = [] }) {
  return [
    {
      config: {
        measures: measures.map((measure) => ({
          title: measure.name,
          shortTitle: measure.name,
          description: "",
          isVisible: true,
          ...measure,
        })),
        dimensions: dimensions.map((dimension) => ({
          title: dimension.name,
          shortTitle: dimension.name,
          description: "",
          isVisible: true,
          ...dimension,
        })),
        segments: segments.map((segment) => ({
          title: segment.name,
          shortTitle: segment.name,
          description: "",
          isVisible: true,
          ...segment,
        })),
      },
    },
  ];
}

function createMockCube(options) {
  const {
    dbType,
    queryType = "regularQuery",
    normalizedQuery,
    sqlQuery,
    metaConfig,
    streamRows = [],
    nativePreAggs = null,
    driver = null,
  } = options;

  return {
    options: {
      driverFactory: async () => {
        if (!driver) {
          throw new Error("driverFactory should not be called in this test");
        }
        return driver;
      },
    },
    apiGateway() {
      return {
        checkAuth: async (request, response, next) => {
          request.securityContext = {
            userScope: {
              dataSource: {
                dbType,
              },
            },
          };
          next();
        },
        requestContextMiddleware: async (request, response, next) => {
          request.context = {
            securityContext: request.securityContext,
            requestId: "req-1",
          };
          next();
        },
        assertApiScope: async () => {},
        getNormalizedQueries: async () => [queryType, [normalizedQuery]],
        getCompilerApi: async () => ({
          metaConfig: async () => metaConfig,
        }),
        filterVisibleItemsInMeta: (context, cubes) => cubes,
        getSqlQueriesInternal: async () => [sqlQuery],
        getAdapterApi: async () => ({
          streamQuery: async () => createRowStream(streamRows),
          getQueryOrchestrator: nativePreAggs
            ? () => ({
                getPreAggregations: () => ({
                  loadAllPreAggregationsIfNeeded: async () => nativePreAggs,
                }),
              })
            : undefined,
        }),
      };
    },
    async contextRejectionMiddleware() {},
  };
}

function createClickHouseDriver({ csvLines = [], arrowChunks = [] }) {
  return {
    config: {
      clickhouseSettings: {},
    },
    client: {
      query: async () => ({
        async *stream() {
          for (const line of csvLines) {
            yield [{ text: line }];
          }
        },
      }),
      exec: async () => ({
        async *stream() {
          for (const chunk of arrowChunks) {
            yield chunk;
          }
        },
      }),
    },
  };
}

async function* createRowStream(rows) {
  for (const row of rows) {
    yield row;
  }
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.textOutput = "";
    this.binaryOutput = Buffer.alloc(0);
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
  }

  set(nameOrHeaders, value) {
    if (typeof nameOrHeaders === "string") {
      this.headers[nameOrHeaders] = value;
      return this;
    }

    Object.assign(this.headers, nameOrHeaders);
    return this;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(obj) {
    this.headersSent = true;
    this.textOutput = JSON.stringify(obj);
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }

  write(chunk) {
    this.headersSent = true;

    if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.binaryOutput = Buffer.concat([this.binaryOutput, buffer]);
      return true;
    }

    this.textOutput += chunk;
    return true;
  }

  end(chunk = "") {
    if (chunk) {
      this.write(chunk);
    }
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }
}
