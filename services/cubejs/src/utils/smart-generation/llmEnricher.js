/**
 * LLM enricher — generates AI-powered calculated metrics for a profiled
 * table using OpenAI structured outputs.
 *
 * Includes a validation retry loop: invalid metrics are sent back to the
 * LLM for correction (up to 2 retries, 3 total attempts).
 *
 * Never throws — all errors are caught and returned as a failed status.
 */

import { z } from 'zod';
import { validateAIMetrics } from './llmValidator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = 'gpt-5.4';
const DEFAULT_TIMEOUT = 30_000;
const MAX_RETRIES = 2; // 3 total attempts

// ---------------------------------------------------------------------------
// Zod schemas for structured output
// ---------------------------------------------------------------------------

const MetricSchema = z.object({
  name: z.string(),
  sql: z.string(),
  type: z.string(),
  fieldType: z.enum(['dimension', 'measure']),
  description: z.string(),
  ai_generation_context: z.string(),
  source_columns: z.array(z.string()),
  rollingWindow: z.object({
    type: z.enum(['to_date', 'fixed']),
    granularity: z.enum(['year', 'quarter', 'month']).nullable().optional(),
    trailing: z.string().nullable().optional(),
    leading: z.string().nullable().optional(),
    offset: z.enum(['start', 'end']).nullable().optional(),
  }).nullable().optional(),
  multiStage: z.boolean().nullable().optional(),
  timeShift: z.array(z.object({
    interval: z.string(),
    type: z.enum(['prior', 'next']),
  })).nullable().optional(),
  referencedMeasures: z.array(z.string()).nullable().optional(),
});

const ResponseSchema = z.object({
  metrics: z.array(MetricSchema),
});

// ---------------------------------------------------------------------------
// System prompt — Cube.js syntax reference
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a Cube.js data modeling expert. Generate calculated metrics for ClickHouse tables.

## Cube.js SQL Syntax Reference

### Column references
Always use \`{CUBE}.column_name\` — NEVER raw SQL aggregation functions like SUM(), AVG(), COUNT() in the sql field.
The \`type\` field controls how Cube.js aggregates the column.

### Simple aggregations
For direct column aggregations, set the appropriate type and reference the column:
- \`type: "sum"\`, \`sql: "{CUBE}.amount"\` → Cube.js generates SUM(amount)
- \`type: "avg"\`, \`sql: "{CUBE}.amount"\` → Cube.js generates AVG(amount)
- \`type: "count"\`, \`sql: "{CUBE}.id"\` → Cube.js generates COUNT(id)
- \`type: "countDistinct"\`, \`sql: "{CUBE}.user_id"\` → COUNT(DISTINCT user_id)
- \`type: "countDistinctApprox"\`, \`sql: "{CUBE}.user_id"\` → approximate distinct count
- \`type: "min"\` / \`type: "max"\` for extremes

### Derived calculations (ratios, formulas)
Use \`type: "number"\` with a SQL formula combining column references:
\`\`\`
type: "number"
sql: "{CUBE}.revenue / NULLIF({CUBE}.user_count, 0)"
\`\`\`
The sql expression is used as-is — Cube.js does NOT wrap it in an aggregation function.
Use NULLIF for safe division.

### YTD / QTD / MTD (rolling window to-date)
Use rollingWindow with type "to_date":
\`\`\`
type: "sum"
sql: "{CUBE}.amount"
rollingWindow: { type: "to_date", granularity: "year" }   // YTD
rollingWindow: { type: "to_date", granularity: "quarter" } // QTD
rollingWindow: { type: "to_date", granularity: "month" }   // MTD
\`\`\`

### YoY / MoM (time-shifted comparison)
Use multiStage + timeShift. The sql references an existing measure by name:
\`\`\`
multiStage: true
sql: "{base_measure_name}"
timeShift: [{ interval: "1 year", type: "prior" }]   // YoY
timeShift: [{ interval: "1 month", type: "prior" }]  // MoM
referencedMeasures: ["base_measure_name"]
\`\`\`
For multi-stage metrics, source_columns can be empty since they derive from other measures.

## CRITICAL RULES
- NEVER put aggregation functions (SUM, AVG, COUNT, etc.) in the sql field — the type field controls aggregation
- Always use {CUBE}.column_name for column references
- Use {measure_name} only for multiStage metrics referencing existing measures
- Populate source_columns with raw ClickHouse column names the metric depends on
- For multiStage metrics, populate referencedMeasures with the measure names referenced in sql`;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build a structured prompt for metric generation.
 *
 * @param {object} profiledTable
 * @param {object[]} existingCubes
 * @param {object[]} existingAIMetrics
 * @param {string[]} existingMeasureNames
 * @returns {string}
 */
