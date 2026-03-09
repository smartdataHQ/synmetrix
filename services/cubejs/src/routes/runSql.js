import { loadRules } from "../utils/queryRewrite.js";

/**
 * Asynchronous function to run a SQL query using Cube.js.
 * Blocks access for teams with active query rewrite rules (prevents queryRewrite bypass).
 */
export default async (req, res, cubejs) => {
  const { securityContext } = req;

  if (!req.body.query) {
    res.status(400).json({
      code: "query_missing",
      message: "The query parameter is missing.",
    });

    return;
  }

  try {
    // Check if the user's team has active query rewrite rules
    const rules = await loadRules();
    if (rules.length > 0) {
      res.status(403).json({
        code: "sql_api_blocked",
        message:
          "SQL API access is not available for teams with active access control rules. Use the Cube.js API instead.",
      });
      return;
    }

    const driver = await cubejs.options.driverFactory({ securityContext });
    const rows = await driver.query(req.body.query);
    res.json(rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      code: "run_sql_failed",
      message: err.message || err,
    });
  }
};
