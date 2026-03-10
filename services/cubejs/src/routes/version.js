import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pkg = require("@cubejs-backend/schema-compiler/package.json");
const SCHEMA_COMPILER_VERSION = pkg.version;

export default (req, res) => {
  res.json({ version: SCHEMA_COMPILER_VERSION });
};
