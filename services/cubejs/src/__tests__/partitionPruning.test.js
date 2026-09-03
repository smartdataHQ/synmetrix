import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyPartitionPruning } from "../utils/queryRewrite.js";

const policy = { semantic_events: { dimension: "timestamp", marginDays: 31 } };
const map = new Map([
  [
    "simple_stays",
    {
      sourceTable: "semantic_events",
      dimensions: new Set(["timestamp", "started", "poi"]),
      partitionDimension: null,
    },
  ],
  [
    "bookings",
    { sourceTable: "bookings", dimensions: new Set(["created"]), partitionDimension: null },
  ],
  [
    "no_ts",
    { sourceTable: "semantic_events", dimensions: new Set(["started"]), partitionDimension: null },
  ],
]);

describe("partition pruning rewrite", () => {
  it("adds a widened timestamp window from an explicit timeDimensions range", () => {
    const q = applyPartitionPruning(
      {
        measures: ["simple_stays.poi_stay_count"],
        dimensions: ["simple_stays.poi"],
        timeDimensions: [
          { dimension: "simple_stays.started", dateRange: ["2026-06-01", "2026-06-07"] },
        ],
      },
      map,
      policy,
    );
    assert.deepEqual(q.filters, [
      {
        member: "simple_stays.timestamp",
        operator: "inDateRange",
        values: ["2026-05-01", "2026-07-08"],
      },
    ]);
  });

  it("derives the window from inDateRange filters too, taking the union", () => {
    const q = applyPartitionPruning(
      {
        measures: ["simple_stays.count"],
        filters: [
          { member: "simple_stays.started", operator: "inDateRange", values: ["2026-01-10", "2026-01-20"] },
          { member: "simple_stays.started", operator: "inDateRange", values: ["2026-03-01", "2026-03-05"] },
        ],
      },
      map,
      policy,
    );
    const added = q.filters.at(-1);
    assert.equal(added.member, "simple_stays.timestamp");
    assert.deepEqual(added.values, ["2025-12-10", "2026-04-05"]);
  });

  it("leaves queries alone when the partition column is already constrained", () => {
    const q = {
      measures: ["simple_stays.count"],
      timeDimensions: [
        { dimension: "simple_stays.timestamp", dateRange: ["2026-06-01", "2026-06-07"] },
      ],
    };
    applyPartitionPruning(q, map, policy);
    assert.equal(q.filters, undefined);
  });

  it("skips relative ranges, ungoverned tables, and cubes without the dimension", () => {
    for (const query of [
      {
        measures: ["simple_stays.count"],
        timeDimensions: [{ dimension: "simple_stays.started", dateRange: "last 7 days" }],
      },
      {
        measures: ["bookings.count"],
        timeDimensions: [{ dimension: "bookings.created", dateRange: ["2026-06-01", "2026-06-07"] }],
      },
      {
        measures: ["no_ts.count"],
        timeDimensions: [{ dimension: "no_ts.started", dateRange: ["2026-06-01", "2026-06-07"] }],
      },
    ]) {
      applyPartitionPruning(query, map, policy);
      assert.equal(query.filters, undefined);
    }
  });

  it("honours meta.partition_dimension per cube", () => {
    const custom = new Map([
      [
        "events_v2",
        {
          sourceTable: "semantic_events",
          dimensions: new Set(["event_time", "occurred"]),
          partitionDimension: "event_time",
        },
      ],
    ]);
    const q = applyPartitionPruning(
      {
        measures: ["events_v2.count"],
        timeDimensions: [{ dimension: "events_v2.occurred", dateRange: ["2026-02-01", "2026-02-02"] }],
      },
      custom,
      policy,
    );
    assert.equal(q.filters[0].member, "events_v2.event_time");
  });
});
