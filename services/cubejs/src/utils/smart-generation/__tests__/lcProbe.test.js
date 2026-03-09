import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { buildWhereClause, profileTable } from '../profiler.js';
import { buildCubes } from '../cubeBuilder.js';
import { generateYaml } from '../yamlGenerator.js';
import { ColumnType, ValueType } from '../typeParser.js';
import YAML from 'yaml';

/**
 * Mock driver for the multi-pass profiler.
 *
 * The profiler flow:
 *   Pass 0: DESCRIBE TABLE + system.parts_columns (parallel)
 *   Pass 1: Initial profile (count() as row_count + aggregates)
 *   Pass 2: Deep profiling (map key discovery + nested sub-columns)
 *   Pass 3: LC probe + map stats
 */
function createMockDriver(responses = {}) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      for (const [pattern, result] of Object.entries(responses)) {
        if (sql.includes(pattern)) {
          if (typeof result === 'function') return result(sql);
          return result;
        }
      }
      return [];
    },
  };
}

describe('LC probe – profiler Pass 3', () => {
  it('should enumerate values for basic columns with <200 unique values', async () => {
    const driver = createMockDriver({
      'system.parts_columns': [],
      'DESCRIBE TABLE': [
        { name: 'status', type: 'String' },
        { name: 'count', type: 'UInt64' },
      ],
      // SAMPLE probe — not supported
      'SAMPLE': (sql) => { throw new Error("Storage doesn't support sampling"); },
      // Pass 1: Initial profile — status has 3 unique values (low cardinality)
      'count() as row_count': [{ row_count: 100, status__count: 3, count__min: 1, count__max: 500, count__avg: 250 }],
      // Pass 3: LC probe
      'groupUniqArray': [{ status__lc_values: ['active', 'inactive', 'pending'] }],
    });

    const result = await profileTable(driver, 'db', 'statuses');
    const statusCol = result.columns.get('status');
    assert.ok(statusCol, 'status column should exist');
    assert.deepStrictEqual(statusCol.profile.lcValues, ['active', 'inactive', 'pending']);
  });

  it('should NOT enumerate values for columns with >=200 unique values', async () => {
    const driver = createMockDriver({
      'system.parts_columns': [],
      'DESCRIBE TABLE': [
        { name: 'user_id', type: 'String' },
      ],
      'SAMPLE': (sql) => { throw new Error("Storage doesn't support sampling"); },
      // Pass 1: user_id has 5000 unique values — too high for LC probe
      'count() as row_count': [{ row_count: 10000, user_id__count: 5000 }],
    });

    const result = await profileTable(driver, 'db', 'users');
    const col = result.columns.get('user_id');
    assert.ok(col, 'user_id column should exist');
    assert.strictEqual(col.profile.lcValues, null, 'High-cardinality column should not have lcValues');
  });

  it('should skip LC probe for columns with no values', async () => {
    const driver = createMockDriver({
      'system.parts_columns': [],
      'DESCRIBE TABLE': [
        { name: 'empty_col', type: 'String' },
      ],
      'SAMPLE': (sql) => { throw new Error("Storage doesn't support sampling"); },
      // Pass 1: empty_col has 0 unique values
      'count() as row_count': [{ row_count: 100, empty_col__count: 0 }],
    });

    const result = await profileTable(driver, 'db', 'test');
    const col = result.columns.get('empty_col');
    assert.ok(col);
    assert.strictEqual(col.profile.lcValues, null);
  });

  it('should probe LC values per key for Map columns', async () => {
    const driver = createMockDriver({
      'system.parts_columns': [],
      'DESCRIBE TABLE': [
        { name: 'props', type: 'Map(String, String)' },
      ],
      'SAMPLE': (sql) => { throw new Error("Storage doesn't support sampling"); },
      // Pass 1: Initial profile — props has 2 keys
      'count() as row_count': [{ row_count: 100, props__key_count: 2 }],
      // Pass 2: Deep profiling discovers the actual keys
      'groupUniqArrayArray(200)(mapKeys': [{ props__map_keys: ['env', 'region'], props__value_rows: 100 }],
      // Pass 3a: Per-key cardinality check (uniq per key) — both are low cardinality
      '__uniq': [{ props_k_env__uniq: 2, props_k_region__uniq: 4 }],
      // Pass 3b: LC probe for low-cardinality map keys (uses CAST)
      'CAST': [{ props_k_env__lc_values: ['prod', 'staging'], props_k_region__lc_values: ['us-east', 'eu-west'] }],
    });

    const result = await profileTable(driver, 'db', 'config');
    const col = result.columns.get('props');
    assert.ok(col);
    assert.ok(typeof col.profile.lcValues === 'object' && !Array.isArray(col.profile.lcValues),
      'Map column lcValues should be an object');
    assert.deepStrictEqual(col.profile.lcValues.env, ['prod', 'staging']);
    assert.deepStrictEqual(col.profile.lcValues.region, ['us-east', 'eu-west']);
  });

  it('should handle LC probe query failure gracefully', async () => {
    let lcQuerySeen = false;
    const driver = {
      async query(sql) {
        if (sql.includes('system.parts_columns')) return [];
        if (sql.includes('SAMPLE') && sql.includes('LIMIT 1')) {
          throw new Error("Storage doesn't support sampling");
        }
        if (sql.includes('DESCRIBE TABLE')) {
          return [{ name: 'status', type: 'String' }];
        }
        // Pass 1: Initial profile — status has 3 unique values
        if (sql.includes('count() as row_count')) {
          return [{ row_count: 100, status__count: 3 }];
        }
        // Pass 3: LC probe fails
        if (sql.includes('groupUniqArray(')) {
          lcQuerySeen = true;
          throw new Error('LC query timeout');
        }
        return [];
      },
    };

    const result = await profileTable(driver, 'db', 'test');
    assert.ok(lcQuerySeen, 'LC probe query should have been attempted');
    const col = result.columns.get('status');
    assert.strictEqual(col.profile.lcValues, null, 'lcValues should remain null on failure');
  });
});

