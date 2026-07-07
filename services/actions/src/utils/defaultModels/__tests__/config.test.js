import { test } from "node:test";
import assert from "node:assert/strict";

import { loadDefaultModelsConfig } from "../config.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const requiredEnv = () => ({
  DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID: UUID_A,
  DEFAULT_MODELS_SYSTEM_USER_ID: UUID_B,
  DEFAULT_MODELS_TARGET_DATASOURCE_NAME: "Semantic Events",
});

test("throws when required keys are missing, naming every missing key", () => {
  assert.throws(
    () => loadDefaultModelsConfig({}),
    (err) => {
      assert.match(err.message, /DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID/);
      assert.match(err.message, /DEFAULT_MODELS_SYSTEM_USER_ID/);
      assert.match(err.message, /DEFAULT_MODELS_TARGET_DATASOURCE_NAME/);
      return true;
    }
  );
});

test("throws when a required id is not a UUID", () => {
  assert.throws(() =>
    loadDefaultModelsConfig({
      ...requiredEnv(),
      DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID: "not-a-uuid",
    })
  );
  assert.throws(() =>
    loadDefaultModelsConfig({
      ...requiredEnv(),
      DEFAULT_MODELS_SYSTEM_USER_ID: "also-not-a-uuid",
    })
  );
});

test("applies defaults for the optional keys", () => {
  const config = loadDefaultModelsConfig(requiredEnv());

  assert.equal(config.templateDatasourceId, UUID_A);
  assert.equal(config.systemUserId, UUID_B);
  assert.equal(config.targetDatasourceName, "Semantic Events");
  assert.equal(config.haltThreshold, 0.2);
  assert.equal(config.cohorts, 4);
  assert.deepEqual(config.canaryTeamIds, []);
  // empty drift probes = treat all teams as changed
  assert.deepEqual(config.driftProbes, []);
});

test("parses optional keys into typed values", () => {
  const config = loadDefaultModelsConfig({
    ...requiredEnv(),
    DEFAULT_MODELS_CANARY_TEAM_IDS: ` ${UUID_A} , ${UUID_B} `,
    DEFAULT_MODELS_HALT_THRESHOLD: "0.35",
    DEFAULT_MODELS_COHORTS: "6",
    DEFAULT_MODELS_DRIFT_PROBES:
      '[{"table":"cst.semantic_events","timeColumn":"timestamp"}]',
  });

  assert.deepEqual(config.canaryTeamIds, [UUID_A, UUID_B]);
  assert.equal(config.haltThreshold, 0.35);
  assert.equal(config.cohorts, 6);
  assert.deepEqual(config.driftProbes, [
    { table: "cst.semantic_events", timeColumn: "timestamp" },
  ]);
});

test("rejects malformed DEFAULT_MODELS_DRIFT_PROBES", () => {
  assert.throws(() =>
    loadDefaultModelsConfig({
      ...requiredEnv(),
      DEFAULT_MODELS_DRIFT_PROBES: "not json",
    })
  );
  assert.throws(() =>
    loadDefaultModelsConfig({
      ...requiredEnv(),
      DEFAULT_MODELS_DRIFT_PROBES: '{"table":"t"}',
    })
  );
  assert.throws(() =>
    loadDefaultModelsConfig({
      ...requiredEnv(),
      DEFAULT_MODELS_DRIFT_PROBES: '[{"table":"cst.semantic_events"}]',
    })
  );
});

test("rejects out-of-range numeric keys", () => {
  assert.throws(() =>
    loadDefaultModelsConfig({
      ...requiredEnv(),
      DEFAULT_MODELS_HALT_THRESHOLD: "abc",
    })
  );
  assert.throws(() =>
    loadDefaultModelsConfig({
      ...requiredEnv(),
      DEFAULT_MODELS_HALT_THRESHOLD: "1.5",
    })
  );
  assert.throws(() =>
    loadDefaultModelsConfig({
      ...requiredEnv(),
      DEFAULT_MODELS_COHORTS: "0",
    })
  );
});

test("exposes the cron secret when present", () => {
  const config = loadDefaultModelsConfig({
    ...requiredEnv(),
    ACTIONS_CRON_SECRET: "s3cret",
  });
  assert.equal(config.cronSecret, "s3cret");

  const without = loadDefaultModelsConfig(requiredEnv());
  assert.equal(without.cronSecret, null);
});
