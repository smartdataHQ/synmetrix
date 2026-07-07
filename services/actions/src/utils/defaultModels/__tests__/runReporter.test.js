import { test } from "node:test";
import assert from "node:assert/strict";

import createRunReporter, { STALE_LEASE_MS } from "../runReporter.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Fake GraphQL executor: records every (query, variables) call and returns
// canned responses keyed by a substring of the query.
const fakeExecutor = (responders = {}) => {
  const calls = [];
  const execute = async (query, variables) => {
    calls.push({ query, variables });
    for (const [needle, respond] of Object.entries(responders)) {
      if (query.includes(needle)) {
        return typeof respond === "function" ? respond(variables) : respond;
      }
    }
    return { data: {} };
  };
  return { calls, execute };
};

test("startRun inserts a reconciliation_runs row and returns it", async () => {
  const { calls, execute } = fakeExecutor({
    insert_reconciliation_runs_one: (vars) => ({
      data: {
        insert_reconciliation_runs_one: {
          id: RUN_ID,
          status: "running",
          trigger: vars.object.trigger,
        },
      },
    }),
  });
  const reporter = createRunReporter({ execute });

  const run = await reporter.startRun({
    trigger: "schedule",
    templateChecksum: "ab12",
    driftSnapshot: { "elko.is": { row_count: 10 } },
  });

  assert.equal(run.id, RUN_ID);
  assert.equal(run.trigger, "schedule");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].variables.object.trigger, "schedule");
  assert.equal(calls[0].variables.object.template_checksum, "ab12");
  assert.deepEqual(calls[0].variables.object.drift_snapshot, {
    "elko.is": { row_count: 10 },
  });
});

test("appendOutcome uses jsonb _append — never read-modify-write", async () => {
  const { calls, execute } = fakeExecutor();
  const reporter = createRunReporter({ execute });

  await reporter.appendOutcome(RUN_ID, {
    team_id: TEAM_ID,
    result: "updated",
  });

  assert.equal(calls.length, 1, "exactly one mutation, no prior read");
  assert.match(calls[0].query, /_append/);
  assert.doesNotMatch(
    calls[0].query,
    /^\s*query/i,
    "no query (read) issued for an outcome append"
  );
  assert.deepEqual(calls[0].variables.outcome, {
    team_id: TEAM_ID,
    result: "updated",
  });
});

test("concurrent appendOutcome calls each issue one atomic _append", async () => {
  const { calls, execute } = fakeExecutor();
  const reporter = createRunReporter({ execute });

  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      reporter.appendOutcome(RUN_ID, { team_id: `team-${i}`, result: "updated" })
    )
  );

  assert.equal(calls.length, 10);
  for (const call of calls) {
    assert.match(call.query, /_append/);
  }
});

test("heartbeat refreshes heartbeat_at", async () => {
  const { calls, execute } = fakeExecutor();
  const reporter = createRunReporter({ execute });

  await reporter.heartbeat(RUN_ID);

  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /heartbeat_at/);
  assert.match(calls[0].query, /now\(\)/);
  assert.equal(calls[0].variables.id, RUN_ID);
});

test("resolveActiveRun: fresh running row blocks (already running)", async () => {
  const now = Date.parse("2026-07-06T12:00:00Z");
  const { calls, execute } = fakeExecutor({
    reconciliation_runs: {
      data: {
        reconciliation_runs: [
          {
            id: RUN_ID,
            status: "running",
            heartbeat_at: new Date(now - 60_000).toISOString(),
          },
        ],
      },
    },
  });
  const reporter = createRunReporter({ execute });

  const resolved = await reporter.resolveActiveRun({ now });

  assert.equal(resolved.run.id, RUN_ID);
  assert.equal(resolved.stale, false);
  // no takeover mutation issued
  assert.equal(calls.length, 1);
});

test("resolveActiveRun: stale running row (>10 min heartbeat) is taken over", async () => {
  const now = Date.parse("2026-07-06T12:00:00Z");
  const { calls, execute } = fakeExecutor({
    reconciliation_runs: {
      data: {
        reconciliation_runs: [
          {
            id: RUN_ID,
            status: "running",
            heartbeat_at: new Date(now - STALE_LEASE_MS - 1000).toISOString(),
          },
        ],
      },
    },
  });
  const reporter = createRunReporter({ execute });

  const resolved = await reporter.resolveActiveRun({ now });

  assert.equal(resolved.stale, true);
  assert.equal(resolved.run.id, RUN_ID);
  const takeover = calls[1];
  assert.ok(takeover, "issues the takeover mutation");
  assert.match(takeover.query, /update_reconciliation_runs_by_pk/);
  assert.equal(takeover.variables.status, "failed");
  assert.equal(takeover.variables.totals.reason, "stale_lease");
});

test("resolveActiveRun: no running row", async () => {
  const { execute } = fakeExecutor({
    reconciliation_runs: { data: { reconciliation_runs: [] } },
  });
  const reporter = createRunReporter({ execute });

  const resolved = await reporter.resolveActiveRun({});
  assert.equal(resolved.run, null);
});

test("finalizeRun sets status, totals and finished_at", async () => {
  const { calls, execute } = fakeExecutor();
  const reporter = createRunReporter({ execute });

  await reporter.finalizeRun(RUN_ID, {
    status: "completed",
    totals: { updated: 3, failed: 1 },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /finished_at/);
  assert.equal(calls[0].variables.status, "completed");
  assert.deepEqual(calls[0].variables.totals, { updated: 3, failed: 1 });
});

test("recordSingleTeamRun creates, appends and finalizes with computed totals", async () => {
  const { calls, execute } = fakeExecutor({
    insert_reconciliation_runs_one: {
      data: { insert_reconciliation_runs_one: { id: RUN_ID, status: "running" } },
    },
  });
  const reporter = createRunReporter({ execute });

  const outcomes = [
    { team_id: TEAM_ID, template: "semantic_events", result: "updated" },
    { team_id: TEAM_ID, template: "order_metrics", result: "skipped_opt_out" },
    { team_id: TEAM_ID, template: "page_metrics", result: "failed", reason: "x" },
  ];
  const result = await reporter.recordSingleTeamRun({
    trigger: "team_created",
    outcomes,
  });

  assert.equal(result.runId, RUN_ID);
  assert.deepEqual(result.outcomes, outcomes);

  const finalize = calls.at(-1);
  assert.match(finalize.query, /finished_at/);
  assert.equal(finalize.variables.status, "completed");
  assert.deepEqual(finalize.variables.totals, {
    updated: 1,
    skipped_opt_out: 1,
    failed: 1,
  });

  const appendCalls = calls.filter((c) => c.query.includes("_append"));
  assert.equal(appendCalls.length, outcomes.length);
});

test("updateCohortState persists cohort_state on the run row", async () => {
  const { calls, execute } = fakeExecutor();
  const reporter = createRunReporter({ execute });

  await reporter.updateCohortState(RUN_ID, {
    current_cohort: 1,
    cohorts_total: 4,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /cohort_state/);
  assert.deepEqual(calls[0].variables.cohortState, {
    current_cohort: 1,
    cohorts_total: 4,
  });
});
