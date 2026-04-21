import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { summarizeCube } from "../metaAll.js";

const ds = {
  id: "ds-1",
  name: "prod",
  db_type: "clickhouse",
  team_id: "team-1",
};

describe("summarizeCube — T013h dataschema_id / file_name enrichment", () => {
  it("populates dataschema_id + file_name when the cube name maps to a dataschema row", () => {
    const dataschemaByCubeName = new Map([
      ["orders", { id: "ds-row-1", name: "orders.yml" }],
      ["customers", { id: "ds-row-2", name: "customers.yml" }],
    ]);
    const compiled = {
      config: {
        name: "orders",
        title: "Orders",
        public: true,
        measures: [{ name: "count" }],
        dimensions: [{ name: "id" }],
        segments: [],
        meta: null,
      },
    };
    const out = summarizeCube(
      compiled,
      ds,
      "branch-1",
      "ver-1",
      dataschemaByCubeName
    );
    assert.equal(out.dataschema_id, "ds-row-1");
    assert.equal(out.file_name, "orders.yml");
    assert.equal(out.name, "orders");
  });

  it("returns null when the cube name has no backing dataschema (synthetic cube)", () => {
    const compiled = {
      config: {
        name: "synthetic_cube",
        public: true,
        measures: [],
        dimensions: [],
        segments: [],
      },
    };
    const out = summarizeCube(
      compiled,
      ds,
      "branch-1",
      "ver-1",
      new Map()
    );
    assert.equal(out.dataschema_id, null);
    assert.equal(out.file_name, null);
  });

  it("returns null when the cube name does not match any declared cube", () => {
    const dataschemaByCubeName = new Map([
      ["orders", { id: "ds-row-1", name: "orders.yml" }],
    ]);
    const compiled = {
      config: {
        name: "ghosts",
        public: true,
        measures: [],
        dimensions: [],
        segments: [],
      },
    };
    const out = summarizeCube(
      compiled,
      ds,
      "branch-1",
      "ver-1",
      dataschemaByCubeName
    );
    assert.equal(out.dataschema_id, null);
    assert.equal(out.file_name, null);
  });
});
