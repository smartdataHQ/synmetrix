/**
 * Model advisor — sends focused micro-prompts to the LLM to refine
 * a generated Cube.js model. Each prompt asks ONE question with a
 * small structured output. The full model stays in context for every call.
 *
 * Never throws — all errors caught and returned as status.
 */

import fs from 'fs';
import { validateModelSyntax } from './modelValidator.js';
import { generateJs } from './yamlGenerator.js';

const MODEL = 'gpt-5.4';
const PASS_TIMEOUT = 45_000; // 45s per micro-prompt (plenty for small output)

// -- Principles excerpts (concise, relevant per pass) -------------------------

const PRINCIPLES_DESCRIPTIONS = [
  'Every public dimension and measure must have a title that makes sense to a non-technical consumer or AI agent.',
  'Cube-level description: one paragraph covering grain, source, and what analytical questions it supports.',
  'Descriptions on non-obvious measures: if behavior is subtle (median bypassing pre-aggs, rate biased toward longer events), say so.',
  'Section comments group related fields. Readers scan headings before fields.',
].join('\n');

const PRINCIPLES_SEGMENTS = [
  'Segments encode analyst intent. Name for what the analyst wants to see (exclude_returns, confirmed_only), not the technical filter.',
  'Segments and filtered measures are complementary. Use segments when filter logic is complex or encodes reusable business intent.',
  'Each segment should trace to a question the user actually asks.',
].join('\n');

const PRINCIPLES_METRICS = [
  'Counts come in pairs: total + filtered. This enables rate calculations without consumer-side filters.',
  'Derived metrics reference other metrics, never raw SQL. Use {measure_name} syntax.',
  'Decompose avg as {sum_field} / {count_field} using type: number for pre-aggregation compatibility.',
  'Research industry KPIs before designing. Prioritize standard metrics computable from the grain.',
  'format: currency for revenue/price/cost measures. format: percent for rate/ratio measures (store raw decimal, not x100).',
].join('\n');

const PRINCIPLES_PREAGGS = [
  '2-3 rollups per cube at different aggregation levels. Match to dashboard query patterns.',
  'Include only the measures dashboards actually query. Don\'t dump all measures into every rollup.',
  'Standardized refresh: every: 1 hour, incremental: true, update_window: 7 days.',
  'Partition by month, index by primary filters. ClickHouse: always define indexes.',
  'build_range_start from min(timestamp), build_range_end from SELECT NOW().',
].join('\n');

// -- Shared context builder ---------------------------------------------------

function buildModelContext(generatedCode, profileSummary, cubes) {
  let ctx = '## Current Model\n\n```javascript\n' + generatedCode + '\n```\n\n';
  ctx += '## Table: ' + profileSummary.schema + '.' + profileSummary.table + '\n';
  ctx += '- Row count: ' + (profileSummary.row_count?.toLocaleString() || 'unknown') + '\n';
  ctx += '- Cubes: ' + cubes.length + '\n';
  for (const c of cubes) {
    ctx += '- ' + c.name + ': ' + (c.dimensions?.length || 0) + ' dimensions, ' + (c.measures?.length || 0) + ' measures\n';
  }
  return ctx;
}

// -- Individual passes --------------------------------------------------------

async function runPass(client, zodResponseFormat, z, modelContext, passName, principles, question, schema, timeout) {
  const systemPrompt = [
    'You are a Cube.js data modeling advisor. You review auto-generated models and suggest improvements.',
    'You have deep expertise in Cube.js, ClickHouse, and semantic layer best practices.',
    '',
    '## Relevant Principles',
    '',
    principles,
    '',
    '## Rules',
    '- SQL uses {CUBE}.column for column references, {measure_name} for measure references',
    '- Never put aggregation functions in sql — use the type property',
    '- Return ONLY what needs changing. Empty arrays are fine if no changes needed.',
  ].join('\n');

  try {
    const completion = await client.chat.completions.parse(
      {
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: modelContext + '\n\n## Question\n\n' + question },
        ],
        response_format: zodResponseFormat(schema, passName),
        temperature: 0.3,
      },
      { signal: AbortSignal.timeout(timeout) }
    );

    return completion.choices[0]?.message?.parsed || null;
  } catch (err) {
    console.warn('[modelAdvisor] Pass "' + passName + '" failed: ' + err.message);
    return null;
  }
}

// -- Main export --------------------------------------------------------------

/**
 * Run focused advisory passes on a generated model.
 *
 * @param {string} generatedCode - JS model code
 * @param {object} profileSummary - { table, schema, row_count, columns }
 * @param {object[]} cubes - Parsed cube definitions
 * @param {object} [options]
 * @returns {Promise<{ passes: object[], status: string, error: string|null }>}
 */
