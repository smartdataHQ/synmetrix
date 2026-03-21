import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import YAML from 'yaml';

import { buildCubes } from '../cubeBuilder.js';
import { generateJs } from '../yamlGenerator.js';
import { mergeModels } from '../merger.js';
import { parseCubesFromJs } from '../diffModels.js';
import { ColumnType, ValueType } from '../typeParser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ProfiledTable for testing.
 */
function makeProfiledTable(overrides = {}) {
  const columns = new Map();
  columns.set('id', {
    name: 'id',
    rawType: 'UInt64',
    columnType: ColumnType.BASIC,
    valueType: ValueType.NUMBER,
    profile: { hasValues: true, uniqueValues: 100, minValue: 1, maxValue: 100 },
  });
  columns.set('name', {
    name: 'name',
    rawType: 'String',
    columnType: ColumnType.BASIC,
    valueType: ValueType.STRING,
    profile: { hasValues: true, uniqueValues: 50 },
  });

  return {
    database: 'test_db',
    table: 'test_table',
    row_count: 1000,
    sampled: false,
    sample_size: 1000,
    columns,
    columnDescriptions: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: generation_filters is present in cube meta when filters are provided
// ---------------------------------------------------------------------------

describe('Filter Persistence — generation_filters in cube meta', () => {
  it('includes generation_filters in cube meta when filters are set', () => {
    const profiledTable = makeProfiledTable();
    const cubeResult = buildCubes(profiledTable, { primaryKeys: ['id'] });

    const filters = [
      { column: 'status', operator: '=', value: 'active' },
      { column: 'created_at', operator: '>=', value: '2025-01-01' },
    ];

    // Simulate what smartGenerate.js does: stamp filters onto cube meta
    for (const cube of cubeResult.cubes) {
      if (!cube.meta) cube.meta = {};
      cube.meta.generation_filters = filters;
    }

    // Generate JS output
    const jsContent = generateJs(cubeResult.cubes);

    // Parse back and verify generation_filters is present
    const parsed = parseCubesFromJs(jsContent);
    assert.ok(parsed, 'should parse JS content');
    assert.ok(parsed.length > 0, 'should have at least one cube');

    const cubeMeta = parsed[0].meta;
    assert.ok(cubeMeta, 'cube should have meta');
    assert.ok(Array.isArray(cubeMeta.generation_filters), 'generation_filters should be an array');
    assert.equal(cubeMeta.generation_filters.length, 2);
  });

  it('does not include generation_filters when no filters are provided', () => {
    const profiledTable = makeProfiledTable();
    const cubeResult = buildCubes(profiledTable, { primaryKeys: ['id'] });

    // No filters stamped — generation_filters should be absent
    const jsContent = generateJs(cubeResult.cubes);
    const parsed = parseCubesFromJs(jsContent);
    assert.ok(parsed, 'should parse JS content');

    const cubeMeta = parsed[0].meta;
    assert.equal(cubeMeta.generation_filters, undefined, 'generation_filters should be absent');
  });
});

// ---------------------------------------------------------------------------
// Test 2: generation_filters is overwritten (not preserved) on regeneration
// ---------------------------------------------------------------------------

describe('Filter Persistence — generation_filters overwritten on merge', () => {
  it('overwrites old generation_filters with new provenance keys during merge', () => {
    const profiledTable = makeProfiledTable();

    // Build "old" model with filters A
    const oldResult = buildCubes(profiledTable, { primaryKeys: ['id'] });
    const oldFilters = [{ column: 'status', operator: '=', value: 'active' }];
    for (const cube of oldResult.cubes) {
      if (!cube.meta) cube.meta = {};
      cube.meta.generation_filters = oldFilters;
    }
    const oldJs = generateJs(oldResult.cubes);

    // Build "new" model with filters B
    const newResult = buildCubes(profiledTable, { primaryKeys: ['id'] });
    const newFilters = [
      { column: 'region', operator: '=', value: 'US' },
      { column: 'year', operator: '>=', value: '2026' },
    ];
    for (const cube of newResult.cubes) {
      if (!cube.meta) cube.meta = {};
      cube.meta.generation_filters = newFilters;
    }
    const newJs = generateJs(newResult.cubes);

    // Merge — generation_filters is a provenance key, so it should be
    // overwritten by the new model's value.
    // mergeModels returns JS when inputs are JS — parse accordingly.
    const merged = mergeModels(oldJs, newJs, 'merge');
    const parsedCubes = parseCubesFromJs(merged);

    assert.ok(parsedCubes, 'merged content should parse');
    const mergedMeta = parsedCubes[0].meta;
    assert.ok(Array.isArray(mergedMeta.generation_filters), 'should have generation_filters');
    assert.equal(mergedMeta.generation_filters.length, 2, 'should have new filter count');

    // Verify the filters are the NEW ones, not the old ones
    // The JS serialization stores arrays via JSON.stringify, so values are preserved
    const firstFilter = mergedMeta.generation_filters[0];
    // The merger overwrites provenance keys — check new values are present
    assert.ok(
      JSON.stringify(mergedMeta.generation_filters).includes('region') ||
      JSON.stringify(mergedMeta.generation_filters).includes('US'),
      'merged filters should contain new filter values, not old ones'
    );
  });

  it('removes generation_filters when new model has none', () => {
    const profiledTable = makeProfiledTable();

    // Build "old" model with filters
    const oldResult = buildCubes(profiledTable, { primaryKeys: ['id'] });
    for (const cube of oldResult.cubes) {
      if (!cube.meta) cube.meta = {};
      cube.meta.generation_filters = [{ column: 'status', operator: '=', value: 'active' }];
    }
    const oldJs = generateJs(oldResult.cubes);

    // Build "new" model WITHOUT filters
    const newResult = buildCubes(profiledTable, { primaryKeys: ['id'] });
    const newJs = generateJs(newResult.cubes);

    // Merge — provenance key generation_filters should not be preserved from old
    const merged = mergeModels(oldJs, newJs, 'merge');
    const parsedCubes = parseCubesFromJs(merged);

    assert.ok(parsedCubes, 'merged content should parse');
    const mergedMeta = parsedCubes[0].meta;
    assert.equal(
      mergedMeta.generation_filters,
      undefined,
      'generation_filters should not be carried over from old model'
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3: Extraction of previous_filters from existing model
// ---------------------------------------------------------------------------

describe('Filter Persistence — extracting previous_filters from existing model', () => {
  it('extracts generation_filters from an existing JS model', () => {
    const profiledTable = makeProfiledTable();
    const cubeResult = buildCubes(profiledTable, { primaryKeys: ['id'] });

    const storedFilters = [
      { column: 'status', operator: '=', value: 'active' },
      { column: 'created_at', operator: '>=', value: '2025-01-01' },
    ];

    for (const cube of cubeResult.cubes) {
      if (!cube.meta) cube.meta = {};
      cube.meta.generation_filters = storedFilters;
    }

    const jsContent = generateJs(cubeResult.cubes);

    // Parse the JS model and extract generation_filters (as profileTable/smartGenerate would)
    const parsed = parseCubesFromJs(jsContent);
    assert.ok(parsed, 'should parse');

    // Extract generation_filters from the first cube that has it
    let previousFilters = null;
    for (const cube of parsed) {
      if (cube.meta?.generation_filters) {
        previousFilters = cube.meta.generation_filters;
        break;
      }
    }

    assert.ok(Array.isArray(previousFilters), 'previous_filters should be an array');
    assert.equal(previousFilters.length, 2);
  });

  it('returns null when existing model has no generation_filters', () => {
    const profiledTable = makeProfiledTable();
    const cubeResult = buildCubes(profiledTable, { primaryKeys: ['id'] });

    // No generation_filters set
    const jsContent = generateJs(cubeResult.cubes);

    const parsed = parseCubesFromJs(jsContent);
    assert.ok(parsed, 'should parse');

    let previousFilters = null;
    for (const cube of parsed) {
      if (cube.meta?.generation_filters) {
        previousFilters = cube.meta.generation_filters;
        break;
      }
    }

    assert.equal(previousFilters, null, 'previous_filters should be null when not stored');
  });

  it('returns null when content cannot be parsed', () => {
    const parsed = parseCubesFromJs('this is not valid cube js');
    assert.equal(parsed, null, 'should return null for unparseable content');
  });
});
