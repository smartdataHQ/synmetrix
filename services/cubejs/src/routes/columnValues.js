/**
 * Column values endpoint — returns distinct values for a table column.
 *
 * Goes through the same checkAuth → driverFactory pipeline as profile-table.
 * Applies partition filtering from securityContext via the same buildWhereClause
 * function the profiler uses — partition and internalTables come from team
 * settings in the database, not hardcoded.
 *
 * Used as a fallback when no Cube.js model exists for value lookups.
 */

import { buildWhereClause } from '../utils/smart-generation/profiler.js';

export default async (req, res, cubejs) => {
  const { securityContext } = req;
  const {
    table,
    schema,
    column,
    search,
    filters: rawFilters,
    limit: rawLimit,
  } = req.body;

  if (!table || !schema || !column) {
    return res.status(400).json({
      code: 'column_values_missing_params',
      message: 'The table, schema, and column parameters are required.',
    });
  }

  const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 500);
  const filters = Array.isArray(rawFilters) ? rawFilters : [];
  let driver;

  try {
    // Same extraction as profile-table — all values from team settings in the database
    const partition = securityContext.userScope?.dataSource?.partition || null;
    const internalTables = securityContext.userScope?.dataSource?.internalTables || [];

    driver = await cubejs.options.driverFactory({ securityContext });

    // Validate column exists via DESCRIBE (prevents injection via column name)
    const describeResult = await driver.query(
      `DESCRIBE TABLE ${schema}.\`${table}\``
    );
    const columnNames = describeResult.map((row) => row.name);

    if (!columnNames.includes(column)) {
      return res.status(400).json({
        code: 'column_values_invalid_column',
        message: `Column "${column}" not found in ${schema}.${table}`,
      });
    }

    // Build WHERE clause through the exact same path the profiler uses.
    // Partition and internalTables come from team settings (database), not hardcoded.
    const whereClause = buildWhereClause(
      schema, table, partition, internalTables, filters, columnNames
    );

    // Compose the full query
    let sql = `SELECT DISTINCT \`${column}\` AS v FROM ${schema}.\`${table}\``;

    if (whereClause) {
      sql += whereClause;
      sql += ` AND \`${column}\` IS NOT NULL`;
    } else {
      sql += ` WHERE \`${column}\` IS NOT NULL`;
    }

    // Server-side partial match via ILIKE
    if (search && typeof search === 'string' && search.trim()) {
      const escaped = search.trim().replace(/'/g, "''");
      sql += ` AND toString(\`${column}\`) ILIKE '%${escaped}%'`;
    }

    sql += ` ORDER BY v ASC LIMIT ${limit}`;

    const rows = await driver.query(sql);
    const values = rows.map((row) => row.v).filter((v) => v != null).map(String);

    res.json({
      code: 'ok',
      column,
      values,
      truncated: values.length >= limit,
    });
  } catch (err) {
    console.error('column-values error:', err);

    if (driver && driver.release) {
      await driver.release();
    }

    res.status(500).json({
      code: 'column_values_error',
      message: err.message || String(err),
    });
  }
};
