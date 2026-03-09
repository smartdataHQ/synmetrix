import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectPrimaryKeys, filterKeysWithData } from '../primaryKeyDetector.js';
import { buildCubes } from '../cubeBuilder.js';
import { ColumnType, ValueType } from '../typeParser.js';

/**
 * Helper: create a mock driver that responds to specific SQL patterns.
 */
function mockDriver(queryMap) {
  return {
    async query(sql) {
      for (const [pattern, result] of queryMap) {
        if (sql.includes(pattern)) {
          return typeof result === 'function' ? result(sql) : result;
        }
      }
      return [];
    },
  };
}

/**
 * Helper: create a column entry for a ProfiledTable's columns Map.
 */
function col(name, rawType, columnType, valueType, profile = {}) {
  return [
    name,
    {
      name,
      rawType,
      columnType,
      valueType,
      isNullable: false,
      profile: { hasValues: true, valueRows: 100, uniqueValues: 50, uniqueKeys: [], lcValues: null, minValue: null, maxValue: null, ...profile },
    },
  ];
}

/**
 * Build a minimal ProfiledTable.
 */
function makeTable(overrides = {}) {
  return {
    database: 'test_db',
    table: 'events',
    partition: null,
    columns: new Map(),
    ...overrides,
  };
}

describe('detectPrimaryKeys – parsing system.tables response', () => {
  it('should return primary key columns from system.tables', async () => {
    const driver = mockDriver([
      ['system.tables', [{ primary_key: 'id, timestamp', sorting_key: 'id, timestamp, user_id' }]],
      ['count(', [{ total_rows: '1000', non_null_rows: '1000' }]],
    ]);

    const keys = await detectPrimaryKeys(driver, 'test_db', 'events');
    assert.ok(keys.includes('id'), 'Should include "id"');
    assert.ok(keys.includes('timestamp'), 'Should include "timestamp"');
  });

  it('should parse single primary key column', async () => {
    const driver = mockDriver([
      ['system.tables', [{ primary_key: 'event_id', sorting_key: 'event_id' }]],
      ['count(', [{ total_rows: '500', non_null_rows: '500' }]],
    ]);

    const keys = await detectPrimaryKeys(driver, 'test_db', 'events');
    assert.deepStrictEqual(keys, ['event_id']);
  });

  it('should return empty array when system.tables returns no rows', async () => {
    const driver = mockDriver([
      ['system.tables', []],
    ]);

    const keys = await detectPrimaryKeys(driver, 'test_db', 'events');
    assert.deepStrictEqual(keys, []);
  });
});

describe('detectPrimaryKeys – sorting key fallback', () => {
  it('should fall back to sorting_key when primary_key is empty', async () => {
    const driver = mockDriver([
      ['system.tables', [{ primary_key: '', sorting_key: 'user_id, created_at' }]],
      ['count(', [{ total_rows: '1000', non_null_rows: '900' }]],
    ]);

    const keys = await detectPrimaryKeys(driver, 'test_db', 'events');
    assert.ok(keys.includes('user_id'), 'Should fall back to sorting key "user_id"');
    assert.ok(keys.includes('created_at'), 'Should fall back to sorting key "created_at"');
  });

  it('should return empty array when both primary_key and sorting_key are empty', async () => {
    const driver = mockDriver([
      ['system.tables', [{ primary_key: '', sorting_key: '' }]],
    ]);

    const keys = await detectPrimaryKeys(driver, 'test_db', 'events');
    assert.deepStrictEqual(keys, []);
  });

  it('should return empty array when both keys are whitespace-only', async () => {
    const driver = mockDriver([
      ['system.tables', [{ primary_key: '   ', sorting_key: '  ' }]],
    ]);

    const keys = await detectPrimaryKeys(driver, 'test_db', 'events');
    assert.deepStrictEqual(keys, []);
  });
});