function buildPrompt(profiledTable, existingCubes, existingAIMetrics, existingMeasureNames) {
  const { table, database, columns, row_count } = profiledTable;

  // Summarise columns
  const columnLines = [];
  const colEntries = columns instanceof Map ? [...columns.entries()] : Object.entries(columns);
  for (const [colName, colInfo] of colEntries) {
    const parts = [`  - ${colName}: type=${colInfo.type || colInfo.ch_type || 'unknown'}`];
    if (colInfo.min !== undefined) parts.push(`min=${colInfo.min}`);
    if (colInfo.max !== undefined) parts.push(`max=${colInfo.max}`);
    if (colInfo.avg !== undefined) parts.push(`avg=${colInfo.avg}`);
    if (colInfo.distinct !== undefined) parts.push(`distinct=${colInfo.distinct}`);
    if (colInfo.null_count !== undefined) parts.push(`nulls=${colInfo.null_count}`);
    columnLines.push(parts.join(', '));
  }

  // Summarise existing cube fields
  const cubeLines = [];
  for (const cube of existingCubes) {
    const dims = (cube.dimensions || []).map((d) => d.name).join(', ');
    const measures = (cube.measures || []).map((m) => `${m.name}(${m.type})`).join(', ');
    cubeLines.push(`  Cube "${cube.name}":`);
    if (dims) cubeLines.push(`    Dimensions: ${dims}`);
    if (measures) cubeLines.push(`    Measures: ${measures}`);
  }

  // List available measures for multi-stage references
  let measuresSection = '';
  if (existingMeasureNames && existingMeasureNames.length > 0) {
    measuresSection = [
      '',
      'Available measures you can reference in multiStage metrics (use {measure_name} in sql):',
      ...existingMeasureNames.map((name) => `  - ${name}`),
    ].join('\n');
  }

  // Existing AI metrics (for superset regeneration)
  let existingMetricsSection = '';
  if (existingAIMetrics && existingAIMetrics.length > 0) {
    const metricLines = existingAIMetrics.map((m) => {
      const parts = [`  - ${m.name} (${m.type}): ${m.description || 'no description'}`];
      if (m.sql) parts.push(`    SQL: ${m.sql}`);
      if (m.source_columns && m.source_columns.length > 0) {
        parts.push(`    source_columns: [${m.source_columns.join(', ')}]`);
      }
      return parts.join('\n');
    });
    existingMetricsSection = [
      '',
      'Previously generated metrics (RETAIN ALL unless source columns no longer exist):',
      ...metricLines,
      '',
      'You MUST return a superset — include all previously generated metrics above',
      '(with the same name, sql, and type) plus any new metrics you generate.',
      'Only omit a previously generated metric if its source_columns reference',
      'columns that are no longer in the column list above.',
    ].join('\n');
  }

  // Warn the LLM when the profiled subset is very small
  const smallDatasetWarning = (row_count != null && row_count < 100)
    ? '\nWarning: The profiled data subset has fewer than 100 rows. AI-generated metrics may be less reliable.\n'
    : '';

  return [
    `Table: ${database}.${table}`,
    `Row count: ${row_count ?? 'unknown'}`,
    smallDatasetWarning,
    'Columns:',
    ...columnLines,
    '',
    'Existing cube definitions:',
    ...(cubeLines.length > 0 ? cubeLines : ['  (none)']),
    measuresSection,
    existingMetricsSection,
    '',
    'Generate useful calculated metrics for this table. Prioritize simple, practical calculations:',
    '- Simple aggregations: sum, avg, count, min, max, countDistinct on relevant columns',
    '- Ratios between related numeric columns (e.g., revenue per user, cost per unit)',
    '- Safe division with NULLIF (e.g., {CUBE}.revenue / NULLIF({CUBE}.user_count, 0))',
    '- Averages and weighted averages',
    '- Growth rates or change indicators',
    '- Categorical breakdowns where useful',
    '',
    'If the table has a date/time column, you MAY also generate temporal metrics:',
    '- Year-to-date (YTD), quarter-to-date (QTD), month-to-date (MTD) using rollingWindow',
    '- Year-over-year (YoY) and month-over-month (MoM) using multiStage + timeShift',
    'But simple calculations should be the majority of your output.',
    '',
    'Rules:',
    '- Use {CUBE}.column_name syntax for column references in SQL',
    '- NEVER use SQL aggregation functions (SUM, AVG, COUNT, etc.) in the sql field — type controls aggregation',
    '- Use `type: "number"` for derived calculations (ratios, formulas)',
    '- Use aggregation types (sum, avg, count, min, max, countDistinct, countDistinctApprox, runningTotal) for direct column aggregations',
    '- Use rollingWindow with type "to_date" for YTD/QTD/MTD metrics',
    '- Use multiStage + timeShift for YoY/MoM comparison metrics',
    '- Set fieldType to "measure" for aggregated/calculated values, "dimension" for categorical/descriptive values',
    '- Populate source_columns with the raw ClickHouse column names (from the column list above) that the metric references',
    '- For multiStage metrics, populate referencedMeasures with the existing measure names used in sql',
    '- Each metric needs a clear, concise description',
    '- ai_generation_context should explain why this metric is useful',
    '- Generate 3-8 metrics depending on the table complexity',
  ].join('\n');
}

