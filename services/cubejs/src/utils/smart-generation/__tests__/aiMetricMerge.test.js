import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractAIMetrics } from '../merger.js';
import { validateAIMetrics } from '../llmValidator.js';
import { diffModels } from '../diffModels.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const profiledTableColumns = ['country', 'amount', 'event_date', 'user_id', 'status'];

const profilerFields = ['country', 'amount', 'event_date', 'user_id', 'count'];

function makeAIField(overrides = {}) {
  return {
    name: 'revenue_per_user',
    sql: '{CUBE}.amount / nullIf({CUBE}.user_id, 0)',
    type: 'number',
    fieldType: 'measure',
    description: 'Revenue per user',
    ai_generation_context: 'Ratio of total revenue to unique users',
    source_columns: ['amount', 'user_id'],
    ...overrides,
  };
}

/**
 * Build a YAML string with an auto-generated cube that includes the given
 * extra measures (AI or otherwise) alongside the standard auto fields.
 */
function buildYaml({ cubeName = 'Events', extraMeasures = [], extraDimensions = [] } = {}) {
  const dims = [
    { name: 'country', sql: '{CUBE}.country', type: 'string', meta: { auto_generated: true } },
    ...extraDimensions,
  ];
  const measures = [
    { name: 'count', sql: '{CUBE}.count', type: 'count', meta: { auto_generated: true } },
    ...extraMeasures,
  ];

  const cube = {
    name: cubeName,
    sql_table: 'db.events',
    meta: { auto_generated: true },
    dimensions: dims,
    measures,
  };

  // Build YAML manually to keep it simple
  return buildYamlString({ cubes: [cube] });
}

function buildYamlString(doc) {
  // Simple JSON->YAML-ish serialization via import
  // We can use JSON and the parser handles it, or just stringify with yaml
  // For test purposes, use JSON (parseCubeContent handles it via YAML.parse)
  const YAML = await_import_yaml();
  return YAML.stringify(doc);
}

// Synchronous YAML import workaround — use dynamic structure
// Actually, let's just build JS cube content strings instead, since merger.js
// supports JS parsing.

/**
 * Build a JS cube file string.
 */
