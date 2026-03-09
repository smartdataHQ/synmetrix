/**
 * Primary key detector for ClickHouse tables with support for composite keys.
 * Queries system.tables metadata, falls back to sorting key if no primary key.
 */

const NON_NULL_THRESHOLD = 0.1;

/**
 * Detect primary key columns for a ClickHouse table.
 * Falls back to sorting key if no explicit primary key is defined.
 *
 * @param {object} driver - CubeJS database driver with query(sql) method
 * @param {string} database - Database name
 * @param {string} tableName - Table name
 * @returns {Promise<string[]>} Array of primary key column names
 */
export async function detectPrimaryKeys(driver, database, tableName) {
  try {
    const sql = `SELECT primary_key, sorting_key FROM system.tables WHERE database = '${database}' AND name = '${tableName}'`;
    const rows = await driver.query(sql);

    if (!rows || rows.length === 0) {
      return [];
    }

    const { primary_key, sorting_key } = rows[0];

    const primaryCols = parseKeyString(primary_key);
    if (primaryCols.length > 0) {
      return filterKeysWithData(driver, database, tableName, primaryCols);
    }

    const sortingCols = parseKeyString(sorting_key);
    if (sortingCols.length > 0) {
      return filterKeysWithData(driver, database, tableName, sortingCols);
    }

    return [];
  } catch (err) {
    console.error(`Error detecting primary keys for ${database}.${tableName}:`, err.message);
    return [];
  }
}

/**
 * Filter candidate key columns to only those with sufficient non-null data (>10%).
 *
 * @param {object} driver - CubeJS database driver with query(sql) method
 * @param {string} database - Database name
 * @param {string} tableName - Table name
 * @param {string[]} candidateKeys - Candidate key column names
 * @returns {Promise<string[]>} Filtered array of valid key columns
 */
export async function filterKeysWithData(driver, database, tableName, candidateKeys) {
  if (!candidateKeys || candidateKeys.length === 0) {
    return [];
  }

  try {
    const validKeys = [];

    for (const keyColumn of candidateKeys) {
      const sql = `SELECT count() as total_rows, count(${keyColumn}) as non_null_rows FROM ${database}.${tableName}`;
      const rows = await driver.query(sql);

      if (rows && rows.length > 0) {
        const totalRows = Number(rows[0].total_rows);
        const nonNullRows = Number(rows[0].non_null_rows);

        if (nonNullRows > 0 && nonNullRows / Math.max(totalRows, 1) > NON_NULL_THRESHOLD) {
          validKeys.push(keyColumn);
        }
      }
    }

    return validKeys;
  } catch (err) {
    console.error(`Error filtering primary keys for ${database}.${tableName}:`, err.message);
    return candidateKeys;
  }
}

function parseKeyString(keyStr) {
  if (!keyStr || !keyStr.trim()) return [];
  return keyStr.split(',').map((col) => col.trim()).filter(Boolean);
}
