import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateAIMetrics } from '../llmValidator.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const profilerFields = ['country', 'amount', 'event_date', 'user_id', 'count'];

const profiledTableColumns = ['country', 'amount', 'event_date', 'user_id', 'status', 'is_active'];

const existingMeasureNames = ['count', 'total_amount', 'avg_amount'];

function makeMetric(overrides = {}) {
  return {
    name: 'avg_amount',
    sql: '{CUBE}.amount',
    type: 'avg',
    fieldType: 'measure',
    description: 'Average amount',
    ai_generation_context: 'Average of the amount column',
    source_columns: ['amount'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateAIMetrics', () => {
  it('valid metric passes validation (returned in valid array)', () => {
    const metrics = [makeMetric()];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 1);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.valid[0].name, 'avg_amount');
  });

  it('unbalanced parentheses in sql rejects metric', () => {
    const metrics = [makeMetric({ sql: '{CUBE}.amount / nullIf(({CUBE}.count, 0)' })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].reasons.some((r) => /parenthes/i.test(r)));
  });

  it('dangerous SQL keyword DROP in sql rejects metric', () => {
    const metrics = [makeMetric({ sql: 'DROP TABLE events' })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].reasons.some((r) => /dangerous|keyword|DROP/i.test(r)));
  });

  it('invalid template var like {TABLE} is rejected', () => {
    const metrics = [makeMetric({ sql: '{TABLE}.amount' })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].reasons.some((r) => /template|var/i.test(r)));
  });

  it('valid {CUBE} and {FILTER_PARAMS} template vars accepted', () => {
    const metrics = [
      makeMetric({ sql: '{CUBE}.amount + {FILTER_PARAMS.event_date.filter(filterParam)}' }),
    ];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    // Should not be rejected for template var reasons
    const templateRejects = (result.rejected[0]?.reasons || []).filter((r) =>
      /template|var/i.test(r),
    );
    assert.equal(templateRejects.length, 0);
  });

  it('name collision with profiler field gets _ai suffix', () => {
    // 'amount' is already a profiler field name
    const metrics = [makeMetric({ name: 'amount' })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 1);
    assert.equal(result.valid[0].name, 'amount_ai');
  });

  it('invalid Cube.js type rejected', () => {
    const metrics = [makeMetric({ type: 'foo' })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].reasons.some((r) => /type/i.test(r)));
  });

  it('all valid measure types accepted', () => {
    const validTypes = [
      'number', 'numberAgg', 'rank',
      'sum', 'avg', 'count', 'countDistinct', 'countDistinctApprox',
      'min', 'max', 'runningTotal', 'string', 'boolean', 'time',
    ];
    for (const type of validTypes) {
      const metrics = [makeMetric({ name: `metric_${type}`, type })];
      const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
      assert.equal(
        result.valid.length,
        1,
        `type '${type}' should be accepted but was rejected: ${JSON.stringify(result.rejected)}`,
      );
    }
  });

  it('{CUBE}.column_name references validated against profiledTableColumns — hallucinated column rejected', () => {
    const metrics = [
      makeMetric({
        sql: '{CUBE}.nonexistent_column',
        source_columns: ['amount'],
      }),
    ];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].reasons.some((r) => /column|reference|hallucin/i.test(r)));
  });

  it('source_columns entries validated as raw ClickHouse column names', () => {
    const metrics = [
      makeMetric({
        source_columns: ['nonexistent_column'],
      }),
    ];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].reasons.some((r) => /source_column|column/i.test(r)));
  });

  it('empty metrics array returns { valid: [], rejected: [] }', () => {
    const result = validateAIMetrics([], profilerFields, profiledTableColumns);
    assert.deepEqual(result, { valid: [], rejected: [] });
  });
});

// ---------------------------------------------------------------------------
// Measure reference template vars
// ---------------------------------------------------------------------------

