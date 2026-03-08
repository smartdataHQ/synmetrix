/**
 * YAML generator for Cube.js data model definitions.
 *
 * Serializes cube definition objects (from cubeBuilder) into
 * Cube.js-compatible YAML strings.
 */

import YAML from 'yaml';

/**
 * Generate a file name for a cube YAML file.
 *
 * @param {string} tableName - Source table name
 * @returns {string} File name with .yml extension
 */
export function generateFileName(tableName) {
  return `${tableName}.yml`;
}

/**
 * Convert a CubeField object into a YAML-ready dimension/measure entry.
 *
 * @param {object} field - { name, sql, type }
 * @returns {object} YAML-ready field object
 */
function formatField(field) {
  return {
    name: field.name,
    sql: field.sql,
    type: field.type,
    meta: {
      auto_generated: true,
    },
  };
}

/**
 * Convert a cube definition object into a YAML-ready cube entry.
 *
 * @param {object} cube - Cube definition from cubeBuilder
 * @param {string} cube.name - Cube name
 * @param {string} [cube.sql_table] - SQL table reference
 * @param {string} [cube.sql] - Custom SQL query
 * @param {object} [cube.meta] - Cube-level metadata
 * @param {object[]} [cube.dimensions] - Dimension field objects
 * @param {object[]} [cube.measures] - Measure field objects
 * @returns {object} YAML-ready cube object
 */
function formatCube(cube) {
  const entry = { name: cube.name };

  if (cube.sql_table) {
    entry.sql_table = cube.sql_table;
  } else if (cube.sql) {
    entry.sql = cube.sql;
  }

  entry.meta = {
    auto_generated: true,
    ...cube.meta,
  };

  const dimensions = (cube.dimensions || []).map(formatField);
  const measures = (cube.measures || []).map(formatField);

  if (dimensions.length > 0) {
    entry.dimensions = dimensions;
  }

  if (measures.length > 0) {
    entry.measures = measures;
  }

  return entry;
}

/**
 * Generate a Cube.js-compatible YAML string from cube definitions.
 *
 * @param {object[]} cubeDefinitions - Array of cube definition objects
 * @returns {string} YAML string
 */
export function generateYaml(cubeDefinitions) {
  const doc = {
    cubes: cubeDefinitions.map(formatCube),
  };

  return YAML.stringify(doc, { lineWidth: 0 });
}
