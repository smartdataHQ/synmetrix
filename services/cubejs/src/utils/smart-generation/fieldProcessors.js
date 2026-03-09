/**
 * Field processing utilities for converting profiled ClickHouse columns
 * into Cube.js dimension/measure field definitions.
 *
 * Ported from Python prototype: cxs-inbox/cube/utils/field_processors.py
 */

import { ColumnType, ValueType } from './typeParser.js';

// -- Helpers ----------------------------------------------------------------

/**
 * Sanitize a column name so it is a valid Cube.js identifier.
 *
 * @param {string} name - Raw field name
 * @returns {string} Sanitized name
 */
export function sanitizeFieldName(name) {
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');

  if (sanitized.length > 0 && /^\d/.test(sanitized)) {
    sanitized = `field_${sanitized}`;
  }

  sanitized = sanitized.replace(/_+/g, '_');
  sanitized = sanitized.replace(/^_+|_+$/g, '');

  if (!sanitized) {
    sanitized = 'field';
  }

  return sanitized;
}

// -- CubeField factory ------------------------------------------------------

/**
 * Create a CubeField plain object.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.sql
 * @param {string} opts.type      - "string" | "number" | "time" | "boolean" | "sum"
 * @param {string} opts.fieldType - "dimension" | "measure"
 * @returns {{ name: string, sql: string, type: string, fieldType: string }}
 */
function cubeField({ name, sql, type, fieldType }) {
  return { name, sql, type, fieldType };
}

// -- Shared logic -----------------------------------------------------------

/**
 * Check whether an Int8 column is actually boolean (only 0/1 values)
 * or is used for small numbers (e.g., importance levels 1-5, age).
 *
 * @param {string} rawType - Column's raw ClickHouse type
 * @param {object|null} profile - Profiling data with min/max/lcValues
 * @returns {boolean} true if the column is genuinely boolean
 */
function isInt8Boolean(rawType, profile) {
  if (!(rawType || '').toLowerCase().includes('int8')) return false;
  if (!profile) return true; // assume boolean without profile data
  if (profile.maxValue != null && profile.maxValue > 1) return false;
  if (profile.minValue != null && profile.minValue < 0) return false;
  if (profile.lcValues && Array.isArray(profile.lcValues)) {
    for (const v of profile.lcValues) {
      const n = Number(v);
      if (!isNaN(n) && n !== 0 && n !== 1) return false;
    }
  }
  return true;
}

/** Coordinate column names that should always be dimensions, never summed. */
const COORDINATE_NAMES = /^(lat|latitude|lon|lng|longitude)$/i;

/**
 * Determine whether a column should be a dimension or measure.
 *
 * @param {object} columnDetails
 * @param {object|null} profile
 * @returns {string} "dimension" | "measure"
 */
function determineFieldType(columnDetails, profile) {
  // Coordinate columns are dimensions — summing lat/lon is meaningless
  const name = (columnDetails.childName || columnDetails.name || '').toLowerCase();
  if (COORDINATE_NAMES.test(name)) {
    return 'dimension';
  }

  const rawType = (columnDetails.rawType || '').toLowerCase();
  const hasInt8 = rawType.includes('int8');

  if (hasInt8) {
    // Int8 is boolean only if actual values are 0/1; otherwise it's a small number
    return isInt8Boolean(rawType, profile) ? 'dimension' : 'measure';
  }

  if (columnDetails.valueType === ValueType.NUMBER) {
    return 'measure';
  }

  return 'dimension';
}

/**
 * Map a profiled column to the appropriate Cube.js type string.
 *
 * @param {object} columnDetails
 * @param {object|null} profile
 * @returns {string}
 */
function getCubeType(columnDetails, profile) {
  const rawType = (columnDetails.rawType || '').toLowerCase();
  const hasInt8 = rawType.includes('int8');

  if (hasInt8) {
    return isInt8Boolean(rawType, profile) ? 'boolean' : 'number';
  }
  if (columnDetails.valueType === ValueType.NUMBER) {
    return 'number';
  }
  if (columnDetails.valueType === ValueType.DATE) {
    return 'time';
  }
  return 'string';
}

/**
 * Generate the SQL expression for a basic/nested column.
 *
 * @param {object} columnDetails
 * @param {object|null} profile
 * @returns {string}
 */