describe('measure reference template vars', () => {
  it('{measure_name} accepted when measure exists in existingMeasureNames', () => {
    const metrics = [makeMetric({
      name: 'yoy_amount',
      sql: '{total_amount}',
      type: 'number',
      multiStage: true,
      referencedMeasures: ['total_amount'],
      source_columns: [],
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns, existingMeasureNames);
    assert.equal(result.valid.length, 1);
    assert.equal(result.rejected.length, 0);
  });

  it('{nonexistent_measure} rejected when not in existingMeasureNames', () => {
    const metrics = [makeMetric({
      name: 'bad_ref',
      sql: '{nonexistent_measure}',
      type: 'number',
      source_columns: ['amount'],
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns, existingMeasureNames);
    assert.equal(result.valid.length, 0);
    assert.ok(result.rejected[0].reasons.some((r) => /template.*var/i.test(r)));
  });
});

// ---------------------------------------------------------------------------
// Multi-stage skip logic
// ---------------------------------------------------------------------------

describe('multiStage skip logic', () => {
  it('multiStage: true skips column reference and source_columns checks', () => {
    const metrics = [makeMetric({
      name: 'yoy_total',
      sql: '{total_amount}',
      type: 'number',
      multiStage: true,
      referencedMeasures: ['total_amount'],
      source_columns: [],
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns, existingMeasureNames);
    assert.equal(result.valid.length, 1);
    assert.equal(result.rejected.length, 0);
  });

  it('multiStage: false does NOT skip column reference checks', () => {
    const metrics = [makeMetric({
      name: 'bad_ref',
      sql: '{CUBE}.nonexistent',
      type: 'number',
      source_columns: ['amount'],
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns, existingMeasureNames);
    assert.equal(result.valid.length, 0);
    assert.ok(result.rejected[0].reasons.some((r) => /column|hallucin/i.test(r)));
  });
});

// ---------------------------------------------------------------------------
// checkRollingWindow
// ---------------------------------------------------------------------------

describe('checkRollingWindow', () => {
  it('valid to_date rollingWindow accepted', () => {
    const metrics = [makeMetric({
      name: 'ytd_amount',
      rollingWindow: { type: 'to_date', granularity: 'year' },
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 1);
    assert.equal(result.rejected.length, 0);
  });

  it('invalid rollingWindow.type rejected', () => {
    const metrics = [makeMetric({
      name: 'bad_rw',
      rollingWindow: { type: 'invalid' },
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 0);
    assert.ok(result.rejected[0].reasons.some((r) => /rollingWindow\.type/i.test(r)));
  });

  it('invalid to_date granularity rejected', () => {
    const metrics = [makeMetric({
      name: 'bad_gran',
      rollingWindow: { type: 'to_date', granularity: 'week' },
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 0);
    assert.ok(result.rejected[0].reasons.some((r) => /granularity/i.test(r)));
  });

  it('valid fixed rollingWindow with trailing accepted', () => {
    const metrics = [makeMetric({
      name: 'rolling_7d',
      rollingWindow: { type: 'fixed', trailing: '7 days' },
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 1);
  });

  it('invalid fixed trailing format rejected', () => {
    const metrics = [makeMetric({
      name: 'bad_trailing',
      rollingWindow: { type: 'fixed', trailing: 'seven days' },
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 0);
    assert.ok(result.rejected[0].reasons.some((r) => /trailing/i.test(r)));
  });
});

// ---------------------------------------------------------------------------
// checkTimeShift
// ---------------------------------------------------------------------------

describe('checkTimeShift', () => {
  it('valid timeShift with multiStage accepted', () => {
    const metrics = [makeMetric({
      name: 'yoy_amount',
      sql: '{total_amount}',
      type: 'number',
      multiStage: true,
      timeShift: [{ interval: '1 year', type: 'prior' }],
      referencedMeasures: ['total_amount'],
      source_columns: [],
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns, existingMeasureNames);
    assert.equal(result.valid.length, 1);
  });

  it('timeShift without multiStage rejected', () => {
    const metrics = [makeMetric({
      name: 'bad_ts',
      timeShift: [{ interval: '1 year', type: 'prior' }],
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);
    assert.equal(result.valid.length, 0);
    assert.ok(result.rejected[0].reasons.some((r) => /multiStage/i.test(r)));
  });

  it('invalid timeShift interval format rejected', () => {
    const metrics = [makeMetric({
      name: 'bad_interval',
      sql: '{total_amount}',
      type: 'number',
      multiStage: true,
      timeShift: [{ interval: 'one year', type: 'prior' }],
      referencedMeasures: ['total_amount'],
      source_columns: [],
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns, existingMeasureNames);
    assert.equal(result.valid.length, 0);
    assert.ok(result.rejected[0].reasons.some((r) => /interval/i.test(r)));
  });

  it('invalid timeShift type rejected', () => {
    const metrics = [makeMetric({
      name: 'bad_ts_type',
      sql: '{total_amount}',
      type: 'number',
      multiStage: true,
      timeShift: [{ interval: '1 year', type: 'backward' }],
      referencedMeasures: ['total_amount'],
      source_columns: [],
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns, existingMeasureNames);
    assert.equal(result.valid.length, 0);
    assert.ok(result.rejected[0].reasons.some((r) => /type.*prior.*next/i.test(r)));
  });
});

// ---------------------------------------------------------------------------
// checkReferencedMeasures
// ---------------------------------------------------------------------------

describe('checkReferencedMeasures', () => {
  it('valid referencedMeasures accepted', () => {
    const metrics = [makeMetric({
      name: 'derived',
      sql: '{total_amount}',
      type: 'number',
      multiStage: true,
      referencedMeasures: ['total_amount', 'avg_amount'],
      source_columns: [],
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns, existingMeasureNames);
    assert.equal(result.valid.length, 1);
  });

  it('nonexistent referencedMeasures rejected', () => {
    const metrics = [makeMetric({
      name: 'bad_ref',
      sql: '{nonexistent}',
      type: 'number',
      multiStage: true,
      referencedMeasures: ['nonexistent'],
      source_columns: [],
    })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns, existingMeasureNames);
    assert.equal(result.valid.length, 0);
    assert.ok(result.rejected[0].reasons.some((r) => /referencedMeasures/i.test(r)));
  });
});
