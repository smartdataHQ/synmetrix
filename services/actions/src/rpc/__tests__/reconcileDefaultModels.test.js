import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const UUID = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

const CONFIG = {
  templateDatasourceId: UUID("1"),
  systemUserId: UUID("2"),
  targetDatasourceName: "Semantic Events",
  canaryTeamIds: [],
  // threshold 1 = never halt: these tests exercise per-team ISOLATION
  // (FR-018), not the halt policy — with 3 teams the hashed cohorts are
  // near-singletons and any failure would otherwise trip the halt.
  haltThreshold: 1,
  cohorts: 4,
  driftProbes: [],
  cronSecret: "cron-s3cret",
};

const TEAMS = [
  { id: "team-a", name: "a.is", settings: { partition: "a.is" } },
  { id: "team-b", name: "b.is", settings: { partition: "b.is" } },
  { id: "team-c", name: "c.is", settings: { partition: "c.is" } },
];

const TEMPLATES = {
  templateChecksum: "tpl-1",
  templates: [
    { name: "semantic_events", fileName: "semantic_events.yml", code: "cubes: []", checksum: "tpl-1" },
  ],
};

const fakeReporter = () => {
  const state = { appended: [], finalized: null, started: null, cohorts: [] };
  return {
    state,
    resolveActiveRun: async () => ({ run: null, stale: false }),
    startRun: async (fields) => {
      state.started = fields;
      return { id: "run-1", status: "running", ...fields };
    },
    getLatestCompletedRun: async () => null,
    appendOutcome: async (runId, outcome) => {
      state.appended.push({ runId, outcome });
    },
    heartbeat: async () => {},
    updateCohortState: async (runId, cohortState) => {
      state.cohorts.push(cohortState);
    },
    setDriftSnapshot: async () => {},
    finalizeRun: async (runId, payload) => {
      state.finalized = { runId, ...payload };
    },
  };
};

const baseDeps = (reporter, overrides = {}) => ({
  loadConfig: () => CONFIG,
  reporter,
  ensureSystemUser: async () => {},
  fetchTemplates: async () => TEMPLATES,
  listTeams: async () => TEAMS,
  reconcileOneTeam: async (team) => [
    { team_id: team.id, template: "semantic_events", result: "updated" },
  ],
  isAdmin: async () => false,
  ...overrides,
});

let handler;

