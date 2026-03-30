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
 * Convert a snake_case field name to a human-readable Title.
 * E.g. "commerce_products_entry_type" → "Commerce Products Entry Type"
 *
 * @param {string} name
 * @returns {string}
 */
function titleFromName(name) {
  const UPPER = new Set(['id', 'gid', 'sku', 'upc', 'ean', 'isbn', 'gtin', 'uom', 'gs1', 'ip', 'url', 'img', 'os', 'ms', 'mgr']);
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((w) => UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

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
 * Build a SQL WHERE clause fragment from filter descriptors.
 *
 * @param {Array<{ column: string, operator: string, value: * }>} filters
 * @returns {string} SQL conditions joined by AND (no WHERE keyword)
 */
function filtersToSqlConditions(filters) {
  const conditions = [];
  for (const f of filters) {
    const op = String(f.operator).toUpperCase();
    if (op === 'IS NULL' || op === 'IS NOT NULL') {
      conditions.push(`${f.column} ${op}`);
    } else if (op === 'IN' || op === 'NOT IN') {
      const vals = (Array.isArray(f.value) ? f.value : [f.value])
        .map((v) => typeof v === 'number' ? v : `'${String(v).replace(/'/g, "''")}'`)
        .join(', ');
      conditions.push(`${f.column} ${op} (${vals})`);
    } else {
      const val = typeof f.value === 'number' ? f.value : `'${String(f.value).replace(/'/g, "''")}'`;
      conditions.push(`${f.column} ${op} ${val}`);
    }
  }
  return conditions.join(' AND ');
}

/**
 * Build the SQL expression for the cube source.
 *
 * When filters are provided, the cube uses `sql:` with a SELECT…WHERE
 * so queries always return the same subset that was profiled.
 * Cube.js composes its own security-context filters (partition, etc.)
 * on top by wrapping this as a subquery.
 *
 * @param {string} schema - Database/schema name
 * @param {string} table - Table name
 * @param {string|null} partition - Partition value
 * @param {boolean} isInternal - Whether the table is in internalTables
 * @param {Array<{ column: string, operator: string, value: * }>} [filters]
 * @returns {{ sql_table?: string, sql?: string }}
 */
function buildCubeSource(schema, table, partition, isInternal, filters) {
  const qualifiedTable = schema ? `${schema}.${table}` : table;
  const conditions = [];

  if (isInternal && partition) {
    conditions.push(`partition = '${partition}'`);
  }

  if (filters && filters.length > 0) {
    conditions.push(filtersToSqlConditions(filters));
  }

  if (conditions.length > 0) {
    return {
      sql: `SELECT * FROM ${qualifiedTable} WHERE ${conditions.join(' AND ')}`,
    };
  }
  return { sql_table: qualifiedTable };
}

/**
 * Map a ValueType to a JSON-friendly field type string.
 *
 * @param {string} valueType - ValueType enum value
 * @param {string} rawType - Raw ClickHouse type string
 * @returns {string} JSON-friendly type like "string", "integer", "float", "boolean", "datetime", "uuid"
 */
function toJsonFieldType(valueType, rawType) {
  const raw = (rawType || '').toLowerCase();
  switch (valueType) {
    case ValueType.STRING:
      return 'string';
    case ValueType.NUMBER:
      if (/^u?int/i.test(raw.replace(/nullable\(|lowcardinality\(/g, ''))) return 'integer';
      return 'float';
    case ValueType.DATE:
      return 'datetime';
    case ValueType.UUID:
      return 'uuid';
    case ValueType.BOOLEAN:
      return 'boolean';
    default:
      return 'string';
  }
}

/**
 * Extract the value type from a Map(...) raw type string.
 * e.g. "Map(LowCardinality(String), Float32)" → "Float32"
 *
 * @param {string} rawType
 * @returns {string|null} The unwrapped value type, or null if not a Map
 */
function extractMapValueType(rawType) {
  const m = rawType.match(/^Map\s*\((.+)\)\s*$/i);
  if (!m) return null;
  // Split on top-level comma (respecting parentheses depth)
  let depth = 0;
  let splitIdx = -1;
  for (let i = 0; i < m[1].length; i++) {
    if (m[1][i] === '(') depth++;
    else if (m[1][i] === ')') depth--;
    else if (m[1][i] === ',' && depth === 0) { splitIdx = i; break; }
  }
  if (splitIdx === -1) return null;
  let valPart = m[1].slice(splitIdx + 1).trim();
  // Unwrap Nullable / LowCardinality wrappers
  valPart = valPart.replace(/^(Nullable|LowCardinality)\s*\(\s*/gi, '').replace(/\s*\)\s*$/, '');
  return valPart || null;
}

/**
 * Build a range object from min/max/avg values.
 * For numbers: coerces strings to numbers, includes avg.
 * For timestamps: keeps as strings, min/max only (avg is meaningless).
 *
 * @param {*} min
 * @param {*} max
 * @param {*} avg
 * @returns {{ min: number|string, max: number|string, avg?: number }|null}
 */
function buildRange(min, max, avg) {
  const parts = {};
  // Try numeric first
  if (min != null) {
    const n = Number(min);
    if (!isNaN(n)) parts.min = n;
    else if (typeof min === 'string' && min.length > 0) parts.min = min; // timestamp
  }
  if (max != null) {
    const n = Number(max);
    if (!isNaN(n)) parts.max = n;
    else if (typeof max === 'string' && max.length > 0) parts.max = max; // timestamp
  }
  // avg only for numerics
  if (avg != null) {
    const n = Number(avg);
    if (!isNaN(n)) parts.avg = n;
  }
  return Object.keys(parts).length > 0 ? parts : null;
}

/**
 * Check whether a field represents an Int8 boolean (for meta filtering).
 *
 * @param {string} rawType
 * @param {object|null} profile
 * @returns {boolean}
 */
function isInt8Boolean(rawType, profile) {
  if (!(rawType || '').toLowerCase().includes('int8')) return false;
  if (!profile) return true;
  if (profile.maxValue != null && profile.maxValue > 1) return false;
  if (profile.minValue != null && profile.minValue < 0) return false;
  return true;
}

/**
 * Process all columns from a profiled table into cube fields.
 *
 * @param {Map} columns - Map of column name -> { details, profile }
 * @param {object} options
 * @param {Array<{column: string, alias: string}>} options.arrayJoinColumns
 * @param {number} options.maxMapKeys
 * @param {string[]} options.primaryKeys
 * @param {Map} [options.columnDescriptions] - Map of column name -> description
 * @returns {{ dimensions: object[], measures: object[], mapKeysDiscovered: number, columnsProfiled: number, columnsSkipped: number }}
 */
function processColumns(columns, options) {
  const {
    arrayJoinColumns = [],
    maxMapKeys = 500,
    primaryKeys = [],
    cubeName = 'cube',
    columnDescriptions = new Map(),
    columnOrder = [],
  } = options;
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

    // Skip string/UUID columns with 0 unique non-empty values
    // (applies to basic, grouped, and array columns — not maps, which use key expansion)
    if (
      profile &&
      (details.valueType === ValueType.STRING || details.valueType === ValueType.UUID) &&
      details.columnType !== ColumnType.MAP
    ) {
      if ((profile.uniqueValues ?? 0) === 0) {
        columnsSkipped++;
        continue;
      }
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
        const colDescription = columnDescriptions.get(columnName) || null;

        if (columnName === lookup.lookupColumn) {
          // This IS the lookup key → emit a filter dimension.
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
              field_type: 'string',
              nested_lookup_key: true,
              known_values: lookup.lcValues,
            },
          };
          if (colDescription) field.meta.description = colDescription;
          if (profile && profile.maxArrayLength != null && profile.maxArrayLength > 0) {
            field.meta.max_array_length = profile.maxArrayLength;
          }
          allFields.push(field);
        } else {
          // Skip nested sub-columns with no non-empty values
          if (
            profile &&
            (details.valueType === ValueType.STRING || details.valueType === ValueType.UUID) &&
            (profile.uniqueValues ?? 0) === 0
          ) {
            columnsSkipped++;
            continue;
          }

          // This is a data sub-column → emit FILTER_PARAMS-resolved dimension
          const fieldName = `${sanitizeFieldName(parentName)}_${sanitizeFieldName(childName)}`;
          const filterDimRef = `${cubeName}.${sanitizeFieldName(parentName)}_type`;

          // Determine type from the child column
          const isCoordinate = /^(lat|latitude|lon|lng|longitude)$/i.test(childName);
          const fieldType = details.valueType === ValueType.NUMBER ? 'number'
            : details.valueType === ValueType.DATE ? 'time'
            : details.valueType === ValueType.BOOLEAN ? 'boolean'
            : 'string';
          const jsonFieldType = toJsonFieldType(details.valueType, details.rawType);
          // Coordinates are dimensions; other numbers are measures
          const cubeFieldType = (details.valueType === ValueType.NUMBER && !isCoordinate) ? 'measure' : 'dimension';
          const cubeType = cubeFieldType === 'measure' ? 'sum' : fieldType;

          // FILTER_PARAMS-resolved field — returns the selected element as
          // a string when a filter is set; otherwise stringifies the full array.
          const arrRef = `{CUBE}.\`${parentName}.${childName}\``;
          const idxExpr = `indexOf({CUBE}.\`${parentName}.${lookup.lookupChildName}\`, toString({FILTER_PARAMS.${filterDimRef}.filter((v) => v)}))`;
          const elemExpr = `arrayElementOrNull(${arrRef}, ${idxExpr})`;
          const field = {
            name: fieldName,
            sql: `if(${idxExpr} > 0, toString(${elemExpr}), toString(${arrRef}))`,
            type: 'string',
            fieldType: 'dimension',
            _sourceColumn: columnName,
            meta: {
              auto_generated: true,
              source_column: columnName,
              raw_type: details.rawType,
              field_type: jsonFieldType,
            },
          };
          if (colDescription) field.meta.description = colDescription;
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

      // For map-expanded fields, use the map's value type (e.g. "Float32"),
      // not the full Map(...) container type
      if (field._mapKey) {
        const mapValueType = extractMapValueType(details.rawType);
        if (mapValueType) field.meta.raw_type = mapValueType;
      } else {
        field.meta.raw_type = details.rawType;
      }

      // Add JSON-friendly field_type
      const isBoolField = isInt8Boolean(details.rawType, profile);
      if (field._mapKey) {
        // For map-expanded fields, use the map's value data type
        field.meta.field_type = toJsonFieldType(details.valueDataType || details.valueType, details.rawType);
      } else {
        field.meta.field_type = isBoolField ? 'boolean' : toJsonFieldType(details.valueType, details.rawType);
      }

      // Add column description if available
      const colDescription = columnDescriptions.get(columnName) || null;
      if (colDescription) {
        field.meta.description = colDescription;
      }

      // Add profile stats when available
      if (profile) {
        // For Map-expanded fields, unique_values from the parent is the key count
        // — not meaningful per-field. Only attach for non-map fields.
        if (!field._mapKey && profile.uniqueValues > 0) {
          field.meta.unique_values = profile.uniqueValues;
        }

        // Numeric range: combine min/max/avg into a single "range" field
        if (!isBoolField) {
          const range = buildRange(profile.minValue, profile.maxValue, profile.avgValue);
          if (range) field.meta.range = range;
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
          const range = buildRange(stats.min, stats.max, stats.avg);
          if (range) field.meta.range = range;
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

      // Skip map-expanded fields with no useful data (only when keyStats was populated by profiler)
      if (field._mapKey && profile?.keyStats) {
        const stats = profile.keyStats[field._mapKey];
        if (stats) {
          // Numeric keys: skip if min/max/avg are all null (no non-null values)
          if (field.fieldType === 'measure' && stats.min == null && stats.max == null && stats.avg == null) {
            continue;
          }
          // String keys: skip if 0 unique non-empty values
          if (field.fieldType === 'dimension' && (stats.unique_values ?? 0) === 0) {
            continue;
          }
        }
      }

      allFields.push(field);
    }

    // For Map columns, also emit native accessor dimensions (the full map column)
    // This lets queries access the map directly without individual key expansion
    if (details.columnType === ColumnType.MAP && profile && profile.uniqueKeys && profile.uniqueKeys.length > 0) {
      const mapFieldName = `${sanitizeFieldName(columnName)}_map`;
      const colDescription = columnDescriptions.get(columnName) || null;
      const nativeMapField = {
        name: mapFieldName,
        sql: `toString({CUBE}.\`${columnName}\`)`,
        type: 'string',
        fieldType: 'dimension',
        _sourceColumn: columnName,
        meta: {
          auto_generated: true,
          source_column: columnName,
          raw_type: details.rawType,
          field_type: 'map',
          native_map: true,
          known_keys: profile.uniqueKeys,
        },
      };
      if (colDescription) nativeMapField.meta.description = colDescription;
      allFields.push(nativeMapField);
    }
  }

  // Deduplicate field names
  deduplicateFields(allFields);

  // Final ordering guard: keep generated fields in DDL column order.
  // This protects against accidental ordering drift in upstream payloads.
  const columnIndex = new Map();
  if (Array.isArray(columnOrder) && columnOrder.length > 0) {
    for (let i = 0; i < columnOrder.length; i++) {
      columnIndex.set(columnOrder[i], i);
    }
  } else {
    let idx = 0;
    for (const colName of columns.keys()) {
      columnIndex.set(colName, idx++);
    }
  }

  const fallbackIndex = Number.MAX_SAFE_INTEGER;
  allFields
    .map((field, idx) => ({
      field,
      idx,
      order: columnIndex.has(field._sourceColumn)
        ? columnIndex.get(field._sourceColumn)
        : fallbackIndex,
    }))
    .sort((a, b) => {
      if (a.order === b.order) return a.idx - b.idx;
      return a.order - b.order;
    })
    .forEach((entry, i) => {
      allFields[i] = entry.field;
    });

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
    cubeName: cubeNameOverride,
    filters = [],
  } = options;

  const schema = profiledTable.database;
  const table = profiledTable.table;
  const cubeName = cubeNameOverride || sanitizeCubeName(table);
  const isInternal = internalTables.includes(table);

  const source = buildCubeSource(schema, table, partition, isInternal, filters);

  const { dimensions, measures, mapKeysDiscovered, columnsProfiled, columnsSkipped } =
    processColumns(profiledTable.columns, {
      arrayJoinColumns,
      maxMapKeys,
      primaryKeys,
      cubeName,
      columnOrder: profiledTable.columnOrder || [],
      columnDescriptions: profiledTable.columnDescriptions || new Map(),
    });

  // Add count measure (always present — fundamental for any cube)
  measures.unshift({
    name: 'count',
    sql: '*',
    type: 'count',
    meta: { auto_generated: true, field_type: 'integer' },
  });

  // -- Heuristics: partition-first ordering ----------------------------------
  const partitionIdx = dimensions.findIndex((d) => d.name === 'partition');
  if (partitionIdx > 0) {
    const [partitionDim] = dimensions.splice(partitionIdx, 1);
    dimensions.unshift(partitionDim);
  }

  // -- Heuristics: titles on all fields + cube --------------------------------
  for (const dim of dimensions) { if (!dim.title) dim.title = titleFromName(dim.name); }
  for (const meas of measures) { if (!meas.title) meas.title = titleFromName(meas.name); }

  // -- Heuristics: meta block -------------------------------------------------
  const timeDim = dimensions.find((d) => d.type === 'time' && d.primary_key !== true);
  const grainParts = (primaryKeys || []).length > 0
    ? primaryKeys.map(sanitizeFieldName).join(' + ')
    : 'one row per source record';

  const meta = {
    auto_generated: true,
    source_database: schema,
    source_table: table,
    grain: grainParts,
    grain_description: `Each row represents one ${table} record, keyed by ${grainParts}.`,
    time_dimension: timeDim ? timeDim.name : null,
    time_zone: 'UTC',
    refresh_cadence: '1 hour',
    generated_at: new Date().toISOString(),
  };

  // Include table description if available
  if (profiledTable.tableDescription) {
    meta.description = profiledTable.tableDescription;
  }

  if (isInternal && partition) {
    meta.source_partition = partition;
  }

  // -- Heuristics: paired filtered counts for LC dimensions -------------------
  const countMeasure = measures.find((m) => m.type === 'count');
  if (countMeasure) {
    for (const dim of dimensions) {
      const lcValues = dim.meta?.lc_values;
      if (!Array.isArray(lcValues) || lcValues.length === 0 || lcValues.length > 10) continue;
      if (dim.type !== 'string') continue;
      for (const val of lcValues) {
        const slug = sanitizeFieldName(val.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
        const measName = `count_${dim.name}_${slug}`;
        if (measures.some((m) => m.name === measName)) continue;
        measures.push({
          name: measName,
          title: titleFromName(measName),
          sql: `{CUBE}.${dim.name}`,
          type: 'count',
          filters: [{ sql: `{CUBE}.${dim.name} = '${val.replace(/'/g, "''")}'` }],
          meta: { auto_generated: true, filtered_count_for: dim.name, filter_value: val },
        });
      }
    }
  }

  // -- Heuristics: format inference -------------------------------------------
  const CURRENCY_PATTERN = /^(revenue|tax|discount|cogs|commission|amount|fee|total|balance)$|_(price|cost|revenue|fee|amount)$/i;
  const PERCENT_PATTERN = /_(percentage|pct|ratio|rate)$/i;
  for (const meas of measures) {
    if (meas.format) continue;
    if (CURRENCY_PATTERN.test(meas.name)) meas.format = 'currency';
    else if (PERCENT_PATTERN.test(meas.name)) meas.format = 'percent';
  }

  // -- Heuristics: public:false on plumbing fields ----------------------------
  const PLUMBING_PATTERN = /^(message_id|event_gid|anonymous_gid|session_gid|user_gid|write_key|ttl_days)$|_gid$/;
  for (const dim of dimensions) {
    if (dim.public !== undefined) continue;
    if (PLUMBING_PATTERN.test(dim.name)) dim.public = false;
  }

  // -- Heuristics: drill members on count -------------------------------------
  if (countMeasure) {
    const drillCandidates = dimensions
      .filter((d) => d.type === 'string' && !d.name.includes('_id') && !d.name.includes('_gid') && d.public !== false)
      .slice(0, 5)
      .map((d) => d.name);
    if (drillCandidates.length > 0) {
      countMeasure.drill_members = drillCandidates;
    }
  }

  // -- Heuristics: default pre-aggregations -----------------------------------
  const preAggDimensions = dimensions
    .filter((d) => d.type === 'string' && d.public !== false)
    .slice(0, 5)
    .map((d) => d.name);
  const preAggMeasures = measures
    .filter((m) => ['count', 'sum', 'min', 'max'].includes(m.type))
    .slice(0, 10)
    .map((m) => m.name);
  const pre_aggregations = [];
  if (timeDim && preAggMeasures.length > 0) {
    pre_aggregations.push({
      name: 'daily_rollup',
      type: 'rollup',
      dimensions: ['partition', ...preAggDimensions],
      measures: preAggMeasures,
      time_dimension: timeDim.name,
      granularity: 'day',
      partition_granularity: 'month',
      refresh_key: { every: '1 hour' },
      indexes: [{ name: 'partition_time_idx', columns: ['partition', timeDim.name] }],
    });
    pre_aggregations.push({
      name: 'monthly_rollup',
      type: 'rollup',
      dimensions: ['partition'],
      measures: preAggMeasures.slice(0, 5),
      time_dimension: timeDim.name,
      granularity: 'month',
      partition_granularity: 'month',
      refresh_key: { every: '1 hour' },
      indexes: [{ name: 'partition_idx', columns: ['partition'] }],
    });
  }

  const cube = {
    name: cubeName,
    title: titleFromName(cubeName),
    description: profiledTable.tableDescription || `Analytical model for ${schema}.${table}, auto-generated from table profiling.`,
    ...source,
    meta,
    dimensions,
    measures,
    pre_aggregations,
  };

  return { cube, mapKeysDiscovered, columnsProfiled, columnsSkipped };
}

/**
 * Derive a cube name suffix from nested filter values.
 * E.g., ["Line Item", "Cart Item"] → "line_items_cart_items"
 *
 * @param {Array<{column: string, values: string[]}>} filters
 * @returns {string} Sanitized suffix or empty string
 */
function deriveCubeNameFromFilters(filters) {
  if (!filters || filters.length === 0) return '';

  const parts = [];
  for (const f of filters) {
    for (const v of f.values) {
      // "Line Item" → "line_item", then pluralize naively
      let slug = v.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (slug && !slug.endsWith('s')) slug += 's';
      if (slug) parts.push(slug);
    }
  }
  return parts.join('_');
}

/**
 * Build a flattened ARRAY JOIN cube for one or more nested array groups.
 *
 * @param {object} profiledTable
 * @param {string[]} arrayJoinGroups - Parent group names (e.g. ["commerce.products"])
 * @param {object} rawCube - The already-built raw cube (to inherit non-array fields)
 * @param {object} options
 * @returns {object} Cube definition
 */
function buildArrayJoinCube(profiledTable, arrayJoinGroups, rawCube, options) {
  const {
    partition = null,
    internalTables = [],
    nestedFilters = [],
  } = options;

  const schema = profiledTable.database;
  const table = profiledTable.table;
  const isInternal = internalTables.includes(table);

  // Collect all Array-typed child columns for the selected groups.
  // Only Array columns can be ARRAY JOINed — scalar dotted columns
  // (e.g. commerce.details Nullable(String)) are excluded.
  const groupColumns = new Map(); // group -> [colData]
  for (const [colName, colData] of profiledTable.columns) {
    if (colData.columnType !== ColumnType.GROUPED || !colData.parentName) continue;
    if (!arrayJoinGroups.includes(colData.parentName)) continue;
    if (!colData.rawType?.startsWith('Array(')) continue;
    if (!groupColumns.has(colData.parentName)) groupColumns.set(colData.parentName, []);
    groupColumns.get(colData.parentName).push(colData);
  }

  // Warn if no child columns were found for any of the requested groups
  if (groupColumns.size === 0 && arrayJoinGroups.length > 0) {
    console.warn(
      `[cubeBuilder] buildArrayJoinCube: no child columns found for array join groups: ${arrayJoinGroups.join(', ')}. ` +
      `The resulting cube will have no group-specific dimensions/measures.`
    );
  }

  // Derive cube name from table + filter values (or group names if no filters)
  const allFilters = nestedFilters.flatMap((nf) => nf.filters || []);
  const filterSuffix = deriveCubeNameFromFilters(allFilters);
  const groupSuffix = filterSuffix || arrayJoinGroups.map((g) => sanitizeCubeName(g)).join('_');
  const cubeName = sanitizeCubeName(`${table}_${groupSuffix}`);

  // Build the ARRAY JOIN SQL — enumerate each sub-column with an alias.
  // ClickHouse Nested columns (parallel arrays with dotted names) require:
  //   ARRAY JOIN `parent.child1` AS child1_alias, `parent.child2` AS child2_alias
  // Format with newlines for readability in the model editor.
  const ajParts = [];
  for (const [group, cols] of groupColumns) {
    for (const col of cols) {
      const alias = col.name.replace(/\./g, '_');
      ajParts.push(`  \`${col.name}\` AS \`${alias}\``);
    }
  }
  let sql;
  if (ajParts.length > 0) {
    sql = `SELECT *\nFROM ${schema}.${table}\nLEFT ARRAY JOIN\n${ajParts.join(',\n')}`;
  } else {
    sql = `SELECT * FROM ${schema}.${table}`;
  }

  // Collect WHERE conditions — use aliased names (dots → underscores)
  const whereParts = [];
  if (isInternal && partition) {
    whereParts.push(`partition = '${partition}'`);
  }
  for (const nf of nestedFilters) {
    for (const f of nf.filters || []) {
      const fullCol = f.column.includes('.') ? f.column : `${nf.group}.${f.column}`;
      const alias = fullCol.replace(/\./g, '_');
      if (f.values.length === 1) {
        whereParts.push(`\`${alias}\` = '${f.values[0].replace(/'/g, "''")}'`);
      } else if (f.values.length > 1) {
        const vals = f.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
        whereParts.push(`\`${alias}\` IN (${vals})`);
      }
    }
  }
  if (whereParts.length > 0) {
    sql += `\nWHERE ${whereParts.join('\n  AND ')}`;
  }

  // Start with non-array dimensions/measures from the raw cube
  const dimensions = rawCube.dimensions
    .filter((d) => !d._isArrayField)
    .map((d) => ({ ...d }));
  const measures = rawCube.measures.map((m) => ({ ...m }));

  // Add dimensions/measures for each child column in the selected groups
  const existingNames = new Set([
    ...dimensions.map((d) => d.name),
    ...measures.map((m) => m.name),
  ]);

  for (const [group, cols] of groupColumns) {
    for (const col of cols) {
      // The ARRAY JOIN alias is the full dotted name with dots → underscores
      const colAlias = col.name.replace(/\./g, '_');
      const dimName = sanitizeFieldName(colAlias);
      let finalName = dimName;
      if (existingNames.has(finalName)) {
        finalName = `${finalName}_${existingNames.size}`;
      }
      existingNames.add(finalName);

      // Map value types to Cube.js types
      let cubeType = 'string';
      if (col.valueType === ValueType.NUMBER) cubeType = 'number';
      else if (col.valueType === ValueType.DATE) cubeType = 'time';
      else if (col.valueType === ValueType.BOOLEAN) cubeType = 'boolean';

      // Numeric child columns become measures; strings become dimensions
      if (col.valueType === ValueType.NUMBER) {
        measures.push({
          name: finalName,
          sql: `{CUBE}.${colAlias}`,
          type: 'sum',
          meta: { auto_generated: true, source_column: col.name, source_group: group },
        });
      } else {
        dimensions.push({
          name: finalName,
          sql: `{CUBE}.${colAlias}`,
          type: cubeType,
          meta: { auto_generated: true, source_column: col.name, source_group: group },
        });
      }
    }
  }

  // Titles on all fields
  for (const dim of dimensions) { if (!dim.title) dim.title = titleFromName(dim.name); }
  for (const meas of measures) { if (!meas.title) meas.title = titleFromName(meas.name); }

  const meta = {
    auto_generated: true,
    source_database: schema,
    source_table: table,
    array_join_groups: arrayJoinGroups,
    nested_filters: nestedFilters.length > 0 ? nestedFilters : undefined,
    generated_at: new Date().toISOString(),
  };

  if (isInternal && partition) {
    meta.source_partition = partition;
  }

  return {
    name: cubeName,
    title: titleFromName(cubeName),
    description: profiledTable.tableDescription || `Analytical model for ${schema}.${table}, auto-generated from table profiling.`,
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
export { mergeAIMetrics };

export function buildCubes(profiledTable, options = {}) {
  const {
    arrayJoinColumns = [],
    nestedFilters = [],
  } = options;

  const cubes = [];

  // Always build the raw cube — needed for field processing and heuristics.
  // When nested filters are active, the raw cube is used as a base but NOT emitted.
  const { cube: rawCube, mapKeysDiscovered, columnsProfiled, columnsSkipped } =
    buildRawCube(profiledTable, options);

  if (nestedFilters.length > 0) {
    // Nested-filter path: emit ONLY the array-joined cube.
    // The raw cube is used internally for base field processing but discarded.
    const groups = nestedFilters.map((nf) => nf.group);
    const ajCube = buildArrayJoinCube(profiledTable, groups, rawCube, options);

    // Apply heuristics that buildRawCube applies but buildArrayJoinCube doesn't:
    // - Partition-first ordering
    const partitionIdx = ajCube.dimensions.findIndex((d) => d.name === 'partition');
    if (partitionIdx > 0) {
      const [partitionDim] = ajCube.dimensions.splice(partitionIdx, 1);
      ajCube.dimensions.unshift(partitionDim);
    }

    // - Grain + meta enrichment
    const timeDim = ajCube.dimensions.find((d) => d.type === 'time' && d.primary_key !== true);
    const primaryKeys = options.primaryKeys || [];
    const grainParts = primaryKeys.length > 0
      ? primaryKeys.map(sanitizeFieldName).join(' + ')
      : 'one row per source record';
    ajCube.meta.grain = grainParts;
    ajCube.meta.grain_description = `Each row represents one ${profiledTable.table} record, keyed by ${grainParts}.`;
    ajCube.meta.time_dimension = timeDim ? timeDim.name : null;
    ajCube.meta.time_zone = 'UTC';
    ajCube.meta.refresh_cadence = '1 hour';

    // - Drill members on count
    const countMeasure = ajCube.measures.find((m) => m.type === 'count');
    if (countMeasure && !countMeasure.drill_members) {
      const drillCandidates = ajCube.dimensions
        .filter((d) => d.type === 'string' && !d.name.includes('_id') && !d.name.includes('_gid') && d.public !== false)
        .slice(0, 5)
        .map((d) => d.name);
      if (drillCandidates.length > 0) countMeasure.drill_members = drillCandidates;
    }

    // - Format inference
    const CURRENCY_PATTERN = /^(revenue|tax|discount|cogs|commission|amount|fee|total|balance)$|_(price|cost|revenue|fee|amount)$/i;
    const PERCENT_PATTERN = /_(percentage|pct|ratio|rate)$/i;
    for (const meas of ajCube.measures) {
      if (meas.format) continue;
      if (CURRENCY_PATTERN.test(meas.name)) meas.format = 'currency';
      else if (PERCENT_PATTERN.test(meas.name)) meas.format = 'percent';
    }

    // - Public:false on plumbing
    const PLUMBING_PATTERN = /^(message_id|event_gid|anonymous_gid|session_gid|user_gid|write_key|ttl_days)$|_gid$/;
    for (const dim of ajCube.dimensions) {
      if (dim.public !== undefined) continue;
      if (PLUMBING_PATTERN.test(dim.name)) dim.public = false;
    }

    // - Pre-aggregations
    if (timeDim) {
      const preAggDimensions = ajCube.dimensions
        .filter((d) => d.type === 'string' && d.public !== false)
        .slice(0, 5)
        .map((d) => d.name);
      const preAggMeasures = ajCube.measures
        .filter((m) => ['count', 'sum', 'min', 'max'].includes(m.type))
        .slice(0, 10)
        .map((m) => m.name);
      if (preAggMeasures.length > 0) {
        ajCube.pre_aggregations = [
          {
            name: 'daily_rollup',
            type: 'rollup',
            dimensions: ['partition', ...preAggDimensions],
            measures: preAggMeasures,
            time_dimension: timeDim.name,
            granularity: 'day',
            partition_granularity: 'month',
            refresh_key: { every: '1 hour' },
            indexes: [{ name: 'partition_time_idx', columns: ['partition', timeDim.name] }],
          },
          {
            name: 'monthly_rollup',
            type: 'rollup',
            dimensions: ['partition'],
            measures: preAggMeasures.slice(0, 5),
            time_dimension: timeDim.name,
            granularity: 'month',
            partition_granularity: 'month',
            refresh_key: { every: '1 hour' },
            indexes: [{ name: 'partition_idx', columns: ['partition'] }],
          },
        ];
      }
    }

    cubes.push(ajCube);
  } else if (arrayJoinColumns.length > 0) {
    // Legacy ARRAY JOIN path: raw cube + separate flattened cubes
    cubes.push(rawCube);
    for (const ajDef of arrayJoinColumns) {
      const legacyCube = buildArrayJoinCube(profiledTable, [ajDef.column], rawCube, {
        ...options,
        nestedFilters: [],
      });
      legacyCube.name = sanitizeCubeName(`${profiledTable.table}_${ajDef.alias}`);
      const qualifiedTable = `${profiledTable.database}.${profiledTable.table}`;
      const isInternal = (options.internalTables || []).includes(profiledTable.table);
      let legacySql = `SELECT *, ${ajDef.column} AS ${ajDef.alias} FROM ${qualifiedTable} LEFT ARRAY JOIN ${ajDef.column} AS ${ajDef.alias}`;
      if (isInternal && options.partition) {
        legacySql += ` WHERE partition = '${options.partition}'`;
      }
      legacyCube.sql = legacySql;
      legacyCube.meta.array_join_column = ajDef.column;
      legacyCube.meta.array_join_alias = ajDef.alias;
      cubes.push(legacyCube);
    }
  } else {
    // No array join: just the raw cube
    cubes.push(rawCube);
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

// -- AI metric merging ------------------------------------------------------

/** Default model identifier used for AI metric attribution. */
const AI_MODEL = 'gpt-5.4';

/**
 * Merge validated AI-generated metrics into the first cube's
 * dimensions / measures arrays.
 *
 * Each AI metric receives full provenance metadata so consumers
 * can distinguish AI-generated fields from profiler-generated ones.
 *
 * Metrics whose names already exist in the target cube (across both
 * dimensions and measures) are silently skipped to preserve uniqueness.
 *
 * @param {object[]} cubes - Cube definition array from buildCubes()
 * @param {object[]} aiMetrics - Validated AI metrics, each with:
 *   { name, sql, type, fieldType, description, ai_generation_context, source_columns }
 * @returns {object[]} The same cubes array (mutated in-place)
 */
function mergeAIMetrics(cubes, aiMetrics) {
  if (!cubes || cubes.length === 0 || !aiMetrics || aiMetrics.length === 0) {
    return cubes;
  }

  const targetCube = cubes[0];

  // Build a set of all existing field names in the target cube
  const existingNames = new Set();
  for (const dim of targetCube.dimensions || []) {
    existingNames.add(dim.name);
  }
  for (const measure of targetCube.measures || []) {
    existingNames.add(measure.name);
  }

  for (const metric of aiMetrics) {
    // Skip if name already exists (across both dimensions and measures)
    if (existingNames.has(metric.name)) {
      continue;
    }

    const field = {
      name: metric.name,
      sql: metric.sql,
      type: metric.type,
      description: metric.description,
      meta: {
        ai_generated: true,
        ai_model: AI_MODEL,
        ai_generation_context: metric.ai_generation_context,
        ai_generated_at: new Date().toISOString(),
        source_columns: metric.source_columns || [],
      },
    };

    // Pass through advanced Cube.js properties
    if (metric.rollingWindow) field.rollingWindow = metric.rollingWindow;
    if (metric.multiStage) field.multiStage = true;
    if (metric.timeShift) field.timeShift = metric.timeShift;

    if (metric.fieldType === 'dimension') {
      if (!targetCube.dimensions) targetCube.dimensions = [];
      targetCube.dimensions.push(field);
    } else {
      if (!targetCube.measures) targetCube.measures = [];
      targetCube.measures.push(field);
    }

    existingNames.add(metric.name);
  }

  return cubes;
}
