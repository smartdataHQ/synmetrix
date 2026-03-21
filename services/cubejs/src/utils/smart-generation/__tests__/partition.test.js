import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { buildWhereClause } from '../profiler.js';
import { buildCubes } from '../cubeBuilder.js';
import { ColumnType, ValueType } from '../typeParser.js';

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
      profile: { hasValues: true, valueRows: 10, uniqueValues: 5, uniqueKeys: [], lcValues: null, minValue: null, maxValue: null, ...profile },
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

describe('buildWhereClause', () => {
  it('should return empty string when partition is null', () => {
    const result = buildWhereClause('test_db', 'events', null, ['events']);
    assert.strictEqual(result, '');
  });

  it('should return empty string when partition is undefined', () => {
    const result = buildWhereClause('test_db', 'events', undefined, ['events']);
    assert.strictEqual(result, '');
  });

  it('should return empty string when partition is empty string', () => {
    const result = buildWhereClause('test_db', 'events', '', ['events']);
    assert.strictEqual(result, '');
  });

  it('should return empty string when table is not in internalTables', () => {
    const result = buildWhereClause('test_db', 'events', '2024-01', ['other_table']);
    assert.strictEqual(result, '');
  });

  it('should apply partition when internalTables is empty (all tables internal)', () => {
    const result = buildWhereClause('test_db', 'events', '2024-01', []);
    assert.strictEqual(result, " WHERE partition IN ('2024-01')");
  });

  it('should apply partition when internalTables is not an array (all tables internal)', () => {
    const result = buildWhereClause('test_db', 'events', '2024-01', null);
    assert.strictEqual(result, " WHERE partition IN ('2024-01')");
  });

  it('should return WHERE clause when partition is set and table is internal', () => {
    const result = buildWhereClause('test_db', 'events', '2024-01', ['events']);
    assert.ok(result.includes('WHERE'), 'Should contain WHERE keyword');
    assert.ok(result.includes("'2024-01'"), 'Should contain partition value');
    assert.ok(result.includes('partition'), 'Should filter on partition column');
  });
});

describe('partition – buildCubes integration', () => {
  let table;

  beforeEach(() => {
    table = makeTable({
      columns: new Map([
        col('id', 'String', ColumnType.BASIC, ValueType.STRING),
        col('amount', 'Float64', ColumnType.BASIC, ValueType.NUMBER),
      ]),
    });
  });

  it('should use sql_table when no partition is configured', () => {
    const { cubes } = buildCubes(table);
    assert.strictEqual(cubes[0].sql_table, 'test_db.events');
    assert.strictEqual(cubes[0].sql, undefined);
  });

  it('should use sql_table when partition is set but table is not internal', () => {
    const { cubes } = buildCubes(table, {
      partition: '2024-01',
      internalTables: ['other_table'],
    });
    assert.strictEqual(cubes[0].sql_table, 'test_db.events');
    assert.strictEqual(cubes[0].sql, undefined);
  });

  it('should use sql with WHERE clause when table is internal and partition is set', () => {
    const { cubes } = buildCubes(table, {
      partition: '2024-01',
      internalTables: ['events'],
    });

    assert.strictEqual(cubes[0].sql_table, undefined);
    assert.ok(cubes[0].sql, 'Should have sql property');
    assert.ok(cubes[0].sql.includes('SELECT * FROM'), 'SQL should be a SELECT statement');
    assert.ok(cubes[0].sql.includes("partition = '2024-01'"), 'SQL should contain partition filter');
    assert.ok(cubes[0].sql.includes('test_db.events'), 'SQL should reference the table');
  });

  it('should include source_partition in cube meta when partition is active', () => {
    const { cubes } = buildCubes(table, {
      partition: '2024-01',
      internalTables: ['events'],
    });

    assert.strictEqual(cubes[0].meta.source_partition, '2024-01');
    assert.strictEqual(cubes[0].meta.source_table, 'events');
    assert.strictEqual(cubes[0].meta.source_database, 'test_db');
  });

  it('should not include source_partition in meta when no partition', () => {
    const { cubes } = buildCubes(table);
    assert.strictEqual(cubes[0].meta.source_partition, undefined);
  });

  it('should not include source_partition when table is not internal', () => {
    const { cubes } = buildCubes(table, {
      partition: '2024-01',
      internalTables: ['other_table'],
    });
    assert.strictEqual(cubes[0].meta.source_partition, undefined);
  });
});
