/**
 * YAML generator for Cube.js data model definitions.
 *
 * Serializes cube definition objects (from cubeBuilder) into
 * Cube.js-compatible YAML strings.
 */

import YAML from 'yaml';

/**
 * Check if any cube definition contains FILTER_PARAMS callbacks
 * that require JS output (YAML parser can't handle arrow functions).
 *
 * @param {object[]} cubeDefinitions
 * @returns {boolean}
 */
export function requiresJsOutput(cubeDefinitions) {
  for (const cube of cubeDefinitions) {
    for (const field of [...(cube.dimensions || []), ...(cube.measures || [])]) {
      if (field.sql && field.sql.includes('FILTER_PARAMS')) return true;
    }
  }
  return false;
}

/**
 * Generate a file name for a cube model file.
 *
 * @param {string} tableName - Source table name
 * @param {boolean} [js=true] - Use .js extension (default) or .yml
 * @returns {string} File name
 */
export function generateFileName(tableName, js = true) {
  return `${tableName}.${js ? 'js' : 'yml'}`;
}

/**
 * Convert a CubeField object into a YAML-ready dimension/measure entry.
 *
 * @param {object} field - { name, sql, type }
 * @returns {object} YAML-ready field object
 */
function formatField(field) {
  const meta = {
    ...field.meta,
  };

  // AI-generated fields keep their own metadata — don't stamp auto_generated
  if (!meta.ai_generated) {
    meta.auto_generated = true;
  }

  const entry = {
    name: field.name,
    sql: field.sql,
    type: field.type,
    meta,
  };

  // Pass through advanced Cube.js measure properties
  if (field.rollingWindow) entry.rollingWindow = field.rollingWindow;
  if (field.multiStage) entry.multiStage = true;
  if (field.timeShift) entry.timeShift = field.timeShift;

  if (field.primary_key) {
    entry.primary_key = true;
    entry.public = true;
  }

  // Serialise new cubeBuilder properties
  if (field.title) entry.title = field.title;
  if (field.description) entry.description = field.description;
  if (field.public === false) entry.public = false;
  if (field.format) entry.format = field.format;
  if (field.drill_members && field.drill_members.length > 0) entry.drill_members = field.drill_members;
  if (field.filters && field.filters.length > 0) entry.filters = field.filters;

  return entry;
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

  // Cube-level properties from cubeBuilder
  if (cube.title) entry.title = cube.title;
  if (cube.description) entry.description = cube.description;
  if (cube.pre_aggregations && cube.pre_aggregations.length > 0) {
    entry.pre_aggregations = cube.pre_aggregations;
  }
  if (cube.segments && cube.segments.length > 0) {
    entry.segments = cube.segments.map(formatField);
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

// -- JS generator (for cubes with FILTER_PARAMS callbacks) ------------------

/**
 * Escape a string for use inside a JS template literal.
 * @param {string} str
 * @returns {string}
 */
function escapeTemplateLiteral(str) {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

/**
 * Convert a sql expression from YAML syntax ({FILTER_PARAMS...}, {CUBE})
 * to JS template literal syntax (${FILTER_PARAMS...}, ${CUBE}).
 *
 * @param {string} sql
 * @returns {string}
 */
function sqlToJsTemplate(sql) {
  // First escape backticks for the template literal
  let js = escapeTemplateLiteral(sql);
  // Convert all {…} Cube.js template vars to ${…} in one pass.
  // Handles {CUBE}, {CUBE}.col, {FILTER_PARAMS.…}, and {measure_name}.
  // Uses a negative lookbehind to skip already-converted ${…} patterns.
  js = js.replace(/(?<!\$)\{([^}]+)\}/g, '${$1}');
  return js;
}

/**
 * Serialize a meta object as a JS object literal string.
 * @param {object} meta
 * @param {number} indent - base indentation level
 * @returns {string}
 */
function metaToJs(meta, indent) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  const lines = [`${pad}meta: {`];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      lines.push(`${inner}${key}: ${JSON.stringify(value)},`);
    } else if (typeof value === 'string') {
      lines.push(`${inner}${key}: ${JSON.stringify(value)},`);
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${inner}${key}: ${value},`);
    } else if (value && typeof value === 'object') {
      lines.push(`${inner}${key}: ${JSON.stringify(value)},`);
    }
  }
  lines.push(`${pad}},`);
  return lines.join('\n');
}

/**
 * Generate a Cube.js JavaScript model string from cube definitions.
 * Used when cubes contain FILTER_PARAMS callbacks that YAML can't parse.
 *
 * @param {object[]} cubeDefinitions - Array of cube definition objects
 * @returns {string} JavaScript model string
 */
export function generateJs(cubeDefinitions) {
  const parts = [];

  for (const cube of cubeDefinitions) {
    const formatted = formatCube(cube);
    const lines = [];

    lines.push(`cube(\`${formatted.name}\`, {`);

    // Source
    if (formatted.sql_table) {
      lines.push(`  sql_table: \`${escapeTemplateLiteral(formatted.sql_table)}\`,`);
    } else if (formatted.sql) {
      lines.push(`  sql: \`${sqlToJsTemplate(formatted.sql)}\`,`);
    }

    // Cube-level scalar properties
    if (formatted.title) {
      lines.push(`  title: ${JSON.stringify(formatted.title)},`);
    }
    if (formatted.description) {
      lines.push(`  description: ${JSON.stringify(formatted.description)},`);
    }

    // Cube-level meta
    if (formatted.meta) {
      lines.push('');
      lines.push(metaToJs(formatted.meta, 2));
    }

    // Dimensions
    if (formatted.dimensions && formatted.dimensions.length > 0) {
      lines.push('');
      lines.push('  dimensions: {');
      for (const dim of formatted.dimensions) {
        lines.push(`    ${dim.name}: {`);
        lines.push(`      sql: \`${sqlToJsTemplate(dim.sql)}\`,`);
        lines.push(`      type: \`${dim.type}\`,`);
        if (dim.description) {
          lines.push(`      description: ${JSON.stringify(dim.description)},`);
        }
        if (dim.primary_key) {
          lines.push('      primary_key: true,');
          lines.push('      public: true,');
        }
        if (dim.title) {
          lines.push(`      title: ${JSON.stringify(dim.title)},`);
        }
        if (dim.public === false) {
          lines.push('      public: false,');
        }
        if (dim.format) {
          lines.push(`      format: ${JSON.stringify(dim.format)},`);
        }
        if (dim.drill_members && dim.drill_members.length > 0) {
          lines.push(`      drill_members: ${JSON.stringify(dim.drill_members)},`);
        }
        if (dim.filters && dim.filters.length > 0) {
          lines.push(`      filters: ${JSON.stringify(dim.filters)},`);
        }
        if (dim.meta) {
          lines.push(metaToJs(dim.meta, 6));
        }
        lines.push('    },');
      }
      lines.push('  },');
    }

    // Measures
    if (formatted.measures && formatted.measures.length > 0) {
      lines.push('');
      lines.push('  measures: {');
      for (const m of formatted.measures) {
        lines.push(`    ${m.name}: {`);
        lines.push(`      sql: \`${sqlToJsTemplate(m.sql)}\`,`);
        lines.push(`      type: \`${m.type}\`,`);
        if (m.description) {
          lines.push(`      description: ${JSON.stringify(m.description)},`);
        }
        if (m.multiStage) {
          lines.push('      multiStage: true,');
        }
        if (m.rollingWindow) {
          const rwParts = [];
          rwParts.push(`type: '${m.rollingWindow.type}'`);
          if (m.rollingWindow.granularity) rwParts.push(`granularity: '${m.rollingWindow.granularity}'`);
          if (m.rollingWindow.trailing) rwParts.push(`trailing: '${m.rollingWindow.trailing}'`);
          if (m.rollingWindow.leading) rwParts.push(`leading: '${m.rollingWindow.leading}'`);
          if (m.rollingWindow.offset) rwParts.push(`offset: '${m.rollingWindow.offset}'`);
          lines.push(`      rollingWindow: { ${rwParts.join(', ')} },`);
        }
        if (m.timeShift && Array.isArray(m.timeShift)) {
          const items = m.timeShift.map((ts) => `{ interval: '${ts.interval}', type: '${ts.type}' }`);
          lines.push(`      timeShift: [${items.join(', ')}],`);
        }
        if (m.title) {
          lines.push(`      title: ${JSON.stringify(m.title)},`);
        }
        if (m.public === false) {
          lines.push('      public: false,');
        }
        if (m.format) {
          lines.push(`      format: ${JSON.stringify(m.format)},`);
        }
        if (m.drill_members && m.drill_members.length > 0) {
          lines.push(`      drill_members: ${JSON.stringify(m.drill_members)},`);
        }
        if (m.filters && m.filters.length > 0) {
          lines.push(`      filters: ${JSON.stringify(m.filters)},`);
        }
        if (m.meta) {
          lines.push(metaToJs(m.meta, 6));
        }
        lines.push('    },');
      }
      lines.push('  },');
    }

    // Segments
    if (formatted.segments && formatted.segments.length > 0) {
      lines.push('');
      lines.push('  segments: {');
      for (const seg of formatted.segments) {
        lines.push(`    ${seg.name}: {`);
        lines.push(`      sql: \`${sqlToJsTemplate(seg.sql)}\`,`);
        if (seg.title) {
          lines.push(`      title: ${JSON.stringify(seg.title)},`);
        }
        if (seg.description) {
          lines.push(`      description: ${JSON.stringify(seg.description)},`);
        }
        if (seg.meta) {
          lines.push(metaToJs(seg.meta, 6));
        }
        lines.push('    },');
      }
      lines.push('  },');
    }

    // Pre-aggregations — Cube.js uses named object keys, not arrays
    if (formatted.pre_aggregations && formatted.pre_aggregations.length > 0) {
      lines.push('');
      lines.push('  pre_aggregations: {');
      for (const pa of formatted.pre_aggregations) {
        const paName = pa.name || 'rollup';
        lines.push(`    ${paName}: {`);
        if (pa.type) lines.push(`      type: \`${pa.type}\`,`);
        if (pa.measures && pa.measures.length > 0) {
          lines.push(`      measures: [${pa.measures.map((m) => `CUBE.${m}`).join(', ')}],`);
        }
        if (pa.dimensions && pa.dimensions.length > 0) {
          lines.push(`      dimensions: [${pa.dimensions.map((d) => `CUBE.${d}`).join(', ')}],`);
        }
        if (pa.time_dimension) lines.push(`      time_dimension: CUBE.${pa.time_dimension},`);
        if (pa.granularity) lines.push(`      granularity: \`${pa.granularity}\`,`);
        if (pa.refresh_key) {
          if (pa.refresh_key.every) lines.push(`      refresh_key: { every: \`${pa.refresh_key.every}\` },`);
        }
        if (pa.build_range_start?.sql) lines.push(`      build_range_start: { sql: \`${pa.build_range_start.sql}\` },`);
        if (pa.build_range_end?.sql) lines.push(`      build_range_end: { sql: \`${pa.build_range_end.sql}\` },`);
        // Indexes as named objects: { idx_name: { columns: [CUBE.col, ...] } }
        if (pa.indexes && pa.indexes.length > 0) {
          lines.push('      indexes: {');
          for (const idx of pa.indexes) {
            const idxName = idx.name || 'main_idx';
            const cols = (idx.columns || []).map((c) => `CUBE.${c}`).join(', ');
            lines.push(`        ${idxName}: { columns: [${cols}] },`);
          }
          lines.push('      },');
        }
        lines.push('    },');
      }
      lines.push('  },');
    }

    lines.push('});');
    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n');
}
