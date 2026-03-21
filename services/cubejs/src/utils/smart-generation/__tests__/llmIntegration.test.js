import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAIMetrics } from '../cubeBuilder.js';
import { generateJs } from '../yamlGenerator.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeCubes() {
  return [
    {
      name: 'events',
      sql_table: 'default.events',
      meta: { auto_generated: true, source_database: 'default', source_table: 'events' },
      dimensions: [
        { name: 'country', sql: '{CUBE}.country', type: 'string', meta: { auto_generated: true } },
        { name: 'event_date', sql: '{CUBE}.event_date', type: 'time', meta: { auto_generated: true } },
      ],
      measures: [
        { name: 'count', sql: '*', type: 'count', meta: { auto_generated: true } },
        { name: 'amount', sql: '{CUBE}.amount', type: 'sum', meta: { auto_generated: true } },
      ],
    },
  ];
}

function makeAIMetrics(overrides = []) {
  const defaults = [
    {
      name: 'avg_amount_per_country',
      sql: '{CUBE}.amount / nullIf({CUBE}.country_count, 0)',
      type: 'number',
      fieldType: 'measure',
      description: 'Average amount per country',
      ai_generation_context: 'Ratio of total amount to country count — useful for per-country analysis',
      source_columns: ['amount', 'country'],
    },
    {
      name: 'is_high_value',
      sql: 'CASE WHEN {CUBE}.amount > 500 THEN true ELSE false END',
      type: 'boolean',
      fieldType: 'dimension',
      description: 'Whether the event has a high monetary value',
      ai_generation_context: 'Categorical flag for filtering high-value events',
      source_columns: ['amount'],
    },
  ];
  return overrides.length > 0 ? overrides : defaults;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mergeAIMetrics', () => {
  it('inserts AI metrics into cube dimensions/measures with full meta', () => {
    const cubes = makeCubes();
    const aiMetrics = makeAIMetrics();

    const result = mergeAIMetrics(cubes, aiMetrics);

    // Should return the same array reference
    assert.equal(result, cubes);

    // The measure should have been added to first cube
    const measureNames = result[0].measures.map((m) => m.name);
    assert.ok(measureNames.includes('avg_amount_per_country'), 'AI measure should be present');

    // The dimension should have been added
    const dimNames = result[0].dimensions.map((d) => d.name);
    assert.ok(dimNames.includes('is_high_value'), 'AI dimension should be present');

    // Check full meta on the measure
    const aiMeasure = result[0].measures.find((m) => m.name === 'avg_amount_per_country');
    assert.equal(aiMeasure.meta.ai_generated, true);
    assert.equal(typeof aiMeasure.meta.ai_model, 'string');
    assert.ok(aiMeasure.meta.ai_model.length > 0);
    assert.equal(aiMeasure.meta.ai_generation_context, 'Ratio of total amount to country count — useful for per-country analysis');
    assert.ok(aiMeasure.meta.ai_generated_at, 'ai_generated_at should be set');
    assert.deepEqual(aiMeasure.meta.source_columns, ['amount', 'country']);

    // Check full meta on the dimension
    const aiDim = result[0].dimensions.find((d) => d.name === 'is_high_value');
    assert.equal(aiDim.meta.ai_generated, true);
    assert.deepEqual(aiDim.meta.source_columns, ['amount']);
  });

  it('AI measures can use `number` type for derived calculations', () => {
    const cubes = makeCubes();
    const aiMetrics = [
      {
        name: 'revenue_ratio',
        sql: '{CUBE}.amount / nullIf({CUBE}.total, 0)',
        type: 'number',
        fieldType: 'measure',
        description: 'Revenue ratio',
        ai_generation_context: 'Derived ratio calculation',
        source_columns: ['amount'],
      },
    ];

    const result = mergeAIMetrics(cubes, aiMetrics);
    const added = result[0].measures.find((m) => m.name === 'revenue_ratio');
    assert.ok(added, 'number-type measure should be added');
    assert.equal(added.type, 'number');
    assert.equal(added.meta.ai_generated, true);
  });

  it('generateJs() serializes AI metric meta correctly', () => {
    const cubes = makeCubes();
    const aiMetrics = makeAIMetrics();
    mergeAIMetrics(cubes, aiMetrics);

    const js = generateJs(cubes);

    // Check ai_generated meta is present in the output
    assert.ok(js.includes('ai_generated: true'), 'JS output should contain ai_generated: true');
    assert.ok(js.includes('ai_model:'), 'JS output should contain ai_model');
    assert.ok(js.includes('ai_generation_context:'), 'JS output should contain ai_generation_context');
    assert.ok(js.includes('ai_generated_at:'), 'JS output should contain ai_generated_at');
    assert.ok(js.includes('source_columns:'), 'JS output should contain source_columns');

    // AI dimension description should be present
    assert.ok(js.includes('Whether the event has a high monetary value'), 'description should be serialized');
  });

  it('skips AI metric if name already exists in cube (field uniqueness)', () => {
    const cubes = makeCubes();
    const aiMetrics = [
      {
        name: 'country', // already exists as a dimension
        sql: '{CUBE}.country',
        type: 'string',
        fieldType: 'dimension',
        description: 'Duplicate country',
        ai_generation_context: 'This should be skipped',
        source_columns: ['country'],
      },
      {
        name: 'amount', // already exists as a measure
        sql: '{CUBE}.amount',
        type: 'sum',
        fieldType: 'measure',
        description: 'Duplicate amount',
        ai_generation_context: 'This should be skipped too',
        source_columns: ['amount'],
      },
      {
        name: 'new_metric',
        sql: '{CUBE}.amount * 2',
        type: 'number',
        fieldType: 'measure',
        description: 'A genuinely new metric',
        ai_generation_context: 'Novel metric',
        source_columns: ['amount'],
      },
    ];

    const dimCountBefore = cubes[0].dimensions.length;
    const measureCountBefore = cubes[0].measures.length;

    mergeAIMetrics(cubes, aiMetrics);

    // Only new_metric should be added (the two duplicates should be skipped)
    assert.equal(cubes[0].dimensions.length, dimCountBefore, 'no new dimensions — country was a dupe');
    assert.equal(cubes[0].measures.length, measureCountBefore + 1, 'only new_metric added');
    assert.ok(cubes[0].measures.find((m) => m.name === 'new_metric'), 'new_metric should be present');
  });

  it('dry-run behavior — mergeAIMetrics can be called independently with empty array', () => {
    const cubes = makeCubes();
    const dimCountBefore = cubes[0].dimensions.length;
    const measureCountBefore = cubes[0].measures.length;

    // Simulates dry-run: no LLM call, just pass empty metrics
    const result = mergeAIMetrics(cubes, []);

    assert.equal(result, cubes);
    assert.equal(result[0].dimensions.length, dimCountBefore);
    assert.equal(result[0].measures.length, measureCountBefore);
  });

  it('handles empty cubes array without throwing', () => {
    const result = mergeAIMetrics([], makeAIMetrics());
    assert.deepEqual(result, []);
  });
});
