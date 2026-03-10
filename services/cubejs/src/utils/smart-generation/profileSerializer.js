/**
 * Profile Serializer — converts profiler's profiledTable to/from plain JSON
 * for transport through GraphQL.
 *
 * The profiledTable uses Map objects for `columns` and `columnDescriptions`,
 * which do not survive JSON serialization. These functions handle the conversion.
 */

/**
 * Serialize a profiledTable and primaryKeys into a plain JSON-safe object.
 *
 * Converts Map fields (`columns`, `columnDescriptions`) to plain objects.
 *
 * @param {object} profiledTable - The profiler output with Map fields
 * @param {string[]} primaryKeys - Detected primary key column names
 * @returns {object} Plain JSON-safe object
 */
export function serializeProfile(profiledTable, primaryKeys) {
  if (!profiledTable) {
    return { profiledTable: null, primaryKeys: primaryKeys || [] };
  }

  const columns = {};
  if (profiledTable.columns instanceof Map) {
    for (const [key, value] of profiledTable.columns) {
      columns[key] = value;
    }
  } else if (profiledTable.columns && typeof profiledTable.columns === 'object') {
    // Already a plain object — pass through
    Object.assign(columns, profiledTable.columns);
  }

  const columnDescriptions = {};
  if (profiledTable.columnDescriptions instanceof Map) {
    for (const [key, value] of profiledTable.columnDescriptions) {
      columnDescriptions[key] = value;
    }
  } else if (profiledTable.columnDescriptions && typeof profiledTable.columnDescriptions === 'object') {
    Object.assign(columnDescriptions, profiledTable.columnDescriptions);
  }

  return {
    profiledTable: {
      database: profiledTable.database,
      table: profiledTable.table,
      row_count: profiledTable.row_count,
      sampled: profiledTable.sampled,
      sample_size: profiledTable.sample_size,
      columns,
      columnDescriptions,
    },
    primaryKeys: primaryKeys || [],
  };
}

/**
 * Deserialize a plain JSON object back into a profiledTable with Map fields.
 *
 * @param {object} serialized - The serialized object from `serializeProfile`
 * @returns {{ profiledTable: object, primaryKeys: string[] }}
 */
export function deserializeProfile(serialized) {
  if (!serialized || !serialized.profiledTable) {
    return { profiledTable: null, primaryKeys: serialized?.primaryKeys || [] };
  }

  const src = serialized.profiledTable;

  const columns = new Map();
  if (src.columns && typeof src.columns === 'object') {
    for (const [key, value] of Object.entries(src.columns)) {
      columns.set(key, value);
    }
  }

  const columnDescriptions = new Map();
  if (src.columnDescriptions && typeof src.columnDescriptions === 'object') {
    for (const [key, value] of Object.entries(src.columnDescriptions)) {
      columnDescriptions.set(key, value);
    }
  }

  return {
    profiledTable: {
      database: src.database,
      table: src.table,
      row_count: src.row_count,
      sampled: src.sampled,
      sample_size: src.sample_size,
      columns,
      columnDescriptions,
    },
    primaryKeys: serialized.primaryKeys || [],
  };
}
