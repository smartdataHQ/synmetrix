import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { reconcileOneTeam } from "../../utils/defaultModels/shared.js";

const CONFIG = {
  templateDatasourceId: "11111111-1111-4111-8111-111111111111",
  systemUserId: "22222222-2222-4222-8222-222222222222",
  targetDatasourceName: "Semantic Events",
};

const TEMPLATES = [
  { name: "semantic_events", fileName: "semantic_events.yml", code: "cubes: []", checksum: "t1" },
  { name: "order_metrics", fileName: "order_metrics.yml", code: "cubes: []", checksum: "t1" },
];

const TARGET = { datasourceId: "ds-1", branchId: "br-1" };

const teamWith = (settings) => ({ id: "team-1", name: "acme.is", settings });

describe("opt-out semantics (FR-013) — RPC side", () => {
  it("reads team.settings.default_models.opt_out and passes it to the worker", async () => {
    let seen = null;
    const outcomes = await reconcileOneTeam(
      teamWith({
        partition: "acme.is",
        default_models: { opt_out: ["order_metrics"] },
      }),
      TEMPLATES,
      CONFIG,
      {
        deps: {
          resolveTarget: async () => TARGET,
          worker: async (params) => {
            seen = params;
            return [{ template: "semantic_events", result: "updated" }];
          },
        },
      }
    );

    assert.deepEqual(seen.optOut, ["order_metrics"]);
    assert.equal(seen.partition ?? seen.team.settings.partition, "acme.is");
    assert.equal(outcomes[0].team_id, "team-1");
    assert.equal(outcomes[0].datasource_id, "ds-1");
  });

  it("defaults to an empty opt-out list when the settings key is absent", async () => {
    let seen = null;
    await reconcileOneTeam(teamWith({ partition: "acme.is" }), TEMPLATES, CONFIG, {
      deps: {
        resolveTarget: async () => TARGET,
        worker: async (params) => {
          seen = params;
          return [];
        },
      },
    });
    assert.deepEqual(seen.optOut, []);
  });

  it("fails cleanly when the team has no partition", async () => {
    const outcomes = await reconcileOneTeam(teamWith({}), TEMPLATES, CONFIG, {
      deps: {
        resolveTarget: async () => TARGET,
        worker: async () => {
          throw new Error("must not be called");
        },
      },
    });
    assert.equal(outcomes[0].result, "failed");
    assert.equal(outcomes[0].reason, "no_partition");
  });

  it("records target_datasource_unavailable when the target cannot be resolved or provisioned", async () => {
    const outcomes = await reconcileOneTeam(
      teamWith({ partition: "acme.is" }),
      TEMPLATES,
      CONFIG,
      {
        deps: {
          resolveTarget: async () => null,
          worker: async () => {
            throw new Error("must not be called");
          },
        },
      }
    );
    assert.equal(outcomes[0].result, "failed");
    assert.equal(outcomes[0].reason, "target_datasource_unavailable");
  });

  it("a worker rejection becomes a failed outcome, never a throw (FR-018)", async () => {
    const outcomes = await reconcileOneTeam(
      teamWith({ partition: "acme.is" }),
      TEMPLATES,
      CONFIG,
      {
        deps: {
          resolveTarget: async () => TARGET,
          worker: async () => {
            throw new Error("cubejs unreachable");
          },
        },
      }
    );
    assert.equal(outcomes[0].result, "failed");
    assert.match(outcomes[0].reason, /cubejs unreachable/);
  });
});
