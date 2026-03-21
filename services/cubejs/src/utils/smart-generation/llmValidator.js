/**
 * LLM validator — validates AI-generated metrics before they are merged
 * into a Cube.js model definition.
 *
 * Each metric is checked independently. Metrics that fail any check are
 * placed in the rejected list with reason strings.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DANGEROUS_KEYWORDS = [
  'DROP', 'DELETE', 'INSERT', 'ALTER', 'TRUNCATE', 'UPDATE', 'CREATE', 'EXEC',
];

const DANGEROUS_REGEX = new RegExp(
  `\\b(${DANGEROUS_KEYWORDS.join('|')})\\b`,
  'i'
);

const ALLOWED_TEMPLATE_PREFIXES = ['CUBE', 'FILTER_PARAMS'];

const VALID_MEASURE_TYPES = new Set([
  'number', 'numberAgg', 'rank', 'sum', 'avg', 'count', 'countDistinct', 'countDistinctApprox',
  'min', 'max', 'runningTotal', 'string', 'boolean', 'time',
]);

const VALID_DIMENSION_TYPES = new Set([
  'string', 'number', 'time', 'boolean',
]);

const TIME_INTERVAL_REGEX = /^(-?\d+) (minute|hour|day|week|month|quarter|year)s?$/;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Check that parentheses and backticks are balanced.
 *
 * @param {string} sql
 * @returns {string[]} Array of reason strings (empty if OK)
 */
