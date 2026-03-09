/**
 * ClickHouse type parser — converts raw ClickHouse type strings into
 * structured type information for Cube.js model generation.
 */

export const ColumnType = Object.freeze({
  BASIC: 'BASIC',
  ARRAY: 'ARRAY',
  MAP: 'MAP',
  NESTED: 'NESTED',
  GROUPED: 'GROUPED',
});

export const ValueType = Object.freeze({
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  DATE: 'DATE',
  UUID: 'UUID',
  BOOLEAN: 'BOOLEAN',
  OTHER: 'OTHER',
});

/**
 * Map a base ClickHouse type name to a ValueType.
 *
 * @param {string} baseType  The unwrapped type name (e.g. "String", "UInt32").
 * @returns {string} One of the ValueType constants.
 */
export function resolveValueType(baseType) {
  if (!baseType) return ValueType.OTHER;

  const t = baseType.trim();

  if (t === 'UUID') return ValueType.UUID;
  if (t === 'Bool') return ValueType.BOOLEAN;
  if (t === 'Int8') return ValueType.BOOLEAN;

  if (
    t === 'String' ||
    t.startsWith('FixedString') ||
    t.startsWith('Enum8') ||
    t.startsWith('Enum16') ||
    t === 'Enum' ||
    t === 'IPv4' ||
    t === 'IPv6'
  ) {
    return ValueType.STRING;
  }

  if (
    /^(U?Int)(8|16|32|64|128|256)$/.test(t) ||
    /^Float(32|64)$/.test(t) ||
    t.startsWith('Decimal')
  ) {
    return ValueType.NUMBER;
  }

  if (
    t === 'Date' ||
    t === 'Date32' ||
    t.startsWith('DateTime64') ||
    t.startsWith('DateTime')
  ) {
    return ValueType.DATE;
  }

  return ValueType.OTHER;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip one layer of `Wrapper(...)` from a type string.
 * Returns `{ found, inner }` where `found` is true when the wrapper was
 * present and `inner` is the content between the parentheses.
 */
function stripWrapper(typeStr, wrapperName) {
  const prefix = `${wrapperName}(`;
  if (typeStr.startsWith(prefix) && typeStr.endsWith(')')) {
    return { found: true, inner: typeStr.slice(prefix.length, -1) };
  }
  return { found: false, inner: typeStr };
}

/**
 * Recursively peel LowCardinality / Nullable wrappers and track nullability.
 *
 * @param {string} typeStr
 * @returns {{ inner: string, isNullable: boolean }}
 */
function unwrapAnnotations(typeStr) {
  let current = typeStr.trim();
  let isNullable = false;
  let changed = true;

  while (changed) {
    changed = false;

    const lc = stripWrapper(current, 'LowCardinality');
    if (lc.found) {
      current = lc.inner.trim();
      changed = true;
    }

    const nl = stripWrapper(current, 'Nullable');
    if (nl.found) {
      current = nl.inner.trim();
      isNullable = true;
      changed = true;
    }
  }

  return { inner: current, isNullable };
}

/**
 * Split a top-level comma-separated parameter list, respecting nested
 * parentheses so that `Map(LowCardinality(String), Nullable(Float64))`
 * correctly yields `["LowCardinality(String)", "Nullable(Float64)"]`.
 *
 * @param {string} str  The content between the outermost parentheses.
 * @returns {string[]}
 */
function splitTopLevelArgs(str) {
  const args = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      args.push(str.slice(start, i).trim());
      start = i + 1;
    }
  }

  args.push(str.slice(start).trim());
  return args;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a ClickHouse column type string into structured type information.
 *
 * @param {string} rawType     The raw ClickHouse type (e.g. "LowCardinality(Nullable(String))").
 * @param {string} columnName  The column name — used to detect grouped (dotted) columns.
 * @returns {{
 *   rawType: string,
 *   columnType: string,
 *   valueType: string,
 *   isNullable: boolean,
 *   keyDataType: string|null,
 *   valueDataType: string|null,
 *   parentName: string|null,
 *   childName: string|null,
 *   innerType: string,
 * }}
 */
export function parseType(rawType, columnName) {
  const result = {
    rawType,
    columnType: ColumnType.BASIC,
    valueType: ValueType.OTHER,
    isNullable: false,
    keyDataType: null,
    valueDataType: null,
    parentName: null,
    childName: null,
    innerType: '',
  };

  // --- Detect grouped (dotted) column names ---
  if (columnName && columnName.includes('.')) {
    const dotIdx = columnName.indexOf('.');
    result.columnType = ColumnType.GROUPED;
    result.parentName = columnName.slice(0, dotIdx);
    result.childName = columnName.slice(dotIdx + 1);
  }

  // --- Unwrap annotation wrappers ---
  const { inner: unwrapped, isNullable } = unwrapAnnotations(rawType);
  result.isNullable = isNullable;

  // --- Nested type (ClickHouse legacy Nested(...)) ---
  const nested = stripWrapper(unwrapped, 'Nested');
  if (nested.found) {
    result.columnType = ColumnType.NESTED;
    result.innerType = nested.inner.trim();
    result.valueType = ValueType.OTHER;
    return result;
  }

  // --- Array type ---
  const arr = stripWrapper(unwrapped, 'Array');
  if (arr.found) {
    if (result.columnType !== ColumnType.GROUPED) {
      result.columnType = ColumnType.ARRAY;
    }
    // Resolve element value type through any nested wrappers
    const { inner: elemInner } = unwrapAnnotations(arr.inner);
    result.innerType = elemInner;
    result.valueType = resolveValueType(elemInner);
    return result;
  }

  // --- Map type ---
  const map = stripWrapper(unwrapped, 'Map');
  if (map.found) {
    if (result.columnType !== ColumnType.GROUPED) {
      result.columnType = ColumnType.MAP;
    }
    const args = splitTopLevelArgs(map.inner);
    if (args.length >= 2) {
      const { inner: keyInner } = unwrapAnnotations(args[0]);
      const { inner: valInner } = unwrapAnnotations(args[1]);
      result.keyDataType = resolveValueType(keyInner);
      result.valueDataType = resolveValueType(valInner);
      result.innerType = unwrapped; // preserve full Map(...) as inner
    }
    result.valueType = ValueType.OTHER;
    return result;
  }

  // --- Basic / scalar type ---
  result.innerType = unwrapped;
  result.valueType = resolveValueType(unwrapped);
  return result;
}
