import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { prepareCompiler } from "@cubejs-backend/schema-compiler";

import { escapeCSVField } from "../utils/csvSerializer.js";
import { validateFormat } from "../utils/formatValidator.js";
import {
  patchClickHouseQuerySource,
  patchCompilerSource,
} from "../../scripts/patchCubeYamlCompiler.mjs";

const require = createRequire(import.meta.url);
const runtimeVersion = require("@cubejs-backend/server-core/package.json").version;

// T060 runs the complete test tree twice, once with each dependency set. This
// manifest makes the required comparison surfaces explicit and prevents a
// future refactor from silently dropping a lane from that corpus.
const CORPUS = {
  models: [
    "../utils/smart-generation/__tests__/cubeBuilder.test.js",
    "../routes/__tests__/reconcileTeam.test.js",
  ],
  formats: [
    "../utils/formatValidator.js",
    "../utils/csvSerializer.js",
    "../utils/arrowSerializer.js",
  ],
  auth: ["../utils/__tests__/workosAuth.test.js"],
  pre_aggregations: ["../routes/__tests__/validateInBranch.corpus.test.js"],
};

describe("Cube 1.6.68 to 1.7.30 comparative corpus", () => {
  it("runs only an explicitly supported Cube runtime", () => {
    assert.ok(
      ["1.6.68", "1.7.30"].includes(runtimeVersion),
      `unsupported Cube runtime in comparative corpus: ${runtimeVersion}`,
    );
    if (process.env.CUBE_RUNTIME_EXPECTED_VERSION) {
      assert.equal(runtimeVersion, process.env.CUBE_RUNTIME_EXPECTED_VERSION);
    }
  });

  for (const [surface, paths] of Object.entries(CORPUS)) {
    it(`${surface} lane remains present`, async () => {
      for (const path of paths) await access(new URL(path, import.meta.url));
    });
  }

  it("keeps format behavior stable", () => {
    assert.equal(validateFormat(), "json");
    assert.equal(validateFormat("csv"), "csv");
    assert.equal(validateFormat("arrow"), "arrow");
    assert.equal(escapeCSVField('Iceland, "weather"'), '"Iceland, ""weather"""');
    assert.throws(() => validateFormat("parquet"), /Unsupported format/);
  });

  it("preserves JSON-valued metadata as a literal string", async () => {
    const value = JSON.stringify({
      time_zone: "Atlantic/Reykjavik",
      preferred_source: "sensor",
      language: "is",
    });
    const content = `cubes:
  - name: support_ticket_analysed
    sql_table: support_ticket_analysed
    meta:
      lc_values:
        - '${value}'
    dimensions:
      - name: id
        sql: id
        type: string
        primary_key: true
`;
    const repository = {
      dataSchemaFiles: async () => [
        { fileName: "support_ticket_analysed.yml", content },
      ],
    };
    const { compiler, metaTransformer } = prepareCompiler(repository, {});

    await compiler.compile();

    assert.equal(metaTransformer.cubes[0].config.meta.lc_values[0], value);
  });

  it("guards the compiler patch against upstream source drift", () => {
    const source = `before
        else if (typeof obj === 'string') {
            let code = obj;
            if (!CubeValidator_1.nonStringFields.has(propertyPath[propertyPath.length - 1])) {
after`;
    const first = patchCompilerSource(source);
    assert.equal(first.changed, true);
    assert.match(first.source, /propertyPath\.includes\('meta'\)/);
    assert.deepEqual(patchCompilerSource(first.source), {
      source: first.source,
      changed: false,
    });
    assert.throws(
      () => patchCompilerSource("unexpected compiler source"),
      /expected source anchor was not found exactly once/,
    );
  });

  it("guards the ClickHouse string-type patch against upstream source drift", () => {
    const source = `before
        templates.types.timestamp = 'DATETIME';
        delete templates.types.time;
after`;
    const first = patchClickHouseQuerySource(source);
    assert.equal(first.changed, true);
    assert.match(first.source, /templates\.types\.string = 'String';/);
    assert.deepEqual(patchClickHouseQuerySource(first.source), {
      source: first.source,
      changed: false,
    });
    assert.throws(
      () => patchClickHouseQuerySource("unexpected adapter source"),
      /expected source anchor was not found exactly once/,
    );
  });

  it("casts composite-key count measures to ClickHouse String (Tesseract)", async () => {
    const { ClickHouseQuery } = require(
      "@cubejs-backend/schema-compiler/dist/src/adapter/ClickHouseQuery.js",
    );
    const content = `cubes:
  - name: points
    sql_table: points
    dimensions:
      - name: series_gid
        sql: series_gid
        type: string
        primary_key: true
      - name: ts
        sql: ts
        type: time
        primary_key: true
    measures:
      - name: count
        type: count
`;
    const compilers = prepareCompiler(
      { dataSchemaFiles: async () => [{ fileName: "points.yml", content }] },
      { adapter: "clickhouse" },
    );
    await compilers.compiler.compile();
    const [sql] = new ClickHouseQuery(compilers, {
      measures: ["points.count"],
      timezone: "UTC",
      useNativeSqlPlanner: true,
    }).buildSqlAndParams();

    assert.match(sql, / AS String\)/);
    assert.doesNotMatch(sql, / AS STRING\)/);
  });

  it("does not embed a comparison result in the test source", async () => {
    const source = await readFile(new URL(import.meta.url), "utf8");
    assert.doesNotMatch(source, /pass(?:ed)?\s*[:=]\s*(?:true|yes)/i);
  });
});
