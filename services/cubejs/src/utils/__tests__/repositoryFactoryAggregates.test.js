import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const CANONICAL = [{ id: "f1", name: "line_items.yml", code: "cubes:\n  - name: line_items\n    sql_table: cst.sales_lines\n" }];
let loads = 0;
mock.module("../dataSourceHelpers.js", {
  namedExports: {
    findDataSchemasByIds: async () => {
      loads += 1;
      return CANONICAL;
    },
  },
});
const { default: repositoryFactory } = await import("../repositoryFactory.js");
const { rememberVariant } = await import("../aggregates/routing.js");

const DERIVED = [{ fileName: "line_items__aggregate.yml", content: "cubes:\n  - name: line_items\n    sql_table: cst.sales_lines__agg_1day\n" }];
const context = (aggregateVariant) => ({
  userScope: { dataSource: { files: ["f1"], fileChecksums: { f1: "c1" }, ...(aggregateVariant ? { aggregateVariant } : {}) } },
});
const files = (securityContext) => repositoryFactory({ securityContext }).dataSchemaFiles();

describe("repositoryFactory with aggregate variants", () => {
  it("serves the derived files to a context that carries a known variant", async () => {
    rememberVariant("known", { files: DERIVED });
    loads = 0;
    assert.deepEqual(await files(context("known")), DERIVED);
    assert.equal(loads, 0);
  });

  it("serves the canonical files when the variant is no longer known, so the query still runs on the source", async () => {
    const served = await files(context("evicted"));
    assert.deepEqual(served.map((file) => [file.fileName, file.content]), [["line_items.yml", CANONICAL[0].code]]);
  });

  it("serves the canonical files to an unmarked context, as before", async () => {
    rememberVariant("known", { files: DERIVED });
    const served = await files(context());
    assert.deepEqual(served.map((file) => file.fileName), ["line_items.yml"]);
  });
});
