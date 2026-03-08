/**
 * Cube builder module — converts a ProfiledTable into Cube.js cube
 * definition objects (dimensions, measures, metadata).
 *
 * Ported from Python prototype: cxs-inbox/cube/utils/cube_builder.py
 */

import { processColumn, sanitizeFieldName } from './fieldProcessors.js';
import { ColumnType } from './typeParser.js';

// -- Helpers ----------------------------------------------------------------

/**
 * Sanitize a table name into a valid Cube.js cube identifier.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeCubeName(name) {
  let sanitized = name.replace(/[^a-zA-Z0-9]/g, '_');
  if (/^\d/.test(sanitized)) {
    sanitized = `cube_${sanitized}`;
  }
  sanitized = sanitized.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'cube';
}

/**
 * Resolve field name collisions within a list of fields.
 * If two fields share the same name, the second is prefixed with its
 * source column name.
 *
 * @param {object[]} fields - Array of { name, sql, type, fieldType, _sourceColumn? }
 * @returns {object[]} De-duplicated fields
 */
function deduplicateFields(fields) {
  const seen = new Map(); // name -> index of first occurrence

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (seen.has(field.name)) {
      // Rename the colliding field by prefixing with source column
      const sourceCol = field._sourceColumn || '';
      const prefix = sanitizeFieldName(sourceCol);
      if (prefix && prefix !== field.name) {
        field.name = `${prefix}_${field.name}`;
      } else {
        field.name = `${field.name}_${i}`;
      }
      // Check again after rename
      if (seen.has(field.name)) {
        field.name = `${field.name}_${i}`;
      }
    }
    seen.set(field.name, i);
  }

  return fields;
}

// -- Core builder -----------------------------------------------------------

/**
 * Build the SQL expression for the cube source.
 *
 * @param {string} schema - Database/schema name
 * @param {string} table - Table name
 * @param {string|null} partition - Partition value
 * @param {boolean} isInternal - Whether the table is in internalTables
 * @returns {{ sql_table?: string, sql?: string }}
 */
function buildCubeSource(schema, table, partition, isInternal) {
  if (isInternal && partition) {
    return {
      sql: `SELECT * FROM ${schema}.${table} WHERE partition = '${partition}'`,
    };
  }
  return { sql_table: `${schema}.${table}` };
}

/**
 * Process all columns from a profiled table into cube fields.
 *
 * @param {Map} columns - Map of column name -> { details, profile }
 * @param {object} options
 * @param {Array<{column: string, alias: string}>} options.arrayJoinColumns
 * @param {number} options.maxMapKeys
 * @param {string[]} options.primaryKeys
 * @returns {{ dimensions: object[], measures: object[], mapKeysDiscovered: number, columnsProfiled: number, columnsSkipped: number }}
 */
function processColumns(columns, options) {
  const { arrayJoinColumns = [], maxMapKeys = 500, primaryKeys = [] } = options;
  const arrayJoinColumnNames = arrayJoinColumns.map((a) => a.column);

  const allFields = [];
  let mapKeysDiscovered = 0;
  let columnsProfiled = 0;
  let columnsSkipped = 0;

  for (const [columnName, columnData] of columns) {
    // The profiler stores column data flat: { name, rawType, columnType, ..., profile }
    const profile = columnData.profile;
    const details = columnData; // details fields are on the column data itself

    // Skip columns with no values
    if (profile && profile.hasValues === false) {
      columnsSkipped++;
      continue;
    }

    columnsProfiled++;

    // Enforce maxMapKeys limit for Map columns
    let effectiveProfile = profile;
    if (
      details.columnType === ColumnType.MAP &&
      profile &&
      profile.uniqueKeys
    ) {
      mapKeysDiscovered += profile.uniqueKeys.length;
      if (profile.uniqueKeys.length > maxMapKeys) {
        effectiveProfile = {
          ...profile,
          uniqueKeys: profile.uniqueKeys.slice(0, maxMapKeys),
        };
      }
    }

    const fields = processColumn(details, effectiveProfile, {
      arrayJoinColumns: arrayJoinColumnNames,
    });

    for (const field of fields) {
      // Track source column for deduplication
      field._sourceColumn = columnName;

      // Mark primary key columns
      if (primaryKeys.includes(columnName) && field.fieldType === 'dimension') {
        field.primary_key = true;
        field.public = true;
      }

      // Add auto-generated meta
      field.meta = { auto_generated: true };

      allFields.push(field);
    }
  }

  // Deduplicate field names
  deduplicateFields(allFields);

  const dimensions = [];
  const measures = [];

  for (const field of allFields) {
    const output = {
      name: field.name,
      sql: field.sql,
      type: field.type,
      meta: field.meta,
    };

    if (field.primary_key) {
      output.primary_key = true;
      output.public = true;
    }

    if (field.fieldType === 'measure') {
      measures.push(output);
    } else {
      dimensions.push(output);
    }
  }

  return { dimensions, measures, mapKeysDiscovered, columnsProfiled, columnsSkipped };
}

/**
 * Build the raw (main) cube from a profiled table.
 *
 * @param {object} profiledTable
 * @param {object} options
 * @returns {{ cube: object, mapKeysDiscovered: number, columnsProfiled: number, columnsSkipped: number }}
 */