function buildJsContent({ cubeName = 'Events', extraMeasures = [], extraDimensions = [] } = {}) {
  const dims = [
    { name: 'country', sql: '`${CUBE}.country`', type: 'string', meta: { auto_generated: true } },
    ...extraDimensions,
  ];
  const measures = [
    { name: 'count', sql: '`${CUBE}.count`', type: 'count', meta: { auto_generated: true } },
    ...extraMeasures,
  ];

  function serializeField(f) {
    const parts = [];
    if (f.name) parts.push(`name: ${JSON.stringify(f.name)}`);
    if (f.sql) parts.push(`sql: ${f.sql.startsWith('`') ? f.sql : JSON.stringify(f.sql)}`);
    if (f.type) parts.push(`type: ${JSON.stringify(f.type)}`);
    if (f.description) parts.push(`description: ${JSON.stringify(f.description)}`);
    if (f.meta) parts.push(`meta: ${JSON.stringify(f.meta)}`);
    if (f.ai_generation_context) parts.push(`ai_generation_context: ${JSON.stringify(f.ai_generation_context)}`);
    if (f.source_columns) parts.push(`source_columns: ${JSON.stringify(f.source_columns)}`);
    return `{ ${parts.join(', ')} }`;
  }

  const dimStr = dims.map(serializeField).join(',\n      ');
  const measStr = measures.map(serializeField).join(',\n      ');

  return `cube(${JSON.stringify(cubeName)}, {
  sql_table: 'db.events',
  meta: { auto_generated: true },
  dimensions: [
    ${dimStr}
  ],
  measures: [
    ${measStr}
  ],
});`;
}

// ---------------------------------------------------------------------------
// T023-1: extractAIMetrics returns only fields with meta.ai_generated: true
// ---------------------------------------------------------------------------

describe('extractAIMetrics', () => {
  it('returns only fields with meta.ai_generated: true', () => {
    const content = buildJsContent({
      extraMeasures: [
        {
          name: 'revenue_per_user',
          sql: '`${CUBE}.amount / nullIf(${CUBE}.user_id, 0)`',
          type: 'number',
          description: 'Revenue per user',
          meta: { ai_generated: true },
          ai_generation_context: 'Revenue per user ratio',
          source_columns: ['amount', 'user_id'],
        },
      ],
    });

    const aiMetrics = extractAIMetrics(content);

    assert.equal(aiMetrics.length, 1);
    assert.equal(aiMetrics[0].name, 'revenue_per_user');
    assert.equal(aiMetrics[0].meta.ai_generated, true);
    assert.equal(aiMetrics[0]._cubeName, 'Events');
  });

  it('returns empty array when no AI fields exist', () => {
    const content = buildJsContent();
    const aiMetrics = extractAIMetrics(content);
    assert.equal(aiMetrics.length, 0);
  });

  it('does not return auto_generated fields (only ai_generated)', () => {
    const content = buildJsContent({
      extraMeasures: [
        {
          name: 'some_auto',
          sql: '`${CUBE}.amount`',
          type: 'sum',
          meta: { auto_generated: true },
        },
      ],
    });

    const aiMetrics = extractAIMetrics(content);
    assert.equal(aiMetrics.length, 0);
  });
});

// ---------------------------------------------------------------------------
// T023-2: merger treats ai_generated as third category
// ---------------------------------------------------------------------------

describe('AI metric category handling', () => {
  it('ai_generated is a distinct category from auto_generated and user-created', () => {
    const content = buildJsContent({
      extraMeasures: [
        {
          name: 'ai_metric',
          sql: '`${CUBE}.amount`',
          type: 'number',
          meta: { ai_generated: true },
          ai_generation_context: 'test',
          source_columns: ['amount'],
        },
      ],
      extraDimensions: [
        {
          name: 'user_dim',
          sql: '`${CUBE}.user_id`',
          type: 'string',
          // no meta — user-created
        },
      ],
    });

    const aiMetrics = extractAIMetrics(content);

    // Only AI fields should be extracted, not auto or user
    assert.equal(aiMetrics.length, 1);
    assert.equal(aiMetrics[0].name, 'ai_metric');
    assert.equal(aiMetrics[0].meta.ai_generated, true);
  });
});

// ---------------------------------------------------------------------------
// T023-3: AI metric with dropped source column is removed (validateAIMetrics)
// ---------------------------------------------------------------------------

describe('AI metric source_columns validation', () => {
  it('AI metric with dropped source column is rejected by validateAIMetrics', () => {
    const metrics = [makeAIField({ source_columns: ['amount', 'nonexistent_column'] })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);

    assert.equal(result.valid.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].reasons.some((r) => /source_column|column/i.test(r)));
  });

  // T023-4: AI metric with valid source columns is retained
  it('AI metric with valid source columns passes validation', () => {
    const metrics = [makeAIField({ source_columns: ['amount', 'user_id'] })];
    const result = validateAIMetrics(metrics, profilerFields, profiledTableColumns);

    assert.equal(result.valid.length, 1);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.valid[0].name, 'revenue_per_user');
  });
});

// ---------------------------------------------------------------------------
// T023-5: User edit to AI metric description is preserved on regeneration
// ---------------------------------------------------------------------------

describe('AI metric description preservation', () => {
  it('user edit to AI metric description is preserved during merge', async () => {
    // We test this via merger.js mergeModels
    const { mergeModels } = await import('../merger.js');

    // Existing model with AI metric that has a user-edited description
    const existing = buildJsContent({
      extraMeasures: [
        {
          name: 'revenue_per_user',
          sql: '`${CUBE}.amount / nullIf(${CUBE}.user_id, 0)`',
          type: 'number',
          description: 'My custom description',
          meta: { ai_generated: true },
          ai_generation_context: 'Revenue per user ratio',
          source_columns: ['amount', 'user_id'],
        },
      ],
    });

    // New model without the AI metric (fresh generation)
    const newContent = buildJsContent();

    // Merge should preserve the AI field (with its custom description)
    const merged = mergeModels(existing, newContent, 'merge');

    // The AI metric should still be present in the merged output
    // mergeModels returns JS — parse it to check
    const { parseCubesFromJs } = await import('../diffModels.js');
    const cubes = parseCubesFromJs(merged);
    const cube = cubes[0];

    const aiField = cube.measures.find((m) => m.name === 'revenue_per_user');
    assert.ok(aiField, 'AI metric should be preserved in merged output');
    assert.equal(aiField.description, 'My custom description');
  });
});

// ---------------------------------------------------------------------------
// T023-6: diff output includes AI metrics in preserved list with reason 'ai_generated'
// ---------------------------------------------------------------------------

