import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareCompiler } from "@cubejs-backend/schema-compiler";

import { preAggregationWarnings } from "../preAggregationWarnings.js";

const MODEL = `cubes:
  - name: orders
    sql_table: public.orders
    measures:
      - name: count
        type: count
    dimensions:
      - name: created_at
        sql: created_at
        type: time
    pre_aggregations:
      - name: not_incremental
        measures: [count]
        time_dimension: created_at
        granularity: day
        partition_granularity: month
        refresh_key:
          every: 30 minutes
          update_window: 14 day
      - name: incremental
        measures: [count]
        time_dimension: created_at
        granularity: day
        partition_granularity: month
        refresh_key:
          every: 1 hour
          incremental: true
          update_window: 7 day
      - name: no_window
        measures: [count]
        refresh_key:
          every: 1 hour
`;

async function compile(content) {
  const files = [{ fileName: "orders.yml", content }];
  const { compiler, cubeEvaluator } = prepareCompiler(
    { localPath: () => "/", dataSchemaFiles: async () => files },
    { allowNodeRequire: false, standalone: true }
  );
  await compiler.compile();
  return { cubeEvaluator, files };
}

describe("preAggregationWarnings", () => {
  it("warns only on update_window without incremental, at its line", async () => {
    const { cubeEvaluator, files } = await compile(MODEL);
    const warnings = preAggregationWarnings(cubeEvaluator, files);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, "warning");
    assert.equal(warnings[0].fileName, "orders.yml");
    assert.equal(warnings[0].startLine, 19);
    assert.match(warnings[0].message, /orders\.not_incremental/);
    assert.match(warnings[0].message, /incremental: true/);
  });

  it("is silent once incremental is set", async () => {
    const fixed = MODEL.replace(
      "every: 30 minutes\n",
      "every: 30 minutes\n          incremental: true\n"
    );
    const { cubeEvaluator, files } = await compile(fixed);
    assert.deepEqual(preAggregationWarnings(cubeEvaluator, files), []);
  });
});