describe('LC probe – cubeBuilder propagation', () => {
  it('should attach lc_values to field meta for basic columns', () => {
    const columns = new Map([
      ['status', {
        name: 'status',
        rawType: 'String',
        columnType: ColumnType.BASIC,
        valueType: ValueType.STRING,
        isNullable: false,
        profile: { hasValues: true, valueRows: 100, uniqueValues: 3, uniqueKeys: [], lcValues: ['a', 'b', 'c'], minValue: null, maxValue: null },
      }],
    ]);

    const { cubes } = buildCubes({ database: 'db', table: 'test', partition: null, columns });
    const dim = cubes[0].dimensions.find(d => d.name === 'status');
    assert.ok(dim, 'status dimension should exist');
    assert.deepStrictEqual(dim.meta.lc_values, ['a', 'b', 'c']);
  });

  it('should attach per-key lc_values to Map-expanded fields', () => {
    const columns = new Map([
      ['props', {
        name: 'props',
        rawType: 'Map(String, String)',
        columnType: ColumnType.MAP,
        valueType: ValueType.STRING,
        isNullable: false,
        profile: {
          hasValues: true, valueRows: 100, uniqueValues: 0,
          uniqueKeys: ['env', 'region'],
          lcValues: { env: ['prod', 'staging'], region: ['us', 'eu'] },
          minValue: null, maxValue: null,
        },
      }],
    ]);

    const { cubes } = buildCubes({ database: 'db', table: 'test', partition: null, columns });
    const envDim = cubes[0].dimensions.find(d => d.name === 'props_env');
    const regionDim = cubes[0].dimensions.find(d => d.name === 'props_region');
    assert.ok(envDim);
    assert.ok(regionDim);
    assert.deepStrictEqual(envDim.meta.lc_values, ['prod', 'staging']);
    assert.deepStrictEqual(regionDim.meta.lc_values, ['us', 'eu']);
  });

  it('should NOT attach lc_values when profile has no lcValues', () => {
    const columns = new Map([
      ['name', {
        name: 'name',
        rawType: 'String',
        columnType: ColumnType.BASIC,
        valueType: ValueType.STRING,
        isNullable: false,
        profile: { hasValues: true, valueRows: 100, uniqueValues: 5000, uniqueKeys: [], lcValues: null, minValue: null, maxValue: null },
      }],
    ]);

    const { cubes } = buildCubes({ database: 'db', table: 'test', partition: null, columns });
    const dim = cubes[0].dimensions.find(d => d.name === 'name');
    assert.ok(dim);
    assert.strictEqual(dim.meta.lc_values, undefined, 'Should not have lc_values in meta');
  });
});

describe('LC probe – YAML generator embedding', () => {
  it('should include lc_values in field-level meta in generated YAML', () => {
    const cubeDefinitions = [{
      name: 'test',
      sql_table: 'db.test',
      meta: { auto_generated: true },
      dimensions: [{
        name: 'status',
        sql: '{CUBE}.status',
        type: 'string',
        meta: { auto_generated: true, lc_values: ['active', 'inactive'] },
      }],
      measures: [],
    }];

    const yaml = generateYaml(cubeDefinitions);
    const parsed = YAML.parse(yaml);
    const dim = parsed.cubes[0].dimensions[0];
    assert.deepStrictEqual(dim.meta.lc_values, ['active', 'inactive']);
  });

  it('should not include lc_values key when not present', () => {
    const cubeDefinitions = [{
      name: 'test',
      sql_table: 'db.test',
      meta: { auto_generated: true },
      dimensions: [{
        name: 'id',
        sql: '{CUBE}.id',
        type: 'string',
        meta: { auto_generated: true },
      }],
      measures: [],
    }];

    const yaml = generateYaml(cubeDefinitions);
    const parsed = YAML.parse(yaml);
    const dim = parsed.cubes[0].dimensions[0];
    assert.strictEqual(dim.meta.lc_values, undefined);
  });
});