export async function adviseModel(generatedCode, profileSummary, cubes, options = {}) {
  const timeout = options.timeout ?? PASS_TIMEOUT;

  if (!process.env.OPENAI_API_KEY) {
    return { passes: [], status: 'skipped', error: 'No OPENAI_API_KEY configured' };
  }

  const { default: OpenAI } = await import('openai');
  const { zodResponseFormat } = await import('openai/helpers/zod');
  const { z } = await import('zod');

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const modelContext = buildModelContext(generatedCode, profileSummary, cubes);
  const passes = [];

  // -- Pass 1: Descriptions & Titles --
  const DescSchema = z.object({
    corrections: z.array(z.object({
      name: z.string().describe('Field name to correct'),
      title: z.string().nullable().describe('Corrected title, or null if OK'),
      description: z.string().nullable().describe('Description to add, or null if OK'),
    })),
    cube_description: z.string().nullable().describe('Improved cube description, or null if OK'),
  });

  const descResult = await runPass(client, zodResponseFormat, z, modelContext,
    'descriptions', PRINCIPLES_DESCRIPTIONS,
    'Review all dimensions and measures. For any with a poor title or missing description, provide corrections. Focus on titles that would confuse a non-technical analyst.',
    DescSchema, timeout);
  if (descResult) passes.push({ pass: 'descriptions', result: descResult });

  // -- Pass 2: Segments --
  const SegSchema = z.object({
    segments: z.array(z.object({
      name: z.string(),
      sql: z.string().describe('SQL filter expression using {CUBE}.column syntax'),
      title: z.string(),
      description: z.string(),
    })),
  });

  const segResult = await runPass(client, zodResponseFormat, z, modelContext,
    'segments', PRINCIPLES_SEGMENTS,
    'What meaningful analyst-facing segments should this cube have? Consider common filter patterns analysts would reuse. Return 0-5 segments.',
    SegSchema, timeout);
  if (segResult) passes.push({ pass: 'segments', result: segResult });

  // -- Pass 3: Derived Metrics --
  const MetricsSchema = z.object({
    metrics: z.array(z.object({
      name: z.string(),
      sql: z.string(),
      type: z.enum(['number', 'count', 'sum', 'avg', 'min', 'max', 'count_distinct']),
      title: z.string(),
      description: z.string(),
      format: z.enum(['currency', 'percent']).nullable(),
    })),
  });

  const metricsResult = await runPass(client, zodResponseFormat, z, modelContext,
    'derived_metrics', PRINCIPLES_METRICS,
    'What calculated metrics (rates, ratios, decomposed averages) would support analysis of this data? Reference existing measures using {measure_name} syntax. Return 0-10 metrics.',
    MetricsSchema, timeout);
  if (metricsResult) passes.push({ pass: 'derived_metrics', result: metricsResult });

  // -- Pass 4: Pre-aggregation Review --
  const PreAggSchema = z.object({
    assessment: z.string().describe('Brief assessment of current pre-aggregations'),
    replacements: z.array(z.object({
      name: z.string(),
      type: z.enum(['rollup', 'original_sql']),
      dimensions: z.array(z.string()),
      measures: z.array(z.string()),
      time_dimension: z.string().nullable(),
      granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).nullable(),
      partition_granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).nullable(),
    })).describe('Complete set of recommended pre-aggregations (replaces existing)'),
  });

  const preAggResult = await runPass(client, zodResponseFormat, z, modelContext,
    'pre_aggregations', PRINCIPLES_PREAGGS,
    'Review the pre-aggregations. Are they appropriate for this data and likely dashboard patterns? Return the complete recommended set (it replaces existing pre-aggs).',
    PreAggSchema, timeout);
  if (preAggResult) passes.push({ pass: 'pre_aggregations', result: preAggResult });

  return {
    passes,
    status: passes.length > 0 ? 'success' : 'failed',
    error: passes.length === 0 ? 'All advisory passes failed' : null,
  };
}

/**
 * Apply advisory pass results to cube definitions.
 *
 * @param {object[]} cubes - Mutable cube definitions
 * @param {object[]} passes - Results from adviseModel
 */
export function applyAdvisoryPasses(cubes, passes) {
  for (const { pass, result } of passes) {
    if (pass === 'descriptions' && result) {
      // Apply title/description corrections
      for (const correction of result.corrections || []) {
        for (const cube of cubes) {
          const field = [...(cube.dimensions || []), ...(cube.measures || [])]
            .find((f) => f.name === correction.name);
          if (field) {
            if (correction.title) field.title = correction.title;
            if (correction.description) field.description = correction.description;
          }
        }
      }
      if (result.cube_description && cubes[0]) {
        cubes[0].description = result.cube_description;
      }
    }

    if (pass === 'segments' && result) {
      for (const cube of cubes) {
        if (!cube.segments) cube.segments = [];
        for (const seg of result.segments || []) {
          if (!cube.segments.some((s) => s.name === seg.name)) {
            cube.segments.push({
              ...seg,
              meta: { auto_generated: true, ai_generated: true },
            });
          }
        }
      }
    }

    if (pass === 'derived_metrics' && result) {
      for (const cube of cubes) {
        for (const metric of result.metrics || []) {
          if (cube.measures.some((m) => m.name === metric.name)) continue;
          cube.measures.push({
            ...metric,
            meta: { auto_generated: true, ai_generated: true },
          });
        }
      }
    }

    if (pass === 'pre_aggregations' && result) {
      for (const cube of cubes) {
        if (result.replacements && result.replacements.length > 0) {
          cube.pre_aggregations = result.replacements.map((pa) => ({
            ...pa,
            refresh_key: { every: '1 hour' },
            indexes: pa.dimensions?.length > 0
              ? [{ name: pa.name + '_idx', columns: pa.dimensions.slice(0, 3) }]
              : [],
          }));
        }
      }
    }
  }
}