function generateSqlExpression(columnDetails, profile) {
  const columnName = columnDetails.name;

  if (columnDetails.valueType === ValueType.UUID) {
    return `toString({CUBE}.${columnName})`;
  }
  if (isInt8Boolean(columnDetails.rawType, profile)) {
    return `({CUBE}.${columnName}) = 1`;
  }
  return `{CUBE}.${columnName}`;
}

// -- Processors -------------------------------------------------------------

/**
 * Handles basic column types (string, number, date, UUID, boolean).
 */
export class BasicFieldProcessor {
  /**
   * @param {object} columnDetails
   * @param {object|null} profile
   * @returns {object|null} CubeField or null on error
   */
  process(columnDetails, profile) {
    try {
      const fieldType = determineFieldType(columnDetails, profile);
      const cubeType = fieldType === 'measure' ? 'sum' : getCubeType(columnDetails, profile);
      const sql = generateSqlExpression(columnDetails, profile);

      return cubeField({
        name: columnDetails.name,
        sql,
        type: cubeType,
        fieldType,
      });
    } catch {
      return null;
    }
  }
}

/**
 * Expands Map columns: one CubeField per unique key found during profiling.
 */
export class MapFieldProcessor {
  /**
   * @param {object} columnDetails
   * @param {object|null} profile
   * @returns {object[]} Array of CubeField objects
   */
  process(columnDetails, profile) {
    const fields = [];

    if (!profile || !profile.uniqueKeys || profile.uniqueKeys.length === 0) {
      return fields;
    }

    const columnName = columnDetails.name;
    const originalType = (columnDetails.rawType || '').toLowerCase();

    // Extract the value subtype from Map(KeyType, ValueType)
    let valueSubtype = originalType;
    const mapMatch = originalType.match(/map\s*\([^,]+,\s*([^)]+)\)/);
    if (mapMatch) {
      valueSubtype = mapMatch[1].trim();
    }

    // Use valueDataType (the Map's declared value type) for classification.
    // valueType is always OTHER for Map columns; valueDataType holds the actual type.
    const effectiveValueType = columnDetails.valueDataType || columnDetails.valueType;

    for (const key of profile.uniqueKeys) {
      try {
        const sanitizedKey = sanitizeFieldName(key);
        const fieldName = `${columnName}_${sanitizedKey}`;
        let field;

        if (effectiveValueType === ValueType.NUMBER) {
          // Int8 inside numeric map value -> boolean dimension
          if (valueSubtype.includes('int8')) {
            field = cubeField({
              name: fieldName,
              sql: `({CUBE}.${columnName}['${key}']) = 1`,
              type: 'boolean',
              fieldType: 'dimension',
            });
            field._mapKey = key;
            fields.push(field);
            continue;
          }

          // Determine cast target based on value subtype
          let castTarget = 'Float64';
          if (valueSubtype.includes('uint')) {
            castTarget = 'UInt64';
          } else if (valueSubtype.includes('int')) {
            castTarget = 'Int64';
          }
          // float / decimal / double -> Float64 (default)

          field = cubeField({
            name: fieldName,
            sql: `CAST({CUBE}.${columnName}['${key}'] AS ${castTarget})`,
            type: 'sum',
            fieldType: 'measure',
          });
        } else if (effectiveValueType === ValueType.BOOLEAN) {
          let boolSql;
          if (valueSubtype.includes('bool') || valueSubtype.includes('boolean')) {
            boolSql = `{CUBE}.${columnName}['${key}']`;
          } else if (valueSubtype.includes('int8') || valueSubtype.includes('uint8')) {
            boolSql = `({CUBE}.${columnName}['${key}']) = 1`;
          } else {
            boolSql = `{CUBE}.${columnName}['${key}']`;
          }

          field = cubeField({
            name: fieldName,
            sql: boolSql,
            type: 'boolean',
            fieldType: 'dimension',
          });
        } else {
          // STRING / OTHER -> string dimension
          field = cubeField({
            name: fieldName,
            sql: `{CUBE}.${columnName}['${key}']`,
            type: 'string',
            fieldType: 'dimension',
          });
        }

        field._mapKey = key;
        fields.push(field);
      } catch {
        // Skip keys that fail processing
        continue;
      }
    }

    return fields;
  }
}

/**
 * Handles Array columns — produces a single toString() dimension.
 */
export class ArrayFieldProcessor {
  /**
   * @param {string[]} [arrayJoinColumns=[]] - Column names eligible for ARRAY JOIN
   */
  constructor(arrayJoinColumns = []) {
    this.arrayJoinColumns = arrayJoinColumns;
  }

