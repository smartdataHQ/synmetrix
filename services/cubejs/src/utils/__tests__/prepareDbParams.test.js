import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import prepareDbParams from "../prepareDbParams.js";

const require = createRequire(import.meta.url);

describe("prepareDbParams", () => {
  it("makes BigQuery drivers read-only, so rollups never write to the customer's project", () => {
    const { BigQueryDriver } = require("@cubejs-backend/bigquery-driver");
    const params = prepareDbParams(
      { projectId: "abler-web", keyFile: JSON.stringify({ client_email: "sa@abler-web.iam" }) },
      "bigquery",
    );

    assert.equal(new BigQueryDriver(params).readOnly(), true);
  });
});
