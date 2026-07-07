import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDriftQuery,
  captureDriftSnapshot,
  diffDriftSnapshots,
} from "../drift.js";

describe("buildDriftQuery", () => {
  it("emits one fleet-wide GROUP BY partition probe per entry (D7)", () => {
    const sql = buildDriftQuery({
      table: "cst.semantic_events",
      timeColumn: "timestamp",
    });
    assert.match(sql, /SELECT\s+partition/i);
    assert.match(sql, /count\(\)/);
    assert.match(sql, /max\(timestamp\)/);
    assert.match(sql, /FROM cst\.semantic_events/);
    assert.match(sql, /GROUP BY partition/);
  });
});

describe("captureDriftSnapshot", () => {
  it("merges multiple probes into partition -> {row_count, max_event_time}", async () => {
    const config = {
      driftProbes: [
        { table: "cst.semantic_events", timeColumn: "timestamp" },
        { table: "cst.data_points", timeColumn: "ts" },
      ],
    };
    const responses = {
      "cst.semantic_events": [
        { partition: "a.is", row_count: "10", max_event_time: "2026-07-01" },
        { partition: "b.is", row_count: "5", max_event_time: "2026-07-02" },
      ],
      "cst.data_points": [
        { partition: "a.is", row_count: "3", max_event_time: "2026-07-03" },
      ],
    };
    const executeSql = async (sql) => {
      for (const [table, rows] of Object.entries(responses)) {
        if (sql.includes(table)) return rows;
      }
      return [];
    };

    const snapshot = await captureDriftSnapshot(config, { executeSql });

    assert.deepEqual(snapshot["a.is"], {
      row_count: 13,
      max_event_time: "2026-07-03",
    });
    assert.deepEqual(snapshot["b.is"], {
      row_count: 5,
      max_event_time: "2026-07-02",
    });
  });

  it("returns null when no drift probes are configured (all teams changed)", async () => {
    const snapshot = await captureDriftSnapshot(
      { driftProbes: [] },
      { executeSql: async () => [] }
    );
    assert.equal(snapshot, null);
  });
});

describe("diffDriftSnapshots", () => {
  const prev = {
    "a.is": { row_count: 10, max_event_time: "2026-07-01" },
    "b.is": { row_count: 5, max_event_time: "2026-07-02" },
    "gone.is": { row_count: 2, max_event_time: "2026-06-01" },
  };

  it("yields exactly the changed/new partition set", () => {
    const current = {
      "a.is": { row_count: 10, max_event_time: "2026-07-01" }, // unchanged
      "b.is": { row_count: 6, max_event_time: "2026-07-02" }, // row_count moved
      "new.is": { row_count: 1, max_event_time: "2026-07-05" }, // new partition
    };
    const changed = diffDriftSnapshots(prev, current);
    assert.deepEqual([...changed].sort(), ["b.is", "gone.is", "new.is"]);
  });

  it("detects max_event_time drift alone", () => {
    const current = {
      ...prev,
      "a.is": { row_count: 10, max_event_time: "2026-07-04" },
    };
    const changed = diffDriftSnapshots(prev, current);
    assert.ok(changed.has("a.is"));
  });

  it("missing prior snapshot means every team is considered changed (null)", () => {
    assert.equal(diffDriftSnapshots(null, { "a.is": {} }), null);
    assert.equal(diffDriftSnapshots(undefined, { "a.is": {} }), null);
  });

  it("missing current snapshot means every team is considered changed (null)", () => {
    assert.equal(diffDriftSnapshots(prev, null), null);
  });

  it("identical snapshots produce an empty changed set", () => {
    const changed = diffDriftSnapshots(prev, JSON.parse(JSON.stringify(prev)));
    assert.equal(changed.size, 0);
  });
});
