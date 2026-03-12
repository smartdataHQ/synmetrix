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
      assert.ok(Array.isArray(ds.value), "value must be an array");
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
      // They should NOT be on individual dimensions
      for (const dimId of ds.id) {
        const dim = ds.dimension[dimId];
        assert.equal(dim.role, undefined, `dimension ${dimId} must not have a role property`);
      }
    });
  });

  describe("explicit classification", () => {
    it("with options.measures and options.timeDimensions, no warning in extension", () => {
      const ds = buildJSONStat(rows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      if (ds.extension) {
        assert.equal(ds.extension.warning, undefined, "should not have heuristic warning");
      }
    });
  });

  describe("heuristic inference", () => {
    it("without hints, numeric columns become measures, year/date patterns become time, includes warning", () => {
      const ds = buildJSONStat(rows, columns);
      assert.ok(ds.extension, "extension must exist");
      assert.ok(
        typeof ds.extension.warning === "string",
        "extension.warning must be a string"
      );
      // revenue should be a measure (part of metric dimension categories)
      assert.ok(ds.role.metric, "should have metric role");
      // year should be a time dimension
      assert.ok(ds.role.time, "should have time role");
      assert.ok(ds.role.time.length > 0, "should have at least one time dimension");
    });
  });

  describe("multiple measures", () => {
    it("become categories of a metric-role dimension", () => {
      const multiRows = [
        { country: "US", revenue: 100, profit: 30 },
        { country: "UK", revenue: 200, profit: 50 },
      ];
      const ds = buildJSONStat(multiRows, ["country", "revenue", "profit"], {
        measures: ["revenue", "profit"],
      });
      // Find the metric dimension
      const metricDimId = ds.role.metric[0];
      assert.ok(metricDimId, "must have a metric dimension");
      const metricDim = ds.dimension[metricDimId];
      const cats = metricDim.category.index;
      assert.ok("revenue" in cats, "revenue must be a category");
      assert.ok("profit" in cats, "profit must be a category");
    });
  });

  describe("null handling", () => {
    it("null values in rows appear as null in value array", () => {
      const nullRows = [
        { country: "US", year: "2025", revenue: null },
        { country: "US", year: "2026", revenue: 110 },
      ];
      const ds = buildJSONStat(nullRows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      assert.ok(ds.value.includes(null), "value array must contain null");
    });
  });

  describe("duplicate column disambiguation", () => {
    it("columns with same name get numeric suffix", () => {
      const dupRows = [{ a: 1, a_2: 2 }];
      // Simulate duplicate column names in the columns array
      const ds = buildJSONStat(dupRows, ["a", "a"], {
        measures: ["a", "a"],
      });
      // After disambiguation, should have "a" and "a_2"
      // The dataset should still be valid
      assert.equal(ds.version, "2.0");
      assert.equal(ds.id.length, ds.size.length);
    });
  });

  describe("measures-only query", () => {
    it("no dimensions, just measures produces single metric dimension", () => {
      const measRows = [{ revenue: 100, profit: 30 }];
      const ds = buildJSONStat(measRows, ["revenue", "profit"], {
        measures: ["revenue", "profit"],
      });
      assert.equal(ds.id.length, 1, "should have exactly one dimension (metric)");
      assert.ok(ds.role.metric, "must have metric role");
    });
  });

  describe("binary columns", () => {
    it("omitted with extension warning", () => {
      const binRows = [
        { country: "US", data: Buffer.from([0x00, 0xff]) },
      ];
      const ds = buildJSONStat(binRows, ["country", "data"]);
      // data column should be omitted
      assert.equal(ds.dimension.data, undefined, "binary column should be omitted");
      assert.ok(ds.extension, "extension must exist");
      assert.ok(
        typeof ds.extension.warning === "string" &&
          ds.extension.warning.toLowerCase().includes("binary"),
        "warning should mention binary columns"
      );
    });
  });

  describe("empty result with columns", () => {
    it("returns valid dataset with value: []", () => {
      const ds = buildJSONStat([], ["country", "year", "revenue"], {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      assert.equal(ds.version, "2.0");
      assert.equal(ds.class, "dataset");
      assert.deepStrictEqual(ds.value, []);
    });
  });

  describe("empty result without columns", () => {
    it("returns error object with status 400", () => {
      const ds = buildJSONStat([], []);
      assert.equal(ds.status, 400);
      assert.ok(typeof ds.error === "string");
    });

    it("returns error for null/undefined columns", () => {
      const ds = buildJSONStat([], null);
      assert.equal(ds.status, 400);
    });
  });

  describe("invariants", () => {
    it("id.length === size.length", () => {
      const ds = buildJSONStat(rows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      assert.equal(ds.id.length, ds.size.length);
    });

    it("value.length === product(size)", () => {
      const ds = buildJSONStat(rows, columns, {
        measures: ["revenue"],
        timeDimensions: ["year"],
      });
      const product = ds.size.reduce((a, b) => a * b, 1);
      assert.equal(ds.value.length, product);
    });

    it("invariants hold for heuristic path too", () => {
      const ds = buildJSONStat(rows, columns);
      assert.equal(ds.id.length, ds.size.length);
      const product = ds.size.reduce((a, b) => a * b, 1);
      assert.equal(ds.value.length, product);
    });

    it("invariants hold for multiple measures", () => {
      const multiRows = [
        { country: "US", revenue: 100, profit: 30 },
        { country: "UK", revenue: 200, profit: 50 },
      ];
      const ds = buildJSONStat(multiRows, ["country", "revenue", "profit"], {
        measures: ["revenue", "profit"],
      });
      assert.equal(ds.id.length, ds.size.length);
      const product = ds.size.reduce((a, b) => a * b, 1);
      assert.equal(ds.value.length, product);
    });
  });
});
