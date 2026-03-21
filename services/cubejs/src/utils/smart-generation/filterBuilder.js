/**
 * Filter builder — constructs validated SQL WHERE clauses from an array
 * of filter descriptors.
 *
 * Used by the smart-generation pipeline to apply user-specified filters
 * when profiling or querying ClickHouse tables.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILTERS = 10;

const SUPPORTED_OPERATORS = new Set([
  '=', '!=', '>', '>=', '<', '<=',
  'IN', 'NOT IN',
  'LIKE',
  'IS NULL', 'IS NOT NULL',
]);

const UNARY_OPERATORS = new Set(['IS NULL', 'IS NOT NULL']);

// ---------------------------------------------------------------------------
// Value coercion helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string value for safe SQL interpolation.
 * Single quotes are doubled: O'Brien → 'O''Brien'.
 *
 * @param {string} val
 * @returns {string} Single-quoted escaped string
 */
function escapeString(val) {
  return `'${String(val).replace(/'/g, "''")}'`;
}

/**
 * Coerce a single value to its SQL literal representation.
 *
 * @param {*} val
 * @returns {string}
 */
function coerceValue(val) {
  if (typeof val === 'boolean') {
    return val ? '1' : '0';
  }

  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new Error(`Invalid numeric filter value: ${val}`);
    }
    return String(val);
  }

  // Attempt numeric coercion for string-encoded numbers
  if (typeof val === 'string') {
    const num = Number(val);
    if (val !== '' && Number.isFinite(num) && String(num) === val) {
      return val;
    }
    // String (including ISO date strings) — quote it
    return escapeString(val);
  }

  return escapeString(String(val));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a SQL WHERE clause string from an array of filter descriptors.
 *
 * @param {Array<{ column: string, operator: string, value: * }>} filters
 * @param {string[]} tableColumns - Valid column names for the target table
 * @returns {string} SQL WHERE clause with leading ` WHERE `, or empty string
 */
export function buildFilterWhereClause(filters, tableColumns) {
  if (!filters || !Array.isArray(filters) || filters.length === 0) {
    return '';
  }

  if (filters.length > MAX_FILTERS) {
    throw new Error(
      `Too many filters: ${filters.length} exceeds maximum of ${MAX_FILTERS}`
    );
  }

  const columnSet = new Set(tableColumns);
  const conditions = [];

  for (const filter of filters) {
    const { column, operator, value } = filter;

    // -- Column validation --------------------------------------------------
    if (!columnSet.has(column)) {
      throw new Error(
        `Invalid filter column "${column}". ` +
        `Valid columns: ${tableColumns.join(', ')}`
      );
    }

    // -- Operator validation ------------------------------------------------
    const op = String(operator).toUpperCase();
    if (!SUPPORTED_OPERATORS.has(op)) {
      throw new Error(
        `Unsupported filter operator "${operator}". ` +
        `Supported: ${[...SUPPORTED_OPERATORS].join(', ')}`
      );
    }

    // -- Unary operators (IS NULL / IS NOT NULL) ----------------------------
    if (UNARY_OPERATORS.has(op)) {
      conditions.push(`${column} ${op}`);
      continue;
    }

    // -- IN / NOT IN --------------------------------------------------------
    if (op === 'IN' || op === 'NOT IN') {
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error(
          `Operator ${op} requires a non-empty array value for column "${column}"`
        );
      }
      const items = value.map(coerceValue).join(', ');
      conditions.push(`${column} ${op} (${items})`);
      continue;
    }

    // -- Binary comparison / LIKE -------------------------------------------
    conditions.push(`${column} ${op} ${coerceValue(value)}`);
  }

  return ` WHERE ${conditions.join(' AND ')}`;
}
