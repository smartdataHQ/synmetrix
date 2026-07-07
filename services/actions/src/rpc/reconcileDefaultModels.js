// Fleet default-models reconcile orchestrator (013, contracts/actions-rpc.md).
// Cron entry (every 15 min) + platform-admin manual runs. Staged canary-first
// cohorts with a halt threshold (FR-010) and template-publish detection (D6);
// drift-based skip arrives with US3.

// apiError is imported at call time (its logger dependency chain must not
// load during unit tests)
import { loadDefaultModelsConfig } from "../utils/defaultModels/config.js";
import createRunReporter, {
  computeTotals,
} from "../utils/defaultModels/runReporter.js";
import {
  authorizeDefaultModelsRpc,
  ensureSystemUser as ensureSystemUserImpl,
  fetchPublishedTemplates,
  listAllTeams,
  reconcileOneTeam as reconcileOneTeamImpl,
} from "../utils/defaultModels/shared.js";
import { buildCohorts, shouldHalt } from "../utils/defaultModels/cohorts.js";
import {
  captureDriftSnapshot,
  diffDriftSnapshots,
} from "../utils/defaultModels/drift.js";

const TEAM_CONCURRENCY = 4;

// The halt (FR-010) exists to stop a BAD TEMPLATE before it reaches more
// teams. The only failure class a rollout can cause is a validation
// rejection of a fresh candidate (the worker prefixes those `validation:`).
// Everything else — config gaps (no_partition), connectivity/credential
// faults, probe timeouts, pre-broken branches — is per-team environment,
// writes nothing, and would otherwise permanently halt small fleets. Those
// are recorded and reported per team (FR-017) but never counted here.
const isRolloutFailure = (outcome) =>
  outcome.result === "failed" &&
  String(outcome.reason || "").startsWith("validation:");

export default async (session, input, headers, deps = {}) => {
  const {
    loadConfig = loadDefaultModelsConfig,
    reporter = createRunReporter(),
    ensureSystemUser = ensureSystemUserImpl,
    fetchTemplates = fetchPublishedTemplates,
    listTeams = listAllTeams,
    reconcileOneTeam = reconcileOneTeamImpl,
    captureDrift = captureDriftSnapshot,
    isAdmin,
  } = deps;

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return {
      error: true,
      status: 503,
      code: "default_models_unconfigured",
      message: err.message,
    };
  }

  // Auth gate FIRST — the /rpc dispatcher is unauthenticated.
  const denied = await authorizeDefaultModelsRpc(session, headers, config, isAdmin);
  if (denied) {
    return denied;
  }

  const { trigger = "schedule", dryRun = false, cohortLimit = null } = input || {};

  try {
    // Concurrency guard: one fleet run at a time; stale leases (heartbeat
    // older than 10 min) are taken over. 200-not-error so overlapping cron
    // ticks don't register as webhook failures.
    const active = await reporter.resolveActiveRun({});
    if (active.run && !active.stale) {
      return { status: "already_running", runId: active.run.id };
    }

    await ensureSystemUser(config);

    const { templateChecksum, templates } = await fetchTemplates(config);
    if (templates.length === 0) {
      return { runId: null, status: "noop", templateChecksum, totals: {} };
    }

    const teams = await listTeams();

    // Template-publish detection (D6): a schedule tick where the template
    // branch's checksum moved since the last completed run is a rollout.
    let effectiveTrigger = trigger;
    const lastCompleted = await reporter.getLatestCompletedRun();
    if (
      trigger === "schedule" &&
      lastCompleted?.template_checksum &&
      lastCompleted.template_checksum !== templateChecksum
    ) {
      effectiveTrigger = "template_publish";
    }

    // Data-drift detection (D7, US3): one fleet-wide probe per configured
    // table. Snapshot is captured on EVERY fleet run (so the next diff always
    // has a baseline); the changed-teams FILTER applies only to plain
    // schedule ticks — template publishes and manual runs cover all teams.
    let driftSnapshot = null;
    try {
      driftSnapshot = await captureDrift(config);
    } catch (err) {
      driftSnapshot = null; // probe failure ⇒ treat all teams as changed
    }
    let changedPartitions = null; // null = every team
    if (effectiveTrigger === "schedule" && driftSnapshot) {
      changedPartitions = diffDriftSnapshots(
        lastCompleted?.drift_snapshot,
        driftSnapshot
      );
    }

    let run = null;
    if (!dryRun) {
      run = await reporter.startRun({
        trigger: effectiveTrigger,
        templateChecksum,
        driftSnapshot,
      });
    }

    const outcomes = [];
    const record = async (outcome) => {
      outcomes.push(outcome);
      if (run) {
        await reporter.appendOutcome(run.id, outcome);
      }
    };

    // Staged canary-first execution (FR-010, D8). Within a cohort, per-team
    // isolation holds (FR-018): a thrown worker call becomes a failed outcome
    // for that team only; the queue keeps draining. Between cohorts the halt
    // threshold applies.
    const cohorts = buildCohorts(teams, config);
    const canaryTeamIds = cohorts[0].teams.map((t) => t.id);

    let halted = false;
    let processedCohorts = 0;

    for (let i = 0; i < cohorts.length; i += 1) {
      const cohort = cohorts[i];
      if (cohort.teams.length === 0) continue;
      if (cohortLimit != null && processedCohorts >= cohortLimit) break;

      const cohortOutcomes = [];
      const queue = [...cohort.teams];
      const drain = async () => {
        for (;;) {
          const team = queue.shift();
          if (!team) return;
          // unchanged team on a schedule tick: skip before any per-team probe
          if (
            changedPartitions !== null &&
            !changedPartitions.has(team.settings?.partition)
          ) {
            await record({
              team_id: team.id,
              result: "skipped_no_change",
              reason: "no_drift",
            });
            continue;
          }
          try {
            const teamOutcomes = await reconcileOneTeam(team, templates, config, {
              dryRun,
            });
            for (const outcome of teamOutcomes) {
              const row = { team_id: team.id, ...outcome };
              cohortOutcomes.push(row);
              await record(row);
            }
          } catch (err) {
            const row = {
              team_id: team.id,
              result: "failed",
              reason: err?.message || String(err),
            };
            cohortOutcomes.push(row);
            await record(row);
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(TEAM_CONCURRENCY, cohort.teams.length) },
          drain
        )
      );
      processedCohorts += 1;

      const failedTeams = new Set(
        cohortOutcomes.filter(isRolloutFailure).map((o) => o.team_id)
      ).size;
      const failureRate =
        cohort.teams.length > 0 ? failedTeams / cohort.teams.length : 0;

      if (run) {
        await reporter.updateCohortState(run.id, {
          current_cohort: i,
          cohort_name: cohort.name,
          cohorts_total: cohorts.length,
          canary_team_ids: canaryTeamIds,
          halt_threshold: config.haltThreshold,
          failure_rate: failureRate,
        });
      }

      if (
        shouldHalt({
          failures: failedTeams,
          total: cohort.teams.length,
          threshold: config.haltThreshold,
        })
      ) {
        halted = true;
        break;
      }
    }

    const totals = computeTotals(outcomes);
    const status = halted ? "halted" : "completed";
    if (run) {
      await reporter.finalizeRun(run.id, { status, totals });
    }

    const result = {
      runId: run?.id || null,
      status,
      templateChecksum,
      totals,
    };
    if (dryRun) {
      result.dryRun = true;
      result.outcomes = outcomes;
    }
    return result;
  } catch (err) {
    const { default: apiError } = await import("../utils/apiError.js");
    return apiError(err);
  }
};
