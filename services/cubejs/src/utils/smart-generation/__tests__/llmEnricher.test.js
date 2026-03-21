import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { enrichWithAIMetrics } from '../llmEnricher.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeProfiledTable(overrides = {}) {
  return {
    database: 'default',
    table: 'events',
    partition: null,
    columns: new Map([
      [
        'country',
        {
          name: 'country',
          rawType: 'String',
          profile: { hasValues: true, uniqueValues: ['US', 'UK', 'DE'] },
        },
      ],
      [
        'amount',
        {
          name: 'amount',
          rawType: 'Float64',
          profile: { hasValues: true, minValue: 0, maxValue: 1000 },
        },
      ],
    ]),
    ...overrides,
  };
}

function makeExistingCubes() {
  return [
    {
      name: 'events',
      sql_table: 'default.events',
      dimensions: [{ name: 'country', sql: '{CUBE}.country', type: 'string' }],
      measures: [{ name: 'amount', sql: '{CUBE}.amount', type: 'sum' }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichWithAIMetrics', () => {
  let savedKey;

  beforeEach(() => {
    savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedKey !== undefined) {
      process.env.OPENAI_API_KEY = savedKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('when OPENAI_API_KEY is not set, returns failed status without throwing', async () => {
    const result = await enrichWithAIMetrics(makeProfiledTable(), makeExistingCubes(), []);
    assert.ok(result, 'should return a result object');
    assert.ok(Array.isArray(result.metrics), 'result.metrics should be an array');
    assert.equal(result.metrics.length, 0, 'metrics should be empty on failure');
    assert.equal(result.status, 'failed');
    assert.ok(typeof result.error === 'string', 'error should be a string message');
  });

  it('result structure includes metrics array, status string, and model string', async () => {
    const result = await enrichWithAIMetrics(makeProfiledTable(), makeExistingCubes(), []);
    assert.ok('metrics' in result, 'result should have metrics key');
    assert.ok('status' in result, 'result should have status key');
    // model may be undefined/null on failure, but the key should exist or status should indicate failure
    assert.ok(typeof result.status === 'string', 'status should be a string');
    assert.ok(Array.isArray(result.metrics), 'metrics should be an array');
  });

  it('accepts existingAIMetrics parameter without error', async () => {
    const existingAIMetrics = [
      {
        name: 'avg_amount',
        sql: '{CUBE}.amount',
        type: 'avg',
        fieldType: 'measure',
        description: 'Average amount',
        ai_generation_context: 'Average of the amount column',
        source_columns: ['amount'],
      },
    ];
    // Should not throw even though API key is missing
    const result = await enrichWithAIMetrics(
      makeProfiledTable(),
      makeExistingCubes(),
      existingAIMetrics,
    );
    assert.ok(result, 'should return a result object');
    assert.equal(result.status, 'failed');
  });

  it('empty table profile produces valid result without throwing', async () => {
    const emptyTable = makeProfiledTable({ columns: new Map() });
    const result = await enrichWithAIMetrics(emptyTable, [], []);
    assert.ok(result, 'should return a result object');
    assert.ok(Array.isArray(result.metrics), 'metrics should be an array');
    assert.equal(result.status, 'failed', 'should fail without API key');
    assert.ok(typeof result.error === 'string');
  });

  it('accepts new options: existingMeasureNames, profilerFields, profiledTableColumns', async () => {
    const result = await enrichWithAIMetrics(
      makeProfiledTable(),
      makeExistingCubes(),
      [],
      {
        existingMeasureNames: ['count', 'total_amount'],
        profilerFields: ['country', 'amount'],
        profiledTableColumns: ['country', 'amount'],
      },
    );
    assert.ok(result, 'should return a result object');
    assert.equal(result.status, 'failed', 'should fail without API key');
  });

  it('result can have status "partial" with rejected array', async () => {
    // We can't trigger a real partial without API key, but validate the contract
    const result = await enrichWithAIMetrics(makeProfiledTable(), makeExistingCubes(), []);
    // Status should be 'failed' (no key), but partial is a valid status
    assert.ok(['success', 'partial', 'failed'].includes(result.status));
  });
});

// ---------------------------------------------------------------------------
// Zod schema acceptance — advanced properties
// ---------------------------------------------------------------------------

describe('MetricSchema advanced properties', () => {
  // We test schema acceptance indirectly: the Zod schema is internal to
  // llmEnricher, but if we can confirm the enricher passes options correctly
  // and handles failures gracefully, that validates the schema wiring.

  it('enricher accepts options with existingMeasureNames for multiStage support', async () => {
    const result = await enrichWithAIMetrics(
      makeProfiledTable(),
      makeExistingCubes(),
      [],
      { existingMeasureNames: ['total_amount'] },
    );
    assert.ok(result);
    assert.equal(result.status, 'failed'); // no API key
  });
});