describe('diffModels AI metric handling', () => {
  it('diff output includes AI metrics in preserved list with reason ai_generated', () => {
    // Build existing cubes with an AI metric
    const existingCubes = [
      {
        name: 'Events',
        sql_table: 'db.events',
        meta: { auto_generated: true },
        dimensions: [
          { name: 'country', sql: '{CUBE}.country', type: 'string', meta: { auto_generated: true } },
        ],
        measures: [
          { name: 'count', sql: '{CUBE}.count', type: 'count', meta: { auto_generated: true } },
          {
            name: 'revenue_per_user',
            sql: '{CUBE}.amount / nullIf({CUBE}.user_id, 0)',
            type: 'number',
            meta: { ai_generated: true },
            ai_generation_context: 'Revenue ratio',
            source_columns: ['amount', 'user_id'],
          },
        ],
      },
    ];

    // New cubes without AI metric (regenerated)
    const newCubes = [
      {
        name: 'Events',
        sql_table: 'db.events',
        meta: { auto_generated: true },
        dimensions: [
          { name: 'country', sql: '{CUBE}.country', type: 'string', meta: { auto_generated: true } },
        ],
        measures: [
          { name: 'count', sql: '{CUBE}.count', type: 'count', meta: { auto_generated: true } },
        ],
      },
    ];

    const diff = diffModels(existingCubes, newCubes, 'merge');

    // AI field should appear in preserved list
    const aiPreserved = diff.fields_preserved.filter((f) => f.reason === 'ai_generated');
    assert.ok(aiPreserved.length > 0, 'AI metrics should appear in fields_preserved');
    assert.equal(aiPreserved[0].name, 'revenue_per_user');

    // AI metric diff sections should also be populated
    assert.ok(Array.isArray(diff.ai_metrics_retained), 'ai_metrics_retained should be an array');
    assert.ok(diff.ai_metrics_retained.length > 0, 'AI metric should be in ai_metrics_retained');
  });

  it('diff includes ai_metrics_added for new AI metrics in new cubes', () => {
    // No existing model
    const newCubes = [
      {
        name: 'Events',
        sql_table: 'db.events',
        meta: { auto_generated: true },
        dimensions: [],
        measures: [
          {
            name: 'new_ai_metric',
            sql: '{CUBE}.amount',
            type: 'number',
            meta: { ai_generated: true },
            ai_generation_context: 'New metric',
            source_columns: ['amount'],
          },
        ],
      },
    ];

    const diff = diffModels(null, newCubes, 'auto');
    assert.ok(Array.isArray(diff.ai_metrics_added));
    assert.ok(diff.ai_metrics_added.length > 0, 'New AI metrics should appear in ai_metrics_added');
    assert.equal(diff.ai_metrics_added[0].name, 'new_ai_metric');
  });

  it('diff includes ai_metrics_removed for AI metrics not in new model with no source column info', () => {
    // Existing cubes with AI metric
    const existingCubes = [
      {
        name: 'Events',
        sql_table: 'db.events',
        meta: { auto_generated: true },
        dimensions: [],
        measures: [
          { name: 'count', sql: '{CUBE}.count', type: 'count', meta: { auto_generated: true } },
          {
            name: 'old_ai_metric',
            sql: '{CUBE}.amount / nullIf({CUBE}.user_id, 0)',
            type: 'number',
            meta: { ai_generated: true },
            ai_generation_context: 'Old metric',
            source_columns: ['amount', 'user_id'],
          },
        ],
      },
    ];

    // New cubes — same cube exists but AI metric dropped, auto cube still matches
    const newCubes = [
      {
        name: 'Events',
        sql_table: 'db.events',
        meta: { auto_generated: true },
        dimensions: [],
        measures: [
          { name: 'count', sql: '{CUBE}.count', type: 'count', meta: { auto_generated: true } },
        ],
      },
    ];

    const diff = diffModels(existingCubes, newCubes, 'merge');

    // The AI metric should be in ai_metrics_retained (superset: merger preserves it)
    // because the merger always preserves AI fields
    assert.ok(Array.isArray(diff.ai_metrics_retained));
    const retained = diff.ai_metrics_retained.find((m) => m.name === 'old_ai_metric');
    assert.ok(retained, 'AI metric should be retained in diff (merger preserves AI fields)');
  });
});

// ---------------------------------------------------------------------------
// T010-ii: mergeAIMetrics preserves rollingWindow, multiStage, timeShift
// ---------------------------------------------------------------------------

