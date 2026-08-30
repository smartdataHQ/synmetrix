import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkLiveSchemaCompatibility } from "../utils/liveSchemaCompatibility.js";

const source = (name, code = "secret tenant model") => ({ name, code });
const context = (...dataschemas) => ({
  id: "secret-datasource-id",
  branches: [{ versions: [{ dataschemas }] }],
});

describe("privacy-preserving live schema compatibility gate", () => {
  it("compiles every active context and reports only aggregate counts", async () => {
    const seen = [];
    const summary = await checkLiveSchemaCompatibility(
      [context(source("one.yml")), context(source("two.js"))],
      {
        compile: async (files) => seen.push(files),
      },
    );

    assert.equal(seen.length, 2);
    assert.deepEqual(summary, {
      compatible: true,
      contexts: 2,
      files: 2,
      yamlFiles: 1,
      javascriptFiles: 1,
      compiledContexts: 2,
      failedContexts: 0,
    });
    assert.doesNotMatch(JSON.stringify(summary), /secret|one|two|datasource/);
  });

  it("counts failures without retaining compiler errors or tenant values", async () => {
    const summary = await checkLiveSchemaCompatibility(
      [context(source("private.yml", "private model contents"))],
      {
        compile: async () => {
          throw new Error("private compiler error and schema contents");
        },
      },
    );

    assert.equal(summary.compatible, false);
    assert.equal(summary.failedContexts, 1);
    assert.equal(summary.compiledContexts, 0);
    assert.doesNotMatch(JSON.stringify(summary), /private|compiler error/);
  });
});
