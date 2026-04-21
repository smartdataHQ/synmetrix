import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(
  __dirname,
  "../../../../../tests/workflows/model-management/fixtures"
);

const EXPECTED = new Set([
  "valid-append.yml",
  "dangling-join.yml",
  "circular-extends.yml",
  "measure-to-measure-typo.yml",
  "preagg-reference-break.yml",
  "filter-params-orphan.yml",
]);

const VALID_MODES = new Set(["append", "replace", "preview-delete"]);
const VALID_ERROR_CODES = new Set([
  null,
  "validate_unresolved_reference",
  "delete_blocked_by_references",
]);
const VALID_REFERENCE_KINDS = new Set([
  null,
  "joins",
  "extends",
  "sub_query",
  "formula",
  "segment",
  "pre_aggregation",
  "filter_params",
]);

describe("SC-003 fixture corpus", () => {
  it("discovers all six expected fixtures", async () => {
    const entries = await readdir(FIXTURE_DIR);
    const yaml = entries.filter((n) => n.endsWith(".yml"));
    for (const name of EXPECTED) {
      assert.ok(
        yaml.includes(name),
        `missing fixture: ${name}`
      );
    }
  });

  for (const fixtureName of EXPECTED) {
    it(`${fixtureName} — well-formed shape`, async () => {
      const raw = await readFile(join(FIXTURE_DIR, fixtureName), "utf8");
      const doc = YAML.parse(raw);
      assert.equal(typeof doc.name, "string");
      assert.ok(VALID_MODES.has(doc.mode), `bad mode: ${doc.mode}`);
      assert.ok(Array.isArray(doc.branchSeed));
      assert.ok(doc.branchSeed.length >= 1);
      for (const seed of doc.branchSeed) {
        assert.equal(typeof seed.file, "string");
        assert.equal(typeof seed.code, "string");
      }
      if (doc.mode === "append" || doc.mode === "replace") {
        assert.ok(doc.draft, "draft required for append/replace");
        assert.equal(typeof doc.draft.fileName, "string");
        assert.equal(typeof doc.draft.content, "string");
      }
      if (doc.mode === "replace" || doc.mode === "preview-delete") {
        assert.equal(typeof doc.targetCube, "string");
      }
      assert.ok(doc.expectedOutcome);
      assert.equal(typeof doc.expectedOutcome.valid, "boolean");
      assert.ok(
        VALID_ERROR_CODES.has(doc.expectedOutcome.errorCode),
        `bad errorCode: ${doc.expectedOutcome.errorCode}`
      );
      assert.ok(
        VALID_REFERENCE_KINDS.has(doc.expectedOutcome.referenceKind),
        `bad referenceKind: ${doc.expectedOutcome.referenceKind}`
      );
    });
  }
});