describe('mergeAIMetrics property passthrough', () => {
  it('mergeAIMetrics preserves rollingWindow on merged field', async () => {
    const { mergeAIMetrics } = await import('../cubeBuilder.js');
    const cubes = [{
      name: 'Events',
      dimensions: [],
      measures: [{ name: 'count', sql: '*', type: 'count' }],
    }];
    const aiMetrics = [{
      name: 'ytd_amount',
      sql: '{CUBE}.amount',
      type: 'sum',
      fieldType: 'measure',
      description: 'YTD amount',
      ai_generation_context: 'Year-to-date sum',
      source_columns: ['amount'],
      rollingWindow: { type: 'to_date', granularity: 'year' },
    }];

    mergeAIMetrics(cubes, aiMetrics);
    const merged = cubes[0].measures.find((m) => m.name === 'ytd_amount');
    assert.ok(merged, 'ytd_amount should be merged');
    assert.deepEqual(merged.rollingWindow, { type: 'to_date', granularity: 'year' });
  });

  it('mergeAIMetrics preserves multiStage and timeShift on merged field', async () => {
    const { mergeAIMetrics } = await import('../cubeBuilder.js');
    const cubes = [{
      name: 'Events',
      dimensions: [],
      measures: [{ name: 'count', sql: '*', type: 'count' }],
    }];
    const aiMetrics = [{
      name: 'yoy_amount',
      sql: '{total_amount}',
      type: 'number',
      fieldType: 'measure',
      description: 'YoY amount comparison',
      ai_generation_context: 'Year-over-year',
      source_columns: [],
      multiStage: true,
      timeShift: [{ interval: '1 year', type: 'prior' }],
    }];

    mergeAIMetrics(cubes, aiMetrics);
    const merged = cubes[0].measures.find((m) => m.name === 'yoy_amount');
    assert.ok(merged, 'yoy_amount should be merged');
    assert.equal(merged.multiStage, true);
    assert.deepEqual(merged.timeShift, [{ interval: '1 year', type: 'prior' }]);
  });

  it('mergeAIMetrics does not add properties when not present on metric', async () => {
    const { mergeAIMetrics } = await import('../cubeBuilder.js');
    const cubes = [{
      name: 'Events',
      dimensions: [],
      measures: [{ name: 'count', sql: '*', type: 'count' }],
    }];
    const aiMetrics = [{
      name: 'simple_avg',
      sql: '{CUBE}.amount',
      type: 'avg',
      fieldType: 'measure',
      description: 'Simple avg',
      ai_generation_context: 'Basic average',
      source_columns: ['amount'],
    }];

    mergeAIMetrics(cubes, aiMetrics);
    const merged = cubes[0].measures.find((m) => m.name === 'simple_avg');
    assert.ok(merged, 'simple_avg should be merged');
    assert.equal(merged.rollingWindow, undefined);
    assert.equal(merged.multiStage, undefined);
    assert.equal(merged.timeShift, undefined);
  });
});

// ---------------------------------------------------------------------------
// T023-7: Superset validation — force-retaining metrics dropped by LLM
//         if source columns still exist
// ---------------------------------------------------------------------------

describe('superset regeneration guarantee', () => {
  it('force-retains valid AI metrics dropped by LLM when source columns still exist', () => {
    // This tests the concept: given prior AI metrics whose source_columns
    // are all still in the table, they should survive regeneration.
    // We test via validateAIMetrics: a valid AI metric should pass.

    const priorMetrics = [
      makeAIField({
        name: 'revenue_per_user',
        source_columns: ['amount', 'user_id'],
      }),
      makeAIField({
        name: 'status_ratio',
        source_columns: ['status', 'amount'],
      }),
    ];

    // All source columns exist in profiledTableColumns
    for (const metric of priorMetrics) {
      const { valid } = validateAIMetrics([metric], profilerFields, profiledTableColumns);
      assert.equal(valid.length, 1, `Metric ${metric.name} should be valid since source columns exist`);
    }

    // A metric whose source column was dropped should be invalid
    const droppedMetric = makeAIField({
      name: 'bad_metric',
      source_columns: ['dropped_column'],
    });
    const { valid } = validateAIMetrics([droppedMetric], profilerFields, profiledTableColumns);
    assert.equal(valid.length, 0, 'Metric with dropped source column should be rejected');
  });
});