  /**
   * Check if a column should use ARRAY JOIN.
   * @param {string} columnName
   * @returns {boolean}
   */
  shouldUseArrayJoin(columnName) {
    if (!this.arrayJoinColumns || this.arrayJoinColumns.length === 0) {
      return false;
    }
    for (const configured of this.arrayJoinColumns) {
      if (configured === columnName) return true;
      if (!configured.includes('.') && columnName.startsWith(configured + '.')) return true;
    }
    return false;
  }

  /**
   * @param {object} columnDetails
   * @param {object|null} _profile
   * @returns {object|null} CubeField
   */
  process(columnDetails, _profile) {
    const columnName = columnDetails.name;

    if (this.shouldUseArrayJoin(columnName)) {
      const alias = this._generateArrayJoinAlias(columnName);
      return cubeField({
        name: alias,
        sql: alias,
        type: 'string',
        fieldType: 'dimension',
      });
    }

    return cubeField({
      name: columnName,
      sql: `toString(${columnName})`,
      type: 'string',
      fieldType: 'dimension',
    });
  }

  /**
   * Generate a consistent alias for ARRAY JOIN columns.
   * @param {string} columnName
   * @returns {string}
   */
  _generateArrayJoinAlias(columnName) {
    if (columnName.includes('.')) {
      return columnName.split('.').join('_') + '_item';
    }
    return `${columnName}_item`;
  }
}

/**
 * Handles dotted/grouped (nested) columns — creates a prefixed field using
 * the parent name and child name.
 */
export class NestedFieldProcessor {
  /**
   * @param {object} columnDetails
   * @param {object|null} profile
   * @returns {object|null} CubeField
   */
  process(columnDetails, profile) {
    try {
      const parentName = columnDetails.parentName || '';
      const childName = columnDetails.childName || columnDetails.name;

      const fieldName = parentName
        ? `${sanitizeFieldName(parentName)}_${sanitizeFieldName(childName)}`
        : sanitizeFieldName(childName);

      const fieldType = determineFieldType(columnDetails, profile);
      const cubeType = fieldType === 'measure' ? 'sum' : getCubeType(columnDetails, profile);
      const sql = generateSqlExpression(columnDetails, profile);

      return cubeField({
        name: fieldName,
        sql,
        type: cubeType,
        fieldType,
      });
    } catch {
      return null;
    }
  }
}

// -- Factory ----------------------------------------------------------------

/**
 * Returns the appropriate processor for a given column type.
 *
 * @param {string} columnType - One of ColumnType values
 * @param {object} [options]
 * @param {string[]} [options.arrayJoinColumns]
 * @returns {BasicFieldProcessor|MapFieldProcessor|ArrayFieldProcessor|NestedFieldProcessor}
 */
export function FieldProcessorFactory(columnType, options = {}) {
  switch (columnType) {
    case ColumnType.MAP:
      return new MapFieldProcessor();
    case ColumnType.ARRAY:
      return new ArrayFieldProcessor(options.arrayJoinColumns);
    case ColumnType.NESTED:
    case ColumnType.GROUPED:
      return new NestedFieldProcessor();
    default:
      return new BasicFieldProcessor();
  }
}

// -- Main entry point -------------------------------------------------------

/**
 * Process a single profiled column into one or more CubeField objects.
 *
 * @param {object} columnDetails
 *   @param {string} columnDetails.name       - Column name
 *   @param {string} columnDetails.rawType    - Original ClickHouse type string
 *   @param {string} columnDetails.columnType - ColumnType value ("Basic", "Map", etc.)
 *   @param {string} columnDetails.valueType  - ValueType value ("String", "Number", etc.)
 *   @param {boolean} columnDetails.isNullable
 *   @param {string} [columnDetails.parentName]
 *   @param {string} [columnDetails.childName]
 * @param {object|null} profile
 *   @param {boolean} profile.hasValues
 *   @param {*[]}    profile.uniqueValues
 *   @param {string[]} profile.uniqueKeys
 *   @param {*[]}    profile.lcValues
 * @param {object}  [options]
 *   @param {string[]} [options.arrayJoinColumns]
 * @returns {object[]} Array of CubeField objects
 */
export function processColumn(columnDetails, profile, options = {}) {
  const processor = FieldProcessorFactory(columnDetails.columnType, options);
  const result = processor.process(columnDetails, profile);

  if (result === null || result === undefined) {
    return [];
  }

  // MapFieldProcessor returns an array; others return a single object
  return Array.isArray(result) ? result : [result];
}
