/**
 * Model polisher — rewrites a generated Cube.js model to conform
 * to cube-principles.md using an LLM with structured output.
 *
 * Input: generated JS model code, table profile summary, cube definitions
 * Output: polished cube definitions + validation report
 *
 * Never throws — all errors are caught and returned as a status.
 */

import fs from 'fs';
import { validateModelSyntax } from './modelValidator.js';
import { generateJs } from './yamlGenerator.js';

// Zod is imported dynamically alongside the OpenAI helper to ensure
// both come from the same resolved package version.
let _z = null;
async function getZod() {
  if (!_z) { _z = (await import('zod')).z; }
  return _z;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = 'gpt-5.4';
const DEFAULT_TIMEOUT = 90_000;
const MAX_RETRIES = 1; // 2 total LLM attempts
const MAX_VALIDATION_LOOPS = 2; // validation → correction cycles

// ---------------------------------------------------------------------------
// Zod schemas for structured output (built lazily via getSchemas)
// ---------------------------------------------------------------------------

let _schemas = null;
async function getSchemas() {
  if (_schemas) return _schemas;
  const z = await getZod();

  const PolishedFieldSchema = z.object({
    name: z.string(),
    sql: z.string(),
    type: z.string(),
    fieldType: z.enum(['dimension', 'measure', 'segment']),
    title: z.string().describe('Human-readable title for non-technical consumers'),
    description: z.string().nullable().describe('Description for non-obvious fields'),
    public: z.boolean().nullable().describe('false for internal plumbing fields'),
    primary_key: z.boolean().nullable(),
    format: z.enum(['currency', 'percent']).nullable(),
    meta: z.object({
      auto_generated: z.boolean().nullable(),
      ai_generated: z.boolean().nullable(),
      source_column: z.string().nullable(),
      source_group: z.string().nullable(),
    }).nullable(),
    drill_members: z.array(z.string()).nullable(),
    rollingWindow: z.object({
      type: z.enum(['to_date', 'fixed']),
      granularity: z.enum(['year', 'quarter', 'month', 'week', 'day', 'hour']).nullable(),
      trailing: z.string().nullable(),
      leading: z.string().nullable(),
      offset: z.enum(['start', 'end']).nullable(),
    }).nullable(),
    multiStage: z.boolean().nullable(),
    timeShift: z.array(z.object({
      interval: z.string(),
      type: z.enum(['prior', 'next']),
    })).nullable(),
  });

  const PolishedCubeSchema = z.object({
    name: z.string(),
    sql: z.string().nullable(),
    sql_table: z.string().nullable(),
    title: z.string(),
    description: z.string().describe('Paragraph: grain, source, analytical questions supported'),
    meta: z.object({
      grain: z.string(),
      grain_description: z.string(),
      time_dimension: z.string().nullable(),
      time_zone: z.string().nullable(),
      refresh_cadence: z.string().nullable(),
      auto_generated: z.boolean(),
    }),
    dimensions: z.array(PolishedFieldSchema),
    measures: z.array(PolishedFieldSchema),
    segments: z.array(PolishedFieldSchema).nullable(),
    pre_aggregations: z.array(z.object({
      name: z.string(),
      type: z.enum(['rollup', 'original_sql', 'rollup_join', 'rollup_lambda']),
      dimensions: z.array(z.string()).nullable(),
      measures: z.array(z.string()).nullable(),
      time_dimension: z.string().nullable(),
      granularity: z.string().nullable(),
      partition_granularity: z.string().nullable(),
      refresh_key: z.object({
        every: z.string().nullable(),
        sql: z.string().nullable(),
      }).nullable(),
      indexes: z.array(z.object({
        name: z.string(),
        columns: z.array(z.string()),
      })).nullable(),
    })).nullable(),
  });

  const PolishResponseSchema = z.object({
    cubes: z.array(PolishedCubeSchema),
    validation_report: z.object({
      principles_applied: z.array(z.string()).describe('Which principles from cube-principles.md were applied'),
      issues_fixed: z.array(z.string()).describe('Specific issues found and corrected'),
      warnings: z.array(z.string()).describe('Things the user should review manually'),
      grain: z.string().describe('The identified analytical grain'),
      primary_key: z.string().describe('The identified primary key expression'),
    }),
  });

  _schemas = { PolishResponseSchema };
  return _schemas;
}

// ---------------------------------------------------------------------------
// Principles loader
// ---------------------------------------------------------------------------

let _principlesCache = null;

function loadPrinciples() {
  if (_principlesCache) return _principlesCache;
  try {
    const paths = [
      process.env.CUBE_PRINCIPLES_PATH,
      '/app/shared/principles/cube-principles.md',
      '/app/shared/first-principles/semantic-layer-cubes.md',
    ].filter(Boolean);
    for (const p of paths) {
      try { _principlesCache = fs.readFileSync(p, 'utf-8'); break; } catch { /* try next */ }
    }
    if (_principlesCache) return _principlesCache;
  } catch {
    _principlesCache = [
      '# Cube Modeling Principles (Summary)',
      '',
      '- One cube = one grain. Primary key encodes the grain.',
      '- Partition is always the first dimension.',
      '- Push all computation into SQL. Cube layer is a thin projection.',
      '- Wrap SQL in SELECT * FROM (...). No CTE/WITH/HAVING.',
      '- Use sql_table for simple cases, sql for transformations.',
      '- Every public member needs a title.',
      '- Cube-level description: grain, source, analytical questions.',
      '- Cube-level meta: grain, grain_description, time_dimension, time_zone, refresh_cadence.',
      '- Derived metrics reference other metrics, never raw SQL.',
      '- Counts come in pairs: total + filtered.',
      '- Decompose avg as sum/count for pre-aggregation compatibility.',
      '- Hide internal plumbing with public: false.',
      '- Titles on every public member.',
      '- Drill members on the primary count.',
      '- 2-3 pre-aggregations per cube, hourly refresh, incremental, 7-day window.',
      '- Partition by month, index by primary filters.',
      '- ClickHouse: always define indexes in pre-aggregations.',
      '- format: currency / percent where applicable.',
      '- Segments encode analyst intent, not technical filters.',
    ].join('\n');
  }
  return _principlesCache;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  const principles = loadPrinciples();

  return [
    'You are a Cube.js data modeling expert. Your job is to polish an auto-generated Cube.js model to conform to the modeling principles below.',
    '',
    '## Your Task',
    '',
    '1. Review the generated model against the principles',
    '2. Fix issues: add missing titles, descriptions, meta blocks, segments, pre-aggregations',
    '3. Improve field names if they don\'t match analyst expectations',
    '4. Add derived metrics (rates, ratios, counts in pairs) where the data supports them',
    '5. Add pre-aggregations matching likely dashboard query patterns',
    '6. Set public: false on internal plumbing fields',
    '7. Add drill_members to the primary count measure',
    '8. Ensure the primary key is correct and encodes the grain',
    '9. Add format: currency/percent where appropriate',
    '10. Return the complete polished model + a validation report',
    '',
    '## CRITICAL RULES',
    '- Preserve ALL existing dimensions and measures — do not remove any',
    '- You may rename fields, add descriptions/titles, change types, add new fields',
    '- SQL must use {CUBE}.column syntax for column references',
    '- SQL must use {measure_name} syntax for referencing other measures',
    '- Never put aggregation functions (SUM, COUNT, etc.) in the sql field — use the type property',
    '- Wrap complex SQL in SELECT * FROM (...)',
    '- partition must be the first dimension',
    '- Every public member must have a title',
    '',
    '## Cube Modeling Principles',
    '',
    principles,
    '',
    'Return your response as structured JSON matching the schema.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the user message describing the model to polish.
 *
 * Uses string concatenation (not nested template literals) to match
 * the pattern established by llmEnricher.js.
 *
 * @param {string} generatedCode
 * @param {object} profileSummary
 * @param {object[]} cubes
 * @returns {string}
 */
function buildUserMessage(generatedCode, profileSummary, cubes) {
  let msg = '## Generated Model\n\n```javascript\n' + generatedCode + '\n```\n\n';

  msg += '## Table Profile\n\n';
  msg += '- Table: ' + profileSummary.schema + '.' + profileSummary.table + '\n';
  msg += '- Row count: ' + (profileSummary.row_count?.toLocaleString() || 'unknown') + '\n';
  msg += '- Columns: ' + (profileSummary.columns?.length || 'unknown') + '\n\n';

  msg += '### Column Summary\n';
  for (const c of (profileSummary.columns || []).slice(0, 100)) {
    msg += '- ' + c.name + ': ' + c.type + (c.description ? ' — ' + c.description : '') + '\n';
  }

  msg += '\n## Current Cube Structure\n\n';
  for (const c of cubes) {
    msg += '### ' + c.name + '\n';
    msg += '- Dimensions: ' + (c.dimensions?.length || 0) + '\n';
    msg += '- Measures: ' + (c.measures?.length || 0) + '\n';
    msg += '- SQL: ' + (c.sql ? 'custom' : c.sql_table ? 'sql_table' : 'none') + '\n\n';
  }

  msg += 'Polish this model according to the principles. Preserve all existing fields '
    + 'but improve them with titles, descriptions, proper types, and meta. '
    + 'Add derived metrics, segments, and pre-aggregations as appropriate.';

  return msg;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Polish a generated Cube.js model using an LLM.
 *
 * @param {string} generatedCode - The JS model code from yamlGenerator
 * @param {object} profileSummary - { table, schema, row_count, columns: [{name, type, description}] }
 * @param {object[]} cubes - Parsed cube definitions
 * @param {object} [options]
 * @param {number} [options.timeout] - Request timeout in ms (default 60 000)
 * @returns {Promise<{ polishedCubes: object[]|null, report: object|null, status: string, error: string|null }>}
 */
export async function polishModel(generatedCode, profileSummary, cubes, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  // -- Check API key --------------------------------------------------------
  if (!process.env.OPENAI_API_KEY) {
    return { polishedCubes: null, report: null, status: 'skipped', error: 'No OPENAI_API_KEY configured' };
  }

  // -- Dynamic imports (same pattern as llmEnricher) ------------------------
  const { default: OpenAI } = await import('openai');
  const { zodResponseFormat } = await import('openai/helpers/zod');
  const { PolishResponseSchema } = await getSchemas();

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // -- Build prompts --------------------------------------------------------
  const systemPrompt = buildSystemPrompt();
  const userMessage = buildUserMessage(generatedCode, profileSummary, cubes);

  // -- Call OpenAI with retry -----------------------------------------------
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await client.chat.completions.parse(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          response_format: zodResponseFormat(PolishResponseSchema, 'polished_model'),
          temperature: 0.3,
        },
        { signal: AbortSignal.timeout(timeout) }
      );

      let parsed = completion.choices[0]?.message?.parsed;
      if (!parsed) {
        if (attempt < MAX_RETRIES) continue;
        return { polishedCubes: null, report: null, status: 'failed', error: 'No parsed response from LLM' };
      }

      // -- Validation loop: generate JS → validate → feed errors back ---------
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
        { role: 'assistant', content: JSON.stringify(parsed) },
      ];

      for (let vLoop = 0; vLoop < MAX_VALIDATION_LOOPS; vLoop++) {
        try {
          const polishedJs = generateJs(parsed.cubes);
          const fileName = (parsed.cubes[0]?.name || 'model') + '.js';
          const validation = validateModelSyntax(polishedJs, fileName);

          if (validation.valid) {
            // Model passes validation
            if (parsed.validation_report) {
              parsed.validation_report.issues_fixed.push('Model syntax validated successfully');
            }
            break;
          }

          // Validation failed — send errors back to LLM for correction
          const errorMsg = 'The polished model has syntax errors. Fix them and return the corrected model.\n\n'
            + 'Validation errors:\n'
            + (validation.errors || []).map((e) => '- ' + e).join('\n')
            + '\n\nReturn the COMPLETE corrected model (all cubes, all fields) with fixes applied.';

          console.warn('[modelPolisher] Validation loop ' + (vLoop + 1) + ': ' + (validation.errors?.length || 0) + ' errors, requesting correction');

          messages.push({ role: 'user', content: errorMsg });

          const correction = await client.chat.completions.parse(
            {
              model: MODEL,
              messages,
              response_format: zodResponseFormat(PolishResponseSchema, 'polished_model'),
              temperature: 0.2,
            },
            { signal: AbortSignal.timeout(timeout) }
          );

          const corrected = correction.choices[0]?.message?.parsed;
          if (corrected) {
            parsed = corrected;
            messages.push({ role: 'assistant', content: JSON.stringify(corrected) });
          } else {
            break; // No correction available
          }
        } catch (valErr) {
          console.warn('[modelPolisher] Validation loop error (non-fatal):', valErr.message);
          break;
        }
      }

      return {
        polishedCubes: parsed.cubes,
        report: parsed.validation_report,
        status: 'success',
        error: null,
      };
    } catch (err) {
      if (attempt < MAX_RETRIES) continue;
      console.error('[modelPolisher] LLM call failed:', err.message);
      return {
        polishedCubes: null,
        report: null,
        status: 'failed',
        error: err.message || 'LLM polishing failed',
      };
    }
  }

  return { polishedCubes: null, report: null, status: 'failed', error: 'Max retries exceeded' };
}