describe('filterKeysWithData – filtering by data sufficiency', () => {
  it('should keep columns with more than 10% non-null data', async () => {
    const driver = mockDriver([
      ['count(', [{ total_rows: '1000', non_null_rows: '500' }]],
    ]);

    const result = await filterKeysWithData(driver, 'test_db', 'events', ['id']);
    assert.deepStrictEqual(result, ['id']);
  });

  it('should exclude columns with insufficient non-null data', async () => {
    const driver = mockDriver([
      ['count(', [{ total_rows: '1000', non_null_rows: '5' }]],
    ]);

    const result = await filterKeysWithData(driver, 'test_db', 'events', ['sparse_col']);
    assert.deepStrictEqual(result, []);
  });

  it('should exclude columns with zero non-null rows', async () => {
    const driver = mockDriver([
      ['count(', [{ total_rows: '1000', non_null_rows: '0' }]],
    ]);

    const result = await filterKeysWithData(driver, 'test_db', 'events', ['empty_col']);
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array when given empty candidate keys', async () => {
    const driver = mockDriver([]);

    const result = await filterKeysWithData(driver, 'test_db', 'events', []);
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array when given null candidate keys', async () => {
    const driver = mockDriver([]);

    const result = await filterKeysWithData(driver, 'test_db', 'events', null);
    assert.deepStrictEqual(result, []);
  });

  it('should handle driver errors by returning all candidate keys', async () => {
    const driver = {
      async query() {
        throw new Error('Connection refused');
      },
    };

    const result = await filterKeysWithData(driver, 'test_db', 'events', ['id', 'ts']);
    assert.deepStrictEqual(result, ['id', 'ts']);
  });
});

describe('primaryKeys – integration with cubeBuilder', () => {
  it('should mark detected primary key fields with primary_key: true and public: true', () => {
    const table = makeTable({
      columns: new Map([
        col('id', 'String', ColumnType.BASIC, ValueType.STRING),
        col('user_name', 'String', ColumnType.BASIC, ValueType.STRING),
        col('amount', 'Float64', ColumnType.BASIC, ValueType.NUMBER),
      ]),
    });

    const { cubes } = buildCubes(table, { primaryKeys: ['id'] });
    const idDim = cubes[0].dimensions.find((d) => d.name === 'id');

    assert.ok(idDim, 'Should have an "id" dimension');
    assert.strictEqual(idDim.primary_key, true);
    assert.strictEqual(idDim.public, true);
  });

  it('should not mark non-primary-key fields with primary_key', () => {
    const table = makeTable({
      columns: new Map([
        col('id', 'String', ColumnType.BASIC, ValueType.STRING),
        col('user_name', 'String', ColumnType.BASIC, ValueType.STRING),
      ]),
    });

    const { cubes } = buildCubes(table, { primaryKeys: ['id'] });
    const nameDim = cubes[0].dimensions.find((d) => d.name === 'user_name');

    assert.ok(nameDim, 'Should have a "user_name" dimension');
    assert.strictEqual(nameDim.primary_key, undefined);
    assert.strictEqual(nameDim.public, undefined);
  });

  it('should handle composite primary keys marking multiple fields', () => {
    const table = makeTable({
      columns: new Map([
        col('tenant_id', 'String', ColumnType.BASIC, ValueType.STRING),
        col('event_id', 'String', ColumnType.BASIC, ValueType.STRING),
        col('payload', 'String', ColumnType.BASIC, ValueType.STRING),
      ]),
    });

    const { cubes } = buildCubes(table, { primaryKeys: ['tenant_id', 'event_id'] });
    const dims = cubes[0].dimensions;

    const tenantDim = dims.find((d) => d.name === 'tenant_id');
    const eventDim = dims.find((d) => d.name === 'event_id');
    const payloadDim = dims.find((d) => d.name === 'payload');

    assert.strictEqual(tenantDim.primary_key, true);
    assert.strictEqual(eventDim.primary_key, true);
    assert.strictEqual(payloadDim.primary_key, undefined);
  });
});
