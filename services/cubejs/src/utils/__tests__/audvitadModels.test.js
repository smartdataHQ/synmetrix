import assert from "node:assert/strict";
import { describe, it } from "node:test";
import YAML from "yaml";
import { prepareCompiler } from "@cubejs-backend/schema-compiler";

import {
  AUDVITAD_CORE_CUBE_NAMES,
  AUDVITAD_PREMIUM_CUBE_NAMES,
  getAudvitadCubeDefinitions,
  getAudvitadSchemaFiles,
  getAudvitadSchemaVersion,
} from "../audvitadModels.js";
import repositoryFactory from "../repositoryFactory.js";

describe("audvitadModels", () => {
  it("excludes all Trading Economics premium cubes on Fag (pro) and includes them on Enterprise", () => {
    const proFiles = getAudvitadSchemaFiles({ premium: false });
    const entFiles = getAudvitadSchemaFiles({ premium: true });

    assert.equal(proFiles.length, AUDVITAD_CORE_CUBE_NAMES.length);
    assert.equal(
      entFiles.length,
      AUDVITAD_CORE_CUBE_NAMES.length + AUDVITAD_PREMIUM_CUBE_NAMES.length,
    );

    const proNames = new Set(proFiles.map((f) => YAML.parse(f.content).cubes[0].name));
    const entNames = new Set(entFiles.map((f) => YAML.parse(f.content).cubes[0].name));

    for (const premiumName of AUDVITAD_PREMIUM_CUBE_NAMES) {
      assert.equal(proNames.has(premiumName), false, `Fag schema must omit ${premiumName}`);
      assert.equal(entNames.has(premiumName), true, `Enterprise schema must include ${premiumName}`);
    }
    assert.notEqual(
      getAudvitadSchemaVersion({ premium: false }),
      getAudvitadSchemaVersion({ premium: true }),
    );
  });

  it("enforces strict public/open partition predicates on every curated cube", () => {
    for (const cube of getAudvitadCubeDefinitions({ premium: true })) {
      assert.ok(cube.sql, `cube ${cube.name} must define sql`);
      assert.doesNotMatch(cube.sql, /blue\.is/i);
      if (cube.sql.includes("cst.data_points")) {
        assert.match(cube.sql, /partition\s*=\s*'_open_'/);
        assert.match(cube.sql, /access_type\s*=\s*'Public'/);
      }
      if (cube.sql.includes("ql.calendar_events")) {
        assert.match(cube.sql, /is_deleted\s*=\s*0/);
        assert.match(cube.sql, /access\s*=\s*'Public'/);
      }
      if (cube.name.startsWith("traffic_")) {
        assert.match(cube.sql, /dimensions\['traffic_station_id'\].*AS row_id/s);
        assert.match(cube.sql, /dimensions\['traffic_direction_role'\].*AS row_id/s);
        const dimNames = new Set(cube.dimensions.map((d) => d.name));
        assert.ok(dimNames.has("postal_code"), `${cube.name} must expose postal_code`);
        assert.ok(dimNames.has("road_type"), `${cube.name} must expose road_type`);
      }
    }
  });

  it("compiles both Fag and Enterprise schemas cleanly through @cubejs-backend/schema-compiler", async () => {
    for (const premium of [false, true]) {
      const files = getAudvitadSchemaFiles({ premium });
      const { compiler, cubeEvaluator } = prepareCompiler({
        dataSchemaFiles: async () => files,
      });
      await compiler.compile();
      const compiledNames = Object.keys(cubeEvaluator.evaluatedCubes);
      const expected = premium
        ? [...AUDVITAD_CORE_CUBE_NAMES, ...AUDVITAD_PREMIUM_CUBE_NAMES]
        : [...AUDVITAD_CORE_CUBE_NAMES];
      assert.deepEqual(compiledNames.sort(), expected.sort());
    }
  });

  it("serves in-memory schemas via repositoryFactory without touching Hasura", async () => {
    const repo = repositoryFactory({
      securityContext: {
        audvitadSql: { organizationId: "org_1", keyId: "key_1", premium: false },
      },
    });
    const files = await repo.dataSchemaFiles();
    assert.equal(files.length, AUDVITAD_CORE_CUBE_NAMES.length);
    assert.ok(files.every((f) => f.fileName.startsWith("audvitad/") && f.readOnly === true));
  });
});