describe("reconcileDefaultModels RPC (fleet orchestrator)", () => {
  beforeEach(async () => {
    ({ default: handler } = await import("../reconcileDefaultModels.js"));
  });

  it("rejects callers without the cron secret or portal-admin rights (403)", async () => {
    const reporter = fakeReporter();
    const res = await handler({}, { trigger: "manual" }, {}, baseDeps(reporter));

    assert.equal(res.error, true);
    assert.equal(res.status, 403);
    assert.equal(reporter.state.started, null, "no run row created");
  });

  it("accepts the cron-secret header", async () => {
    const reporter = fakeReporter();
    const res = await handler(
      null,
      { trigger: "schedule" },
      { "x-actions-cron-secret": "cron-s3cret" },
      baseDeps(reporter)
    );

    assert.ok(!res.error, JSON.stringify(res));
    assert.equal(res.runId, "run-1");
    assert.equal(res.status, "completed");
  });

  it("FR-018 fleet isolation: one team's worker failure never stops the others", async () => {
    const reporter = fakeReporter();
    const deps = baseDeps(reporter, {
      reconcileOneTeam: async (team) => {
        if (team.id === "team-b") {
          throw new Error("worker exploded mid-flight");
        }
        return [{ team_id: team.id, template: "semantic_events", result: "updated" }];
      },
    });

    const res = await handler(
      null,
      { trigger: "schedule" },
      { "x-actions-cron-secret": "cron-s3cret" },
      deps
    );

    assert.equal(res.status, "completed");

    const appendedTeams = reporter.state.appended.map((a) => a.outcome.team_id).sort();
    assert.deepEqual(appendedTeams, ["team-a", "team-b", "team-c"]);

    const failed = reporter.state.appended.find((a) => a.outcome.team_id === "team-b");
    assert.equal(failed.outcome.result, "failed");
    assert.match(failed.outcome.reason, /worker exploded/);

    assert.equal(res.totals.updated, 2);
    assert.equal(res.totals.failed, 1);
    assert.equal(reporter.state.finalized.status, "completed");
  });

  it("returns already_running when a fresh run holds the lease", async () => {
    const reporter = fakeReporter();
    reporter.resolveActiveRun = async () => ({
      run: { id: "run-live" },
      stale: false,
    });

    const res = await handler(
      null,
      { trigger: "schedule" },
      { "x-actions-cron-secret": "cron-s3cret" },
      baseDeps(reporter)
    );

    assert.equal(res.status, "already_running");
    assert.equal(res.runId, "run-live");
    assert.equal(reporter.state.started, null);
  });

  it("halts the rollout when a cohort's validation-failure rate exceeds the threshold (FR-010)", async () => {
    const reporter = fakeReporter();
    const deps = baseDeps(reporter, {
      loadConfig: () => ({ ...CONFIG, haltThreshold: 0.2 }),
      reconcileOneTeam: async (team) => [
        {
          team_id: team.id,
          template: "semantic_events",
          result: "failed",
          reason: "validation: Unknown dimension 'foo' in cube 'SemanticEvents'",
        },
      ],
    });

    const res = await handler(
      null,
      { trigger: "schedule" },
      { "x-actions-cron-secret": "cron-s3cret" },
      deps
    );

    assert.equal(res.status, "halted");
    assert.equal(reporter.state.finalized.status, "halted");
    // the halt fired after the first failing cohort — the fleet was NOT drained
    const processedTeams = new Set(
      reporter.state.appended.map((a) => a.outcome.team_id)
    );
    assert.ok(
      processedTeams.size < TEAMS.length,
      `remaining cohorts untouched (processed ${processedTeams.size}/${TEAMS.length})`
    );
    assert.ok(reporter.state.cohorts.length > 0, "cohort_state persisted");
    assert.equal(reporter.state.cohorts.at(-1).failure_rate, 1);
  });

  it("environmental failures (config gaps, connectivity, pre-broken branches) never trip the halt", async () => {
    // only validation rejections of a FRESH candidate signal a bad rollout —
    // every other failure class writes nothing and says nothing about the
    // template's quality, so it must be reported but must not halt
    const environmental = [
      "no_partition",
      "target_datasource_unavailable",
      "Query failed: Error: default: Authentication failed",
      "probe timeout",
      "preexisting_invalid_branch: FILTER_PARAMS is not defined",
    ];
    let i = 0;
    const reporter = fakeReporter();
    const deps = baseDeps(reporter, {
      loadConfig: () => ({ ...CONFIG, haltThreshold: 0.2 }),
      reconcileOneTeam: async (team) => [
        {
          team_id: team.id,
          result: "failed",
          reason: environmental[i++ % environmental.length],
        },
      ],
    });

    const res = await handler(
      null,
      { trigger: "schedule" },
      { "x-actions-cron-secret": "cron-s3cret" },
      deps
    );

    assert.equal(res.status, "completed", "fleet completes despite env failures");
    assert.equal(res.totals.failed, 3, "all failures still recorded");
  });

  it("promotes a schedule tick to template_publish when the template checksum moved", async () => {
    const reporter = fakeReporter();
    reporter.getLatestCompletedRun = async () => ({
      id: "run-old",
      template_checksum: "tpl-0-previous",
    });

    await handler(
      null,
      { trigger: "schedule" },
      { "x-actions-cron-secret": "cron-s3cret" },
      baseDeps(reporter)
    );

    assert.equal(reporter.state.started.trigger, "template_publish");
  });

  it("schedule tick with no drift skips unchanged teams before any per-team work (US3)", async () => {
    const reporter = fakeReporter();
    const snapshot = {
      "a.is": { row_count: 1, max_event_time: "t" },
      "b.is": { row_count: 2, max_event_time: "t" },
      "c.is": { row_count: 3, max_event_time: "t" },
    };
    reporter.getLatestCompletedRun = async () => ({
      id: "run-prev",
      template_checksum: "tpl-1", // unchanged template
      drift_snapshot: snapshot,
    });

    const workerCalls = [];
    const deps = baseDeps(reporter, {
      loadConfig: () => ({
        ...CONFIG,
        driftProbes: [{ table: "cst.semantic_events", timeColumn: "timestamp" }],
      }),
      captureDrift: async () => ({
        ...snapshot,
        "b.is": { row_count: 99, max_event_time: "t2" }, // only b.is drifted
      }),
      reconcileOneTeam: async (team) => {
        workerCalls.push(team.id);
        return [{ team_id: team.id, template: "semantic_events", result: "updated" }];
      },
    });

    const res = await handler(
      null,
      { trigger: "schedule" },
      { "x-actions-cron-secret": "cron-s3cret" },
      deps
    );

    assert.deepEqual(workerCalls, ["team-b"], "only the drifted team hits the worker");
    assert.equal(res.totals.updated, 1);
    assert.equal(res.totals.skipped_no_change, 2);
    assert.deepEqual(reporter.state.started.driftSnapshot["b.is"].row_count, 99);
  });

  it("dryRun computes outcomes but persists nothing", async () => {
    const reporter = fakeReporter();
    const res = await handler(
      null,
      { trigger: "manual", dryRun: true },
      { "x-actions-cron-secret": "cron-s3cret" },
      baseDeps(reporter)
    );

    assert.equal(reporter.state.started, null, "no run row");
    assert.equal(reporter.state.appended.length, 0, "no outcome writes");
    assert.equal(res.totals.updated, 3);
    assert.equal(res.dryRun, true);
  });
});
