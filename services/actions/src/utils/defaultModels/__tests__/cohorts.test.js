import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assignCohort, buildCohorts, shouldHalt } from "../cohorts.js";

const team = (id, name = id, settings = {}) => ({ id, name, settings });

const CONFIG = {
  cohorts: 4,
  canaryTeamIds: ["canary-extra"],
  haltThreshold: 0.2,
};

describe("assignCohort", () => {
  it("is deterministic across runs (hash(team_id) mod cohorts)", () => {
    const first = assignCohort("11111111-1111-4111-8111-111111111111", 4);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(
        assignCohort("11111111-1111-4111-8111-111111111111", 4),
        first
      );
    }
    assert.ok(first >= 0 && first < 4);
  });

  it("spreads teams across all cohorts", () => {
    const seen = new Set();
    for (let i = 0; i < 64; i += 1) {
      seen.add(assignCohort(`team-${i}`, 4));
    }
    assert.equal(seen.size, 4, "all four cohorts used");
  });
});

describe("buildCohorts", () => {
  it("canary cohort = fftech.is team plus configured canary ids, first in order", () => {
    const teams = [
      team("a"),
      team("fftech-id", "fftech.is"),
      team("canary-extra", "extra.is"),
      team("b"),
      team("c"),
    ];
    const cohorts = buildCohorts(teams, CONFIG);

    assert.equal(cohorts[0].name, "canary");
    assert.deepEqual(
      cohorts[0].teams.map((t) => t.id).sort(),
      ["canary-extra", "fftech-id"]
    );

    // canary members never reappear in later cohorts
    const rest = cohorts.slice(1).flatMap((c) => c.teams.map((t) => t.id));
    assert.ok(!rest.includes("fftech-id"));
    assert.ok(!rest.includes("canary-extra"));
    // and everyone else is assigned exactly once
    assert.deepEqual(rest.sort(), ["a", "b", "c"]);
  });

  it("produces cohorts_total = canary + configured cohort count", () => {
    const cohorts = buildCohorts([team("a")], CONFIG);
    assert.equal(cohorts.length, 1 + CONFIG.cohorts);
  });

  it("assignment within cohorts is deterministic", () => {
    const teams = Array.from({ length: 20 }, (_, i) => team(`team-${i}`));
    const first = buildCohorts(teams, CONFIG).map((c) =>
      c.teams.map((t) => t.id)
    );
    const second = buildCohorts(teams, CONFIG).map((c) =>
      c.teams.map((t) => t.id)
    );
    assert.deepEqual(first, second);
  });
});

describe("shouldHalt", () => {
  it("halts when the cohort failure rate exceeds the threshold", () => {
    assert.equal(shouldHalt({ failures: 3, total: 10, threshold: 0.2 }), true);
  });

  it("CONTINUES when the rate is at or below the threshold (below-threshold failures never stop the fleet — FR-018)", () => {
    assert.equal(shouldHalt({ failures: 2, total: 10, threshold: 0.2 }), false);
    assert.equal(shouldHalt({ failures: 1, total: 10, threshold: 0.2 }), false);
    assert.equal(shouldHalt({ failures: 0, total: 10, threshold: 0.2 }), false);
  });

  it("an empty cohort never halts", () => {
    assert.equal(shouldHalt({ failures: 0, total: 0, threshold: 0.2 }), false);
  });
});
