/**
 * Cube builder module — converts a ProfiledTable into Cube.js cube
 * definition objects (dimensions, measures, metadata).
 *
 * Ported from Python prototype: cxs-inbox/cube/utils/cube_builder.py
 */

import { processColumn, sanitizeFieldName } from './fieldProcessors.js';
import { ColumnType, ValueType } from './typeParser.js';

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

// -- Nested group lookup key detection --------------------------------------

/** Naming patterns that indicate a lookup/discriminator column. */
const LOOKUP_KEY_PATTERN = /(_of|_type|_kind|_category)$/i;

/**
 * Scan columns to find nested groups that have a lookup key.
 *
 * A lookup key is a GROUPED string sub-column with low-cardinality values
 * (has lcValues). When found, the other sub-columns in that group should
 * use FILTER_PARAMS to resolve values by the lookup key at query time.
 *
 * @param {Map} columns - Map of column name -> column data
 * @returns {Map<string, { lookupColumn: string, lookupChildName: string, lcValues: string[] }>}
 *   Map of parentName -> lookup info
 */
function detectNestedLookupKeys(columns) {
  // Group all GROUPED columns by parent
  const groups = new Map(); // parent -> [columnData]
  for (const [, col] of columns) {
    if (col.columnType === ColumnType.GROUPED && col.parentName) {
      if (!groups.has(col.parentName)) groups.set(col.parentName, []);
      groups.get(col.parentName).push(col);
    }
  }

  const lookups = new Map();
  for (const [parent, cols] of groups) {
    // Find the best lookup key candidate:
    // 1. Prefer columns matching the naming pattern (*_of, *_type, etc.)
    // 2. Fall back to first string column with lcValues
    let best = null;
    for (const col of cols) {
      if (col.valueType !== ValueType.STRING) continue;
      if (!col.profile?.lcValues || !Array.isArray(col.profile.lcValues)) continue;
      if (col.profile.lcValues.length === 0) continue;

      if (LOOKUP_KEY_PATTERN.test(col.childName)) {
        best = col; // naming match — prefer this
        break;
      }
      if (!best) best = col; // first viable candidate
    }

    if (best) {
      lookups.set(parent, {
        lookupColumn: best.name,
        lookupChildName: best.childName,
        lcValues: best.profile.lcValues,
      });
    }
  }

  return lookups;
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
  const { arrayJoinColumns = [], maxMapKeys = 500, primaryKeys = [], cubeName = 'cube' } = options;
  const arrayJoinColumnNames = arrayJoinColumns.map((a) => a.column);

  const allFields = [];
  let mapKeysDiscovered = 0;
  let columnsProfiled = 0;
  let columnsSkipped = 0;

  // Detect nested groups with lookup keys for FILTER_PARAMS generation
  const nestedLookups = detectNestedLookupKeys(columns);

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

    // ---------------------------------------------------------------
    // Nested group with lookup key → FILTER_PARAMS dimensions
    // ---------------------------------------------------------------
    if (details.columnType === ColumnType.GROUPED && details.parentName) {
      const lookup = nestedLookups.get(details.parentName);
      if (lookup) {
        const parentName = details.parentName;
        const childName = details.childName;

        if (columnName === lookup.lookupColumn) {
          // This IS the lookup key → emit a filter dimension.
          // The sql uses FILTER_PARAMS to echo back the filter value so that
          // Cube.js's auto-generated WHERE clause becomes e.g. 'Vehicle' = 'Vehicle' (always true).
          const filterDimName = `${sanitizeFieldName(parentName)}_type`;
          const filterDimRef = `${cubeName}.${filterDimName}`;
          const field = {
            name: filterDimName,
            sql: `toString({FILTER_PARAMS.${filterDimRef}.filter((v) => v)})`,
            type: 'string',
            fieldType: 'dimension',
            _sourceColumn: columnName,
            meta: {
              auto_generated: true,
              source_column: columnName,
              raw_type: details.rawType,
              nested_lookup_key: true,
              known_values: lookup.lcValues,
            },
          };
          if (profile && profile.maxArrayLength != null && profile.maxArrayLength > 0) {
            field.meta.max_array_length = profile.maxArrayLength;
          }
          allFields.push(field);
        } else {
          // This is a data sub-column → emit FILTER_PARAMS-resolved dimension
          const fieldName = `${sanitizeFieldName(parentName)}_${sanitizeFieldName(childName)}`;
          const filterDimRef = `${cubeName}.${sanitizeFieldName(parentName)}_type`;

          // Determine type from the child column
          const isCoordinate = /^(lat|latitude|lon|lng|longitude)$/i.test(childName);
          const fieldType = details.valueType === ValueType.NUMBER ? 'number'
            : details.valueType === ValueType.DATE ? 'time'
            : details.valueType === ValueType.BOOLEAN ? 'boolean'
            : 'string';
          // Coordinates are dimensions; other numbers are measures
          const cubeFieldType = (details.valueType === ValueType.NUMBER && !isCoordinate) ? 'measure' : 'dimension';
          const cubeType = cubeFieldType === 'measure' ? 'sum' : fieldType;

          const field = {
            name: fieldName,
            sql: `arrayElementOrNull({CUBE}.\`${parentName}.${childName}\`, indexOf({CUBE}.\`${parentName}.${lookup.lookupChildName}\`, toString({FILTER_PARAMS.${filterDimRef}.filter((v) => v)})))`,
            type: cubeType,
            fieldType: cubeFieldType,
            _sourceColumn: columnName,
            meta: {
              auto_generated: true,
              source_column: columnName,
              raw_type: details.rawType,
              resolved_by: `${sanitizeFieldName(parentName)}_type`,
            },
          };
          if (profile && profile.maxArrayLength != null && profile.maxArrayLength > 0) {
            field.meta.max_array_length = profile.maxArrayLength;
          }
          allFields.push(field);
        }
        continue; // skip normal processing for this column
      }
    }

    // ---------------------------------------------------------------
    // Normal column processing (non-lookup nested, basic, map, array)
    // ---------------------------------------------------------------

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

      // Add auto-generated meta with source info
      field.meta = { auto_generated: true };
      field.meta.source_column = columnName;
      field.meta.raw_type = details.rawType;

      // Add profile stats when available
      if (profile) {
        // For Map-expanded fields, unique_values from the parent is the key count
        // — not meaningful per-field. Only attach for non-map fields.
        if (!field._mapKey && profile.uniqueValues > 0) {
          field.meta.unique_values = profile.uniqueValues;
        }
        if (profile.minValue != null) {
          field.meta.min_value = profile.minValue;
        }
        if (profile.maxValue != null) {
          field.meta.max_value = profile.maxValue;
        }
        if (profile.avgValue != null) {
          field.meta.avg_value = profile.avgValue;
        }
        if (profile.maxArrayLength != null && profile.maxArrayLength > 0) {
          field.meta.max_array_length = profile.maxArrayLength;
        }
      }

      // For Map-expanded fields, add per-key metadata
      if (field._mapKey) {
        field.meta.map_key = field._mapKey;

        // Per-key stats from profiler (numeric: min/max/avg, string: unique_values)
        if (profile && profile.keyStats && profile.keyStats[field._mapKey]) {
          const stats = profile.keyStats[field._mapKey];
          if (stats.min != null) field.meta.min_value = stats.min;
          if (stats.max != null) field.meta.max_value = stats.max;
          if (stats.avg != null) field.meta.avg_value = stats.avg;
          if (stats.unique_values != null) field.meta.unique_values = stats.unique_values;
        }

        // String map keys get LC values
        if (profile && profile.lcValues && typeof profile.lcValues === 'object' && !Array.isArray(profile.lcValues)) {
          if (profile.lcValues[field._mapKey]) {
            field.meta.lc_values = profile.lcValues[field._mapKey];
          }
        }
      } else {
        // Non-map fields: attach LC values for categorical data
        if (profile && profile.lcValues != null && Array.isArray(profile.lcValues)) {
          field.meta.lc_values = profile.lcValues;
        }
      }

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
      cubeName,
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
