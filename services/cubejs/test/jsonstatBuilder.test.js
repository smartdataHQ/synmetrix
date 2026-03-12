import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildJSONStat } from "../src/utils/jsonstatBuilder.js";

const rows = [
  { country: "US", year: "2025", revenue: 100 },
  { country: "US", year: "2026", revenue: 110 },
  { country: "UK", year: "2025", revenue: 200 },
  { country: "UK", year: "2026", revenue: 210 },
];
const columns = ["country", "year", "revenue"];

describe("buildJSONStat", () => {
  describe("valid JSON-Stat 2.0 structure", () => {
    it("produces correct version, class, id, size, dimension, value properties", () => {
      const ds = buildJSONStat(rows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      assert.equal(ds.version, "2.0");
      assert.equal(ds.class, "dataset");
      assert.ok(Array.isArray(ds.id), "id must be an array");
      assert.ok(Array.isArray(ds.size), "size must be an array");
      assert.ok(typeof ds.dimension === "object" && ds.dimension !== null);
      assert.ok(Array.isArray(ds.value), "dense default should produce an array for small cubes");
    });
  });

  describe("dataset-level roles", () => {
    it("role.time and role.metric are arrays on the dataset object", () => {
      const ds = buildJSONStat(rows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      assert.ok(ds.role, "role must exist on dataset");
      assert.ok(Array.isArray(ds.role.metric), "role.metric must be an array");
      assert.ok(Array.isArray(ds.role.time), "role.time must be an array");
      for (const dimId of ds.id) {
        const dim = ds.dimension[dimId];
        assert.equal(dim.role, undefined, `dimension ${dimId} must not have a role property`);
      }
    });
  });

  describe("classification", () => {
    it("uses explicit classification without heuristic warning", () => {
      const ds = buildJSONStat(rows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      assert.equal(ds.extension?.warning, undefined);
    });

    it("falls back to heuristics when hints are omitted", () => {
      const ds = buildJSONStat(rows, columns);
      assert.match(ds.extension.warning, /heuristically/i);
      assert.deepStrictEqual(ds.role.metric, ["metric"]);
      assert.deepStrictEqual(ds.role.time, ["year"]);
    });
  });

  describe("placement and measures", () => {
    it("creates a metric dimension for multiple measures", () => {
      const multiRows = [
        { country: "US", revenue: 100, profit: 30 },
        { country: "UK", revenue: 200, profit: 50 },
      ];
      const ds = buildJSONStat(multiRows, ["country", "revenue", "profit"], {
        measures: ["revenue", "profit"],
      });
      const metricDimId = ds.role.metric[0];
      const metricDim = ds.dimension[metricDimId];
      assert.ok("revenue" in metricDim.category.index);
      assert.ok("profit" in metricDim.category.index);
    });

    it("uses row-major placement with metric last", () => {
      const sparseRows = [
        { country: "US", year: "2025", revenue: 1 },
        { country: "US", year: "2026", revenue: 2 },
        { country: "UK", year: "2025", revenue: 3 },
      ];
      const ds = buildJSONStat(sparseRows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });

      assert.deepStrictEqual(ds.id, ["country", "year", "metric"]);
      assert.deepStrictEqual(ds.size, [2, 2, 1]);
      assert.deepStrictEqual(ds.value, [1, 2, 3, null]);
    });

    it("keeps null measures as null", () => {
      const nullRows = [
        { country: "US", year: "2025", revenue: null },
        { country: "US", year: "2026", revenue: 110 },
      ];
      const ds = buildJSONStat(nullRows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      assert.ok(ds.value.includes(null));
    });

    it("supports measure-only queries", () => {
      const measRows = [{ revenue: 100, profit: 30 }];
      const ds = buildJSONStat(measRows, ["revenue", "profit"], {
        measures: ["revenue", "profit"],
      });
      assert.equal(ds.id.length, 1);
      assert.deepStrictEqual(ds.role.metric, ["metric"]);
    });
  });

  describe("correctness fixes", () => {
    it("maps duplicate explicit measure hints across deduped columns", () => {
      const dupRows = [{ a: 1, a_2: 2 }];
      const ds = buildJSONStat(dupRows, ["a", "a"], {
        measures: ["a"],
      });
      const metricDim = ds.dimension[ds.role.metric[0]];
      assert.deepStrictEqual(Object.keys(metricDim.category.index), ["a", "a_2"]);
    });

    it("distinguishes null and empty-string dimension values", () => {
      const ds = buildJSONStat(
        [
          { country: null, revenue: 1 },
          { country: "", revenue: 2 },
        ],
        ["country", "revenue"],
        { measures: ["revenue"] }
      );
      assert.equal(Object.keys(ds.dimension.country.category.index).length, 2);
      assert.deepStrictEqual(ds.value, [1, 2]);
    });

    it("distinguishes numeric and string dimension values with the same rendered label", () => {
      const ds = buildJSONStat(
        [
          { country: 1, revenue: 1 },
          { country: "1", revenue: 2 },
        ],
        ["country", "revenue"],
        { measures: ["revenue"] }
      );
      assert.equal(Object.keys(ds.dimension.country.category.index).length, 2);
      assert.deepStrictEqual(ds.value, [1, 2]);
    });

    it("avoids colliding with a real metric dimension", () => {
      const ds = buildJSONStat(
        [{ metric: "A", revenue: 1 }],
        ["metric", "revenue"],
        { measures: ["revenue"] }
      );
      assert.deepStrictEqual(ds.id, ["metric", "metric_2"]);
      assert.deepStrictEqual(ds.role.metric, ["metric_2"]);
      assert.ok(ds.dimension.metric);
      assert.ok(ds.dimension.metric_2);
    });

    it("aggregates duplicate tuples by default and emits a warning", () => {
      const ds = buildJSONStat(
        [
          { country: "US", revenue: 1 },
          { country: "US", revenue: 2 },
        ],
        ["country", "revenue"],
        { measures: ["revenue"] }
      );
      assert.deepStrictEqual(ds.value, [3]);
      assert.match(ds.extension.warning, /duplicate dimension tuples/i);
    });

    it("can reject duplicate tuples explicitly", () => {
      const ds = buildJSONStat(
        [
          { country: "US", revenue: 1 },
          { country: "US", revenue: 2 },
        ],
        ["country", "revenue"],
        { measures: ["revenue"], duplicatePolicy: "error" }
      );
      assert.equal(ds.status, 400);
      assert.match(ds.error, /duplicate dimension tuples/i);
    });
  });

  describe("category metadata options", () => {
    it("supports compact category metadata", () => {
      const ds = buildJSONStat(rows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
        categoryIndexFormat: "array",
        includeCategoryLabels: false,
      });

      assert.deepStrictEqual(ds.dimension.country.category.index, ["US", "UK"]);
      assert.equal(ds.dimension.country.category.label, undefined);
    });
  });

  describe("binary columns", () => {
    it("omits binary columns with a warning", () => {
      const ds = buildJSONStat(
        [{ country: "US", data: Buffer.from([0x00, 0xff]) }],
        ["country", "data"]
      );
      assert.equal(ds.dimension.data, undefined);
      assert.match(ds.extension.warning, /binary/i);
    });
  });

  describe("empty results", () => {
    it("returns a valid empty dataset when columns are known", () => {
      const ds = buildJSONStat([], ["country", "year", "revenue"], {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      assert.equal(ds.version, "2.0");
      assert.deepStrictEqual(ds.id, ["country", "year", "metric"]);
      assert.deepStrictEqual(ds.size, [0, 0, 1]);
      assert.deepStrictEqual(ds.value, []);
      assert.deepStrictEqual(ds.role.time, ["year"]);
      assert.deepStrictEqual(ds.role.metric, ["metric"]);
    });

    it("returns an error for empty results without columns", () => {
      const ds = buildJSONStat([], []);
      assert.equal(ds.status, 400);
      assert.ok(typeof ds.error === "string");
    });

    it("returns an error for null columns", () => {
      const ds = buildJSONStat([], null);
      assert.equal(ds.status, 400);
    });
  });

  describe("value encoding", () => {
    it("supports explicit sparse value encoding", () => {
      const sparseRows = Array.from({ length: 20 }, (_, i) => ({
        country: `C${i}`,
        year: `Y${i}`,
        revenue: i + 1,
      }));
      const ds = buildJSONStat(sparseRows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
        valueFormat: "sparse",
      });

      assert.equal(Array.isArray(ds.value), false);
      assert.equal(typeof ds.value, "object");
      assert.equal(Object.keys(ds.value).length, 20);
    });

    it("auto-selects sparse value encoding for low-density cubes", () => {
      const sparseRows = Array.from({ length: 20 }, (_, i) => ({
        country: `C${i}`,
        year: `Y${i}`,
        revenue: i + 1,
      }));
      const ds = buildJSONStat(sparseRows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });

      assert.equal(Array.isArray(ds.value), false);
      assert.equal(Object.keys(ds.value).length, 20);
      assert.match(ds.extension.warning, /sparse json-stat value encoding/i);
    });

    it("rejects overly large dense output", () => {
      const sparseRows = Array.from({ length: 20 }, (_, i) => ({
        country: `C${i}`,
        year: `Y${i}`,
        revenue: i + 1,
      }));
      const ds = buildJSONStat(sparseRows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
        valueFormat: "dense",
        maxDenseCells: 100,
      });

      assert.equal(ds.status, 413);
      assert.match(ds.error, /dense json-stat output/i);
    });
  });

  describe("invariants", () => {
    it("keeps id and size aligned", () => {
      const ds = buildJSONStat(rows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      assert.equal(ds.id.length, ds.size.length);
    });

    it("dense value length matches the product of size", () => {
      const ds = buildJSONStat(rows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      const product = ds.size.reduce((a, b) => a * b, 1);
      assert.equal(ds.value.length, product);
    });
  });
});
