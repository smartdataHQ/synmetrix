/**
 * Load ALIAS column names from ClickHouse system.columns so generated cube
 * `sql` can list them explicitly after SELECT *.
 *
 * Only `default_kind = 'ALIAS'` columns are included (not MATERIALIZED/DEFAULT).
 *
 * @param {object} driver - ClickHouse driver with .query(sql)
 * @param {string} database
 * @param {string} table
 * @returns {Promise<string[]>}
 */
function rowColumnName(row) {
  if (!row || typeof row !== 'object') return null;
  return row.name ?? row.Name ?? row.column_name ?? null;
}

export async function fetchClickHouseAliasColumnNames(driver, database, table) {
  if (!driver?.query || !database || !table) return [];
  const db = String(database).replace(/'/g, "''");
  const tbl = String(table).replace(/'/g, "''");
  try {
    const rows = await driver.query(
      `SELECT name FROM system.columns `
      + `WHERE database = '${db}' AND table = '${tbl}' `
      + `AND default_kind = 'ALIAS' `
      + `ORDER BY position`
    );
    const list = Array.isArray(rows) ? rows : [];
    const names = list
      .map((r) => rowColumnName(r))
      .filter((n) => typeof n === 'string' && n.length > 0);
    return [...new Set(names)];
  } catch (err) {
    console.warn(`[smartGenerate] ALIAS column lookup failed (non-fatal): ${err.message}`);
    return [];
  }
}