/**
 * Build a correction prompt for the validation retry loop.
 *
 * @param {Array<{ metric: object, reasons: string[] }>} rejected
 * @returns {string}
 */
function buildCorrectionPrompt(rejected) {
  const lines = [
    'The following metrics were rejected due to validation errors. Please fix them and return corrected versions:',
    '',
  ];

  for (const { metric, reasons } of rejected) {
    lines.push(`Metric "${metric.name}":`);
    for (const reason of reasons) {
      lines.push(`  - ${reason}`);
    }
    lines.push('');
  }

  lines.push('Return ONLY the corrected metrics (not the ones that already passed validation).');
  lines.push('Follow the Cube.js syntax rules from the system prompt exactly.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enrich a profiled table with AI-generated calculated metrics.
 *
 * Includes a validation retry loop: invalid metrics are sent back for
 * correction up to MAX_RETRIES times.
 *
 * @param {object} profiledTable - { table, database, columns (Map), row_count }
 * @param {object[]} existingCubes - Cube definitions from cubeBuilder
 * @param {object[]} existingAIMetrics - Previously generated AI metrics
 * @param {object} [options] - { timeout, existingMeasureNames, profilerFields, profiledTableColumns }
 * @returns {Promise<{ metrics: object[], status: string, model: string, error: string|null, rejected?: Array<{ metric: object, reasons: string[] }> }>}
 */
export async function enrichWithAIMetrics(
  profiledTable,
  existingCubes,
  existingAIMetrics,
  options = {}
) {
  const result = { metrics: [], status: 'failed', model: MODEL, error: null };

  try {
    // -- Check API key ------------------------------------------------------
    if (!process.env.OPENAI_API_KEY) {
      result.error = 'OPENAI_API_KEY environment variable is not set';
      return result;
    }

    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const existingMeasureNames = options.existingMeasureNames || [];
    const profilerFields = options.profilerFields || [];
    const profiledTableColumns = options.profiledTableColumns || [];

    // -- Dynamic imports ----------------------------------------------------
    const { default: OpenAI } = await import('openai');
    const { zodResponseFormat } = await import('openai/helpers/zod');

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // -- Build prompt -------------------------------------------------------
    const prompt = buildPrompt(
      profiledTable,
      existingCubes || [],
      existingAIMetrics || [],
      existingMeasureNames,
    );

    // -- Call OpenAI with validation retry loop ------------------------------
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ];

    let allValid = [];
    let lastRejected = [];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const completion = await client.chat.completions.parse(
        {
          model: MODEL,
          messages,
          response_format: zodResponseFormat(ResponseSchema, 'ai_metrics'),
        },
        { signal: AbortSignal.timeout(timeout) }
      );

      const parsed = completion.choices[0].message.parsed;
      const metricsToValidate = parsed.metrics;

      // Validate
      const { valid, rejected } = validateAIMetrics(
        metricsToValidate,
        profilerFields,
        profiledTableColumns,
        existingMeasureNames,
      );

      allValid.push(...valid);
      lastRejected = rejected;

      // All passed or no more retries
      if (rejected.length === 0 || attempt === MAX_RETRIES) {
        break;
      }

      // Append assistant response + correction prompt for retry
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ metrics: metricsToValidate }),
      });
      messages.push({
        role: 'user',
        content: buildCorrectionPrompt(rejected),
      });
    }

    result.metrics = allValid;

    if (lastRejected.length > 0) {
      result.status = 'partial';
      result.rejected = lastRejected;
    } else {
      result.status = 'success';
    }

    result.error = null;
  } catch (err) {
    result.error = err.message || String(err);
  }

  return result;
}