function checkBalanced(sql) {
  const reasons = [];

  let parens = 0;
  for (const ch of sql) {
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    if (parens < 0) break;
  }
  if (parens !== 0) {
    reasons.push('Unbalanced parentheses in SQL');
  }

  const backticks = (sql.match(/`/g) || []).length;
  if (backticks % 2 !== 0) {
    reasons.push('Unbalanced backticks in SQL');
  }

  return reasons;
}

/**
 * Check for dangerous SQL keywords.
 *
 * @param {string} sql
 * @returns {string[]}
 */
function checkDangerousKeywords(sql) {
  if (DANGEROUS_REGEX.test(sql)) {
    const matched = sql.match(new RegExp(`\\b(${DANGEROUS_KEYWORDS.join('|')})\\b`, 'gi'));
    return [`Dangerous SQL keyword(s) detected: ${[...new Set(matched)].join(', ')}`];
  }
  return [];
}

/**
 * Validate template variables — {CUBE}, {FILTER_PARAMS...}, and
 * {measure_name} (when the measure exists) are allowed.
 *
 * @param {string} sql
 * @param {Set<string>} [existingMeasureSet] - Set of known measure names
 * @returns {string[]}
 */
function checkTemplateVars(sql, existingMeasureSet) {
  const reasons = [];
  const templatePattern = /\{([^}]+)\}/g;
  let match;

  while ((match = templatePattern.exec(sql)) !== null) {
    const inner = match[1];
    const isAllowed = ALLOWED_TEMPLATE_PREFIXES.some(
      (prefix) => inner === prefix || inner.startsWith(`${prefix}.`) || inner.startsWith(`${prefix} `)
    );
    if (isAllowed) continue;

    // Allow {measure_name} references when the measure exists
    if (existingMeasureSet && existingMeasureSet.has(inner)) continue;

    reasons.push(`Invalid template variable: {${inner}}`);
  }

  return reasons;
}

/**
 * Validate metric type against allowed Cube.js types.
 *
 * @param {string} type
 * @param {string} fieldType
 * @returns {string[]}
 */
function checkType(type, fieldType) {
  if (fieldType === 'measure') {
    if (!VALID_MEASURE_TYPES.has(type)) {
      return [`Invalid measure type "${type}". Valid: ${[...VALID_MEASURE_TYPES].join(', ')}`];
    }
  } else if (fieldType === 'dimension') {
    if (!VALID_DIMENSION_TYPES.has(type)) {
      return [`Invalid dimension type "${type}". Valid: ${[...VALID_DIMENSION_TYPES].join(', ')}`];
    }
  } else {
    return [`Invalid fieldType "${fieldType}". Must be "measure" or "dimension"`];
  }
  return [];
}

/**
 * Validate {CUBE}.column_name references against actual table columns.
 *
 * @param {string} sql
 * @param {string[]} profiledTableColumns
 * @returns {string[]}
 */
function checkColumnReferences(sql, profiledTableColumns) {
  const reasons = [];
  const columnSet = new Set(profiledTableColumns);
  const refPattern = /\{CUBE\}\.(\w+)/g;
  let match;

  while ((match = refPattern.exec(sql)) !== null) {
    const colName = match[1];
    if (!columnSet.has(colName)) {
      reasons.push(`Hallucinated column reference: {CUBE}.${colName}`);
    }
  }

  return reasons;
}

/**
 * Validate source_columns entries against actual table columns.
 *
 * @param {string[]} sourceColumns
 * @param {string[]} profiledTableColumns
 * @returns {string[]}
 */
function checkSourceColumns(sourceColumns, profiledTableColumns) {
  if (!Array.isArray(sourceColumns)) return [];

  const columnSet = new Set(profiledTableColumns);
  const invalid = sourceColumns.filter((col) => !columnSet.has(col));

  if (invalid.length > 0) {
    return [`Invalid source_columns: ${invalid.join(', ')}`];
  }
  return [];
}

/**
 * Validate rollingWindow property.
 *
 * @param {object} rollingWindow
 * @returns {string[]}
 */
function checkRollingWindow(rollingWindow) {
  if (!rollingWindow) return [];
  const reasons = [];

  if (!['to_date', 'fixed'].includes(rollingWindow.type)) {
    reasons.push(`Invalid rollingWindow.type "${rollingWindow.type}". Must be "to_date" or "fixed"`);
    return reasons;
  }

  if (rollingWindow.type === 'to_date') {
    if (rollingWindow.granularity && !['year', 'quarter', 'month'].includes(rollingWindow.granularity)) {
      reasons.push(`Invalid rollingWindow.granularity "${rollingWindow.granularity}". Must be "year", "quarter", or "month"`);
    }
  }

  if (rollingWindow.type === 'fixed') {
    if (rollingWindow.trailing && !TIME_INTERVAL_REGEX.test(rollingWindow.trailing)) {
      reasons.push(`Invalid rollingWindow.trailing "${rollingWindow.trailing}". Must match time interval format (e.g. "7 days")`);
    }
    if (rollingWindow.leading && !TIME_INTERVAL_REGEX.test(rollingWindow.leading)) {
      reasons.push(`Invalid rollingWindow.leading "${rollingWindow.leading}". Must match time interval format (e.g. "1 month")`);
    }
  }

  return reasons;
}

/**
 * Validate timeShift property.
 *
 * @param {object[]} timeShift
 * @param {boolean} multiStage
 * @returns {string[]}
 */
function checkTimeShift(timeShift, multiStage) {
  if (!timeShift) return [];
  const reasons = [];

  if (!multiStage) {
    reasons.push('timeShift requires multiStage: true');
    return reasons;
  }

  if (!Array.isArray(timeShift)) {
    reasons.push('timeShift must be an array');
    return reasons;
  }

  for (const item of timeShift) {
    if (!item.interval || !TIME_INTERVAL_REGEX.test(item.interval)) {
      reasons.push(`Invalid timeShift interval "${item.interval}". Must match format like "1 year", "3 months"`);
    }
    if (!['prior', 'next'].includes(item.type)) {
      reasons.push(`Invalid timeShift type "${item.type}". Must be "prior" or "next"`);
    }
  }

  return reasons;
}

/**
 * Validate referencedMeasures entries against existing measure names.
 *
 * @param {string[]} referencedMeasures
 * @param {Set<string>} existingMeasureSet
 * @returns {string[]}
 */
function checkReferencedMeasures(referencedMeasures, existingMeasureSet) {
  if (!referencedMeasures || !Array.isArray(referencedMeasures)) return [];
  if (!existingMeasureSet) return [];

  const invalid = referencedMeasures.filter((name) => !existingMeasureSet.has(name));
  if (invalid.length > 0) {
    return [`Invalid referencedMeasures: ${invalid.join(', ')} — not found in existing measures`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an array of AI-generated metrics.
 *
 * @param {object[]} metrics - AI metrics with { name, sql, type, fieldType, description, ai_generation_context, source_columns, rollingWindow?, multiStage?, timeShift?, referencedMeasures? }
 * @param {string[]} profilerFields - Existing field names from the profiler
 * @param {string[]} profiledTableColumns - Raw ClickHouse column names
 * @param {string[]} [existingMeasureNames] - Names of profiler-generated measures (for measure reference validation)
 * @returns {{ valid: object[], rejected: Array<{ metric: object, reasons: string[] }> }}
 */
export function validateAIMetrics(metrics, profilerFields, profiledTableColumns, existingMeasureNames = []) {
  const valid = [];
  const rejected = [];
  const profilerFieldSet = new Set(profilerFields);
  const existingMeasureSet = new Set(existingMeasureNames);

  for (const metric of metrics) {
    const reasons = [];
    const isMultiStage = metric.multiStage === true;

    // 1. Balanced parentheses and backticks
    reasons.push(...checkBalanced(metric.sql || ''));

    // 2. Dangerous SQL keywords
    reasons.push(...checkDangerousKeywords(metric.sql || ''));

    // 3. Template variable validation (allow measure references)
    reasons.push(...checkTemplateVars(metric.sql || '', existingMeasureSet));

    // 4. Valid Cube.js types
    reasons.push(...checkType(metric.type, metric.fieldType));

    // 5. Column reference validation — skip for multiStage (they reference measures, not columns)
    if (!isMultiStage) {
      reasons.push(...checkColumnReferences(metric.sql || '', profiledTableColumns));
    }

    // 6. source_columns validation — skip for multiStage
    if (!isMultiStage) {
      reasons.push(...checkSourceColumns(metric.source_columns, profiledTableColumns));
    }

    // 7. Rolling window validation
    reasons.push(...checkRollingWindow(metric.rollingWindow));

    // 8. Time shift validation
    reasons.push(...checkTimeShift(metric.timeShift, isMultiStage));

    // 9. Referenced measures validation
    reasons.push(...checkReferencedMeasures(metric.referencedMeasures, existingMeasureSet));

    if (reasons.length > 0) {
      rejected.push({ metric, reasons });
      continue;
    }

    // 10. Name collision — fix, don't reject
    const validMetric = { ...metric };
    if (profilerFieldSet.has(validMetric.name)) {
      validMetric.name = `${validMetric.name}_ai`;
    }

    valid.push(validMetric);
  }

  return { valid, rejected };
}
