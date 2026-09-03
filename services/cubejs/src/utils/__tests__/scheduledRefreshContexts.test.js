import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildScheduledRefreshContexts,
  hasUnsafeScheduledRefreshPartitionFilter,
  parseDisabledScheduledRefreshDbTypes,
} from "../scheduledRefreshContexts.js";

const schema = (code) => ({ code });

const dataSource = (id, schemas = []) => ({
  id,
  db_type: "clickhouse",
  db_params: { host: "database.invalid" },
  branches: [{ versions: [{ dataschemas: schemas }] }],
});

describe("scheduled refresh context safety", () => {
  it("normalizes the configured driver quarantine without accepting arbitrary values", () => {
    assert.deepEqual(
      [...parseDisabledScheduledRefreshDbTypes(" BigQuery, POSTGRES, ../bad, ")],
      ["bigquery", "postgres"],
    );
  });

  it("detects a partition FILTER_PARAMS callback in top-level cube SQL", () => {
    assert.equal(
      hasUnsafeScheduledRefreshPartitionFilter(
        schema(`
cubes:
  - name: events
    sql: >-
      SELECT * FROM events
      WHERE partition = {FILTER_PARAMS.events.partition.filter((column) => column)}
`),
      ),
      true,
    );
  });

  it("does not reject FILTER_PARAMS used by a dimension", () => {
    assert.equal(
      hasUnsafeScheduledRefreshPartitionFilter(
        schema(`
cubes:
  - name: events
    sql: SELECT * FROM events
    dimensions:
      - name: selected_value
        sql: "{FILTER_PARAMS.events.partition.filter((value) => value)}"
        type: string
`),
      ),
      false,
    );
  });

  it("does not broaden quarantine to other supported FILTER_PARAMS pushdown", () => {
    assert.equal(
      hasUnsafeScheduledRefreshPartitionFilter(
        schema(`
cubes:
  - name: events
    sql: >-
      SELECT * FROM events
      WHERE {FILTER_PARAMS.events.timestamp.filter((from, to) => from)}
`),
      ),
      false,
    );
  });

  it("quarantines affected datasources and emits only aggregate evidence", () => {
    const warnings = [];
    const sources = [
      dataSource("safe-id", [schema("cubes:\n  - name: safe\n    sql: SELECT 1\n")]),
      dataSource("private-tenant-id", [
        schema(`
cubes:
  - name: unsafe
    sql: "SELECT * FROM t WHERE partition = {FILTER_PARAMS.unsafe.partition.filter((v) => v)}"
`),
      ]),
    ];

    const contexts = buildScheduledRefreshContexts(sources, {
      buildContext: (source) => ({ dataSourceId: source.id }),
      warn: (summary) => warnings.push(summary),
    });

    assert.deepEqual(contexts, [
      {
        securityContext: {
          userScope: { dataSource: { dataSourceId: "safe-id" } },
        },
      },
    ]);
    assert.deepEqual(warnings, [
      {
        reason: "unresolved_partition_filter_in_base_sql",
        excludedDataSources: 1,
        unsafeSchemas: 1,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(warnings), /private-tenant-id/);
  });

  it("preserves all contexts and stays silent when no model is affected", () => {
    const warnings = [];
    const contexts = buildScheduledRefreshContexts(
      [dataSource("one"), dataSource("two")],
      {
        buildContext: (source) => ({ dataSourceId: source.id }),
        warn: (summary) => warnings.push(summary),
      },
    );

    assert.equal(contexts.length, 2);
    assert.deepEqual(warnings, []);
  });

  it("quarantines only explicitly configured drivers and logs aggregates", () => {
    const warnings = [];
    const bigquery = {
      ...dataSource("private-bigquery-id"),
      db_type: "BigQuery",
    };
    const clickhouse = dataSource("clickhouse-id");

    const contexts = buildScheduledRefreshContexts([bigquery, clickhouse], {
      disabledDbTypes: new Set(["bigquery"]),
      buildContext: (source) => ({ dataSourceId: source.id }),
      warn: (summary) => warnings.push(summary),
    });

    assert.deepEqual(contexts, [
      {
        securityContext: {
          userScope: { dataSource: { dataSourceId: "clickhouse-id" } },
        },
      },
    ]);
    assert.deepEqual(warnings, [
      {
        reason: "scheduled_refresh_driver_disabled",
        excludedDataSources: 1,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(warnings), /private-bigquery-id/);
  });
});