function buildRawCube(profiledTable, options) {
  const {
    partition = null,
    internalTables = [],
    arrayJoinColumns = [],
    maxMapKeys = 500,
    primaryKeys = [],
  } = options;

  const schema = profiledTable.database;
  const table = profiledTable.table;
  const cubeName = sanitizeCubeName(table);
  const isInternal = internalTables.includes(table);

  const source = buildCubeSource(schema, table, partition, isInternal);

  const { dimensions, measures, mapKeysDiscovered, columnsProfiled, columnsSkipped } =
    processColumns(profiledTable.columns, {
      arrayJoinColumns,
      maxMapKeys,
      primaryKeys,
    });

  const meta = {
    auto_generated: true,
    source_database: schema,
    source_table: table,
    generated_at: new Date().toISOString(),
  };

  if (isInternal && partition) {
    meta.source_partition = partition;
  }

  const cube = {
    name: cubeName,
    ...source,
    meta,
    dimensions,
    measures,
  };

  return { cube, mapKeysDiscovered, columnsProfiled, columnsSkipped };
}

/**
 * Build a flattened ARRAY JOIN cube for a specific array column.
 *
 * @param {object} profiledTable
 * @param {{ column: string, alias: string }} arrayJoinDef
 * @param {object} rawCube - The already-built raw cube (to inherit non-array fields)
 * @param {object} options
 * @returns {object} Cube definition
 */
function buildArrayJoinCube(profiledTable, arrayJoinDef, rawCube, options) {
  const { partition = null, internalTables = [] } = options;

  const schema = profiledTable.database;
  const table = profiledTable.table;
  const { column, alias } = arrayJoinDef;
  const isInternal = internalTables.includes(table);

  const cubeName = sanitizeCubeName(`${table}_${alias}`);

  // Build the ARRAY JOIN SQL
  let sql = `SELECT *, ${column} AS ${alias} FROM ${schema}.${table} LEFT ARRAY JOIN ${column} AS ${alias}`;
  if (isInternal && partition) {
    sql += ` WHERE partition = '${partition}'`;
  }

  // Start with non-array dimensions/measures from the raw cube
  const dimensions = rawCube.dimensions
    .filter((d) => !d._isArrayField)
    .map((d) => ({ ...d }));
  const measures = rawCube.measures.map((m) => ({ ...m }));

  // Process the array column's element fields
  // Look up the array column in the profiled table
  const columnData = profiledTable.columns.get(column);
  if (columnData && columnData.profile) {
    // Add a dimension for the flattened alias
    const aliasDim = {
      name: sanitizeFieldName(alias),
      sql: `{CUBE}.${alias}`,
      type: 'string',
      meta: { auto_generated: true },
    };

    // Check for name collision
    const existingNames = new Set([
      ...dimensions.map((d) => d.name),
      ...measures.map((m) => m.name),
    ]);
    if (existingNames.has(aliasDim.name)) {
      aliasDim.name = `${sanitizeFieldName(column)}_${aliasDim.name}`;
    }

    dimensions.push(aliasDim);
  }

  const meta = {
    auto_generated: true,
    source_database: schema,
    source_table: table,
    array_join_column: column,
    array_join_alias: alias,
    generated_at: new Date().toISOString(),
  };

  if (isInternal && partition) {
    meta.source_partition = partition;
  }

  return {
    name: cubeName,
    sql,
    meta,
    dimensions,
    measures,
  };
}

// -- Main entry point -------------------------------------------------------

/**
 * Build Cube.js cube definitions from a profiled ClickHouse table.
 *
 * @param {object} profiledTable
 *   @param {string} profiledTable.database - Database/schema name
 *   @param {string} profiledTable.table - Table name
 *   @param {string|null} profiledTable.partition - Partition value
 *   @param {Map} profiledTable.columns - Map of columnName -> { details, profile }
 * @param {object} [options]
 *   @param {string|null} [options.partition] - Partition value
 *   @param {string[]} [options.internalTables] - Tables subject to partition filtering
 *   @param {Array<{column: string, alias: string}>} [options.arrayJoinColumns] - Columns for ARRAY JOIN
 *   @param {number} [options.maxMapKeys] - Max Map keys per column (default 500)
 *   @param {string[]} [options.primaryKeys] - Primary key column names
 * @returns {{
 *   cubes: object[],
 *   summary: {
 *     dimensions_count: number,
 *     measures_count: number,
 *     cubes_count: number,
 *     map_keys_discovered: number,
 *     columns_profiled: number,
 *     columns_skipped: number,
 *   }
 * }}
 */
export function buildCubes(profiledTable, options = {}) {
  const {
    arrayJoinColumns = [],
  } = options;

  const cubes = [];

  // 1. Build the raw (main) cube
  const { cube: rawCube, mapKeysDiscovered, columnsProfiled, columnsSkipped } =
    buildRawCube(profiledTable, options);

  cubes.push(rawCube);

  // 2. Build flattened ARRAY JOIN cubes
  for (const ajDef of arrayJoinColumns) {
    const ajCube = buildArrayJoinCube(profiledTable, ajDef, rawCube, options);
    cubes.push(ajCube);
  }

  // 3. Compute summary
  let totalDimensions = 0;
  let totalMeasures = 0;
  for (const cube of cubes) {
    totalDimensions += cube.dimensions.length;
    totalMeasures += cube.measures.length;
  }

  return {
    cubes,
    summary: {
      dimensions_count: totalDimensions,
      measures_count: totalMeasures,
      cubes_count: cubes.length,
      map_keys_discovered: mapKeysDiscovered,
      columns_profiled: columnsProfiled,
      columns_skipped: columnsSkipped,
    },
  };
}
