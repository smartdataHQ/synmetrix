import { createRequire } from "node:module";

import { getDataSources } from "../src/utils/dataSourceHelpers.js";
import { checkLiveSchemaCompatibility } from "../src/utils/liveSchemaCompatibility.js";

const require = createRequire(import.meta.url);
const compilerVersion = require(
  "@cubejs-backend/schema-compiler/package.json",
).version;

const dataSources = await getDataSources();
const summary = await checkLiveSchemaCompatibility(dataSources);

// This is the complete output contract. Never add tenant, datasource, schema,
// model, query, or compiler-error values to this release-gate record.
console.log(JSON.stringify({ compilerVersion, ...summary }));
if (!summary.compatible) process.exitCode = 1;
