import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { profileTable, buildWhereClause } from '../profiler.js';
import { ColumnType, ValueType } from '../typeParser.js';

// ---------------------------------------------------------------------------
// Mock driver factory
// ---------------------------------------------------------------------------

/**
 * Create a mock driver for the multi-pass profiler.
 *
 * The new profiler flow:
 *   Pass 0: DESCRIBE TABLE + system.parts_columns (parallel)
 *   Pass 1: Initial profile (single unsampled query with count(), min, max, avg, uniq, max(length))
 *   Pass 2: Deep profiling (sampled, maps + nested only)
 *   Pass 3: LC probe + map stats
 *
 * @param {Object} opts
 * @param {Array}  opts.describeRows       Rows for DESCRIBE TABLE
 * @param {Object} opts.initialProfileRow  Row for initial profile query (Pass 1)
 * @param {Object} opts.deepProfileResult  Row for deep profiling (Pass 2)
 * @param {Function} [opts.onQuery]        Spy interceptor
 * @param {Function} [opts.queryImpl]      Full override
 * @returns {{ query: Function, calls: string[] }}
 */
function createMockDriver(opts = {}) {
  const {
    describeRows = [],
    initialProfileRow = {},
    deepProfileResult = {},
    onQuery,
    queryImpl,
  } = opts;

  const calls = [];

  async function query(sql) {
    calls.push(sql);
    if (onQuery) onQuery(sql);

    if (queryImpl) return queryImpl(sql, calls);

    // system.parts_columns metadata check — return empty (no optimization)
    if (sql.includes('system.parts_columns')) {
      return [];
    }
    if (sql.startsWith('DESCRIBE TABLE')) {
      return describeRows;
    }
    // Sampling probe — throw to simulate no SAMPLE BY support
    if (sql.includes('SAMPLE') && sql.includes('LIMIT 1')) {
      throw new Error("Storage doesn't support sampling");
    }
    // Initial profile query (Pass 1) — contains count() as row_count
    if (sql.includes('count() as row_count')) {
      return [initialProfileRow];
    }
    // Fallback count query (only if initial profile fails)
    if (sql.includes('count() as cnt')) {
      return [{ cnt: initialProfileRow.row_count || 0 }];
    }
    // Deep profiling / LC probe / map stats
    return [deepProfileResult];
  }

  return { query, calls };
}

// ---------------------------------------------------------------------------
// buildWhereClause
// ---------------------------------------------------------------------------

describe('buildWhereClause', () => {
  it('returns empty string when partition is null', () => {
    assert.equal(buildWhereClause('db', 'events', null, ['events']), '');
  });

  it('returns empty string when partition is undefined', () => {
    assert.equal(buildWhereClause('db', 'events', undefined, ['events']), '');
  });

  it('returns empty string when partition is empty string', () => {
    assert.equal(buildWhereClause('db', 'events', '', ['events']), '');
  });

  it('returns empty string when internalTables is not an array', () => {
    assert.equal(buildWhereClause('db', 'events', '2024-01', null), '');
    assert.equal(buildWhereClause('db', 'events', '2024-01', undefined), '');
    assert.equal(buildWhereClause('db', 'events', '2024-01', 'events'), '');
  });

  it('returns empty string when table is not in internalTables', () => {
    assert.equal(
      buildWhereClause('db', 'events', '2024-01', ['other_table']),
      ''
    );
  });

  it('returns WHERE clause when partition is set and table is internal', () => {
    const result = buildWhereClause('db', 'events', '2024-01', ['events', 'logs']);
    assert.equal(result, ` WHERE partition IN ('2024-01')`);
  });
});

// ---------------------------------------------------------------------------
// profileTable — schema analysis pass
// ---------------------------------------------------------------------------

describe('profileTable — schema analysis', () => {
  it('parses DESCRIBE TABLE rows into a columns Map', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'id', type: 'UInt64' },
        { name: 'name', type: 'String' },
        { name: 'created_at', type: 'DateTime' },
      ],
      initialProfileRow: { row_count: 0 },
    });

    const result = await profileTable(driver, 'mydb', 'users');

    assert.equal(result.columns.size, 3);

    const idCol = result.columns.get('id');
    assert.equal(idCol.columnType, ColumnType.BASIC);
    assert.equal(idCol.valueType, ValueType.NUMBER);
    assert.equal(idCol.rawType, 'UInt64');

    const nameCol = result.columns.get('name');
    assert.equal(nameCol.columnType, ColumnType.BASIC);
    assert.equal(nameCol.valueType, ValueType.STRING);

    const dateCol = result.columns.get('created_at');
    assert.equal(dateCol.valueType, ValueType.DATE);
  });

  it('handles Nullable and LowCardinality wrappers', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'status', type: 'LowCardinality(Nullable(String))' },
      ],
      initialProfileRow: { row_count: 0 },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const col = result.columns.get('status');

    assert.equal(col.isNullable, true);
    assert.equal(col.valueType, ValueType.STRING);
    assert.equal(col.columnType, ColumnType.BASIC);
  });

  it('detects Map columns', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'props', type: 'Map(String, Float64)' },
      ],
      initialProfileRow: { row_count: 0 },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const col = result.columns.get('props');

    assert.equal(col.columnType, ColumnType.MAP);
  });

  it('detects Array columns', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'tags', type: 'Array(String)' },
      ],
      initialProfileRow: { row_count: 0 },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const col = result.columns.get('tags');

    assert.equal(col.columnType, ColumnType.ARRAY);
    assert.equal(col.valueType, ValueType.STRING);
  });

  it('detects grouped (dotted) column names', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'nested.field', type: 'Array(String)' },
      ],
      initialProfileRow: { row_count: 0 },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const col = result.columns.get('nested.field');

    assert.equal(col.columnType, ColumnType.GROUPED);
    assert.equal(col.parentName, 'nested');
    assert.equal(col.childName, 'field');
  });

  it('initializes all profile fields to defaults', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'x', type: 'Int32' }],
      initialProfileRow: { row_count: 0 },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('x').profile;

    assert.equal(profile.hasValues, false);
    assert.equal(profile.valueRows, 0);
    assert.equal(profile.uniqueValues, 0);
    assert.equal(profile.minValue, null);
    assert.equal(profile.maxValue, null);
    assert.equal(profile.avgValue, null);
    assert.deepEqual(profile.uniqueKeys, []);
    assert.equal(profile.lcValues, null);
    assert.equal(profile.keyStats, null);
    assert.equal(profile.maxArrayLength, null);
  });
});

// ---------------------------------------------------------------------------
// profileTable — initial profile (Pass 1)
// ---------------------------------------------------------------------------

describe('profileTable — initial profile', () => {
  it('profiles NUMBER columns with min/max/avg from initial profile', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'amount', type: 'Float64' }],
      initialProfileRow: {
        row_count: 100,
        amount__min: 1.5,
        amount__max: 999.99,
        amount__avg: 500.745,
      },
    });

    const result = await profileTable(driver, 'db', 'orders');
    const profile = result.columns.get('amount').profile;

    assert.equal(profile.minValue, 1.5);
    assert.equal(profile.maxValue, 999.99);
    assert.equal(profile.avgValue, 500.745);
    assert.equal(profile.valueRows, 100); // = rowCount when hasValues
    assert.equal(profile.hasValues, true);
  });

  it('profiles STRING columns with uniq count from initial profile', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'status', type: 'String' }],
      initialProfileRow: {
        row_count: 50,
        status__count: 5,
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('status').profile;

    assert.equal(profile.uniqueValues, 5);
    assert.equal(profile.valueRows, 50); // = rowCount
    assert.equal(profile.hasValues, true);
  });

  it('profiles Enum8 in initial query with uniq (not empty-string compare)', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'access_type', type: "Enum8('a' = 1, 'b' = 2)" },
      ],
      initialProfileRow: { row_count: 10, access_type__count: 3 },
    });
    const result = await profileTable(driver, 'db', 'tbl');
    const initialSql = driver.calls.find((q) => q.includes('count() as row_count'));
    assert.ok(initialSql);
    assert.match(initialSql, /uniq\(`access_type`\)/);
    assert.doesNotMatch(initialSql, /`access_type` != ''/);
    const profile = result.columns.get('access_type').profile;
    assert.equal(profile.uniqueValues, 3);
    assert.equal(profile.valueRows, 10);
  });

  it('profiles Array(String) in initial pass using array SQL (value_rows + distinct)', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'tags', type: 'Array(String)' }],
      initialProfileRow: {
        row_count: 20,
        tags__value_rows: 12,
        tags__distinct_count: 5,
      },
    });
    const result = await profileTable(driver, 'db', 'tbl');
    const initialSql = driver.calls.find((q) => q.includes('count() as row_count'));
    assert.ok(initialSql);
    assert.match(initialSql, /arrayFilter/);
    const profile = result.columns.get('tags').profile;
    assert.equal(profile.valueRows, 12);
    assert.equal(profile.uniqueValues, 5);
    assert.equal(profile.hasValues, true);
  });

  it('profiles DATE columns with min/max from initial profile', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'ts', type: 'DateTime' }],
      initialProfileRow: {
        row_count: 10,
        ts__min: '2024-01-01',
        ts__max: '2024-06-15',
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('ts').profile;

    assert.equal(profile.minValue, '2024-01-01');
    assert.equal(profile.maxValue, '2024-06-15');
    assert.equal(profile.valueRows, 10);
    assert.equal(profile.hasValues, true);
  });

  it('profiles MAP columns with key count from initial profile', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'props', type: 'Map(String, Float64)' }],
      initialProfileRow: {
        row_count: 20,
        props__key_count: 3,
      },
      // Deep profiling (Pass 2) returns the actual keys
      deepProfileResult: {
        props__map_keys: ['width', 'height', 'depth'],
        props__value_rows: 18,
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('props').profile;

    assert.deepEqual(profile.uniqueKeys, ['width', 'height', 'depth']);
    assert.equal(profile.hasValues, true);
  });

  it('handles string values for numeric fields (coercion)', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'x', type: 'String' }],
      initialProfileRow: {
        row_count: '5',
        x__count: '42',
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('x').profile;

    assert.equal(profile.uniqueValues, 42);
    assert.equal(profile.valueRows, 5);
    assert.equal(profile.hasValues, true);
  });

  it('detects nested group depth via max(length(sentinel))', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'nested.field', type: 'Array(String)' },
        { name: 'nested.other', type: 'Array(Int32)' },
      ],
      initialProfileRow: {
        row_count: 100,
        nested__max_length: 5,
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    // Both columns should have maxArrayLength from the group
    assert.equal(result.columns.get('nested.field').profile.maxArrayLength, 5);
    assert.equal(result.columns.get('nested.other').profile.maxArrayLength, 5);
  });

  it('marks empty groups (maxLength=0) and skips their sub-columns', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'empty.sub1', type: 'Array(String)' },
        { name: 'empty.sub2', type: 'Array(Int32)' },
      ],
      initialProfileRow: {
        row_count: 100,
        empty__max_length: 0,
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    assert.equal(result.columns.get('empty.sub1').profile.maxArrayLength, 0);
    assert.equal(result.columns.get('empty.sub2').profile.maxArrayLength, 0);

    // No deep profiling queries should have run for these
    const deepQueries = driver.calls.filter(
      (s) => s.includes('empty_sub') && !s.includes('count() as row_count') && !s.includes('max_length')
    );
    assert.equal(deepQueries.length, 0);
  });
});

// ---------------------------------------------------------------------------
// profileTable — empty column filtering
// ---------------------------------------------------------------------------

describe('profileTable — empty column filtering', () => {
  it('marks columns with no data as hasValues: false', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'filled', type: 'String' },
        { name: 'empty', type: 'String' },
      ],
      initialProfileRow: {
        row_count: 100,
        filled__count: 10,
        empty__count: 0,
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    assert.equal(result.columns.get('filled').profile.hasValues, true);
    assert.equal(result.columns.get('empty').profile.hasValues, false);
  });

  it('leaves profiles at defaults when row count is 0', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'col', type: 'Int32' }],
      initialProfileRow: { row_count: 0 },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('col').profile;

    assert.equal(profile.hasValues, false);
    assert.equal(profile.valueRows, 0);
  });
});

// ---------------------------------------------------------------------------
// profileTable — initial profile failure fallback
// ---------------------------------------------------------------------------

describe('profileTable — initial profile failure fallback', () => {
  it('falls back to count query when initial profile query fails', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'a', type: 'Int32' },
        { name: 'b', type: 'String' },
      ],
      queryImpl(sql) {
        if (sql.includes('system.parts_columns')) return [];
        if (sql.startsWith('DESCRIBE TABLE')) return [
          { name: 'a', type: 'Int32' },
          { name: 'b', type: 'String' },
        ];
        // Initial profile fails
        if (sql.includes('count() as row_count')) {
          throw new Error('initial profile syntax error');
        }
        // Fallback count query succeeds
        if (sql.includes('count() as cnt')) {
          return [{ cnt: 100 }];
        }
        if (sql.includes('SAMPLE') && sql.includes('LIMIT 1')) {
          throw new Error("Storage doesn't support sampling");
        }
        return [{}];
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    // Row count should still be available from fallback
    assert.equal(result.row_count, 100);
    // But columns won't have profile data (initial profile failed)
    assert.equal(result.columns.get('a').profile.hasValues, false);
  });
});

// ---------------------------------------------------------------------------
// profileTable — deep profiling batch failure fallback
// ---------------------------------------------------------------------------

describe('profileTable — deep profiling batch failure', () => {
  it('falls back to individual queries when batch query fails', async () => {
    // Map columns need deep profiling
    const describeRows = [
      { name: 'map1', type: 'Map(String, Float64)' },
      { name: 'map2', type: 'Map(String, String)' },
    ];

    let deepProfileAttempted = false;

    const driver = createMockDriver({
      describeRows,
      queryImpl(sql) {
        if (sql.includes('system.parts_columns')) return [];
        if (sql.startsWith('DESCRIBE TABLE')) return describeRows;
        if (sql.includes('SAMPLE') && sql.includes('LIMIT 1')) {
          throw new Error("Storage doesn't support sampling");
        }
        // Initial profile — report both maps have data
        if (sql.includes('count() as row_count')) {
          return [{ row_count: 100, map1__key_count: 3, map2__key_count: 2 }];
        }
        // First deep profiling query (batch) — fail
        if (!deepProfileAttempted && sql.includes('map_keys')) {
          deepProfileAttempted = true;
          throw new Error('batch query syntax error');
        }
        // Individual fallback queries
        if (sql.includes('map1__')) {
          return [{ map1__map_keys: ['a', 'b', 'c'], map1__value_rows: 90 }];
        }
        if (sql.includes('map2__')) {
          return [{ map2__map_keys: ['x', 'y'], map2__value_rows: 80 }];
        }
        return [{}];
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    assert.deepEqual(result.columns.get('map1').profile.uniqueKeys, ['a', 'b', 'c']);
    assert.deepEqual(result.columns.get('map2').profile.uniqueKeys, ['x', 'y']);
  });

  it('skips column gracefully when individual fallback also fails', async () => {
    const describeRows = [
      { name: 'good', type: 'Map(String, String)' },
      { name: 'bad', type: 'Map(String, String)' },
    ];

    let deepProfileAttempted = false;

    const driver = createMockDriver({
      describeRows,
      queryImpl(sql) {
        if (sql.includes('system.parts_columns')) return [];
        if (sql.startsWith('DESCRIBE TABLE')) return describeRows;
        if (sql.includes('SAMPLE') && sql.includes('LIMIT 1')) {
          throw new Error("Storage doesn't support sampling");
        }
        if (sql.includes('count() as row_count')) {
          return [{ row_count: 10, good__key_count: 3, bad__key_count: 2 }];
        }
        // First deep profiling query (batch) — fail
        if (!deepProfileAttempted && sql.includes('map_keys')) {
          deepProfileAttempted = true;
          throw new Error('batch fail');
        }
        if (sql.includes('good__')) {
          return [{ good__map_keys: ['a', 'b', 'c'], good__value_rows: 10 }];
        }
        if (sql.includes('bad__')) {
          throw new Error('individual column fail');
        }
        return [{}];
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    assert.deepEqual(result.columns.get('good').profile.uniqueKeys, ['a', 'b', 'c']);
    // 'bad' column has key_count from initial profile but no keys from deep profile
    assert.deepEqual(result.columns.get('bad').profile.uniqueKeys, []);
  });
});

// ---------------------------------------------------------------------------
// profileTable — sampling behavior
// ---------------------------------------------------------------------------

describe('profileTable — sampling behavior', () => {
  it('uses sampling for deep profiling when row count exceeds threshold', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'meta', type: 'Map(String, String)' }],
      initialProfileRow: {
        row_count: 5_000_000,
        meta__key_count: 10,
      },
      deepProfileResult: {
        meta__map_keys: ['k1', 'k2'],
        meta__value_rows: 100_000,
      },
    });

    const result = await profileTable(driver, 'db', 'big_table', {
      sampleThreshold: 1_000_000,
    });

    assert.equal(result.sampled, true);
    assert.equal(result.sample_size, 200_000);

    // Deep profiling query should use LIMIT for sampling
    const deepSql = driver.calls.find(
      (sql) => sql.includes('meta__') && sql.includes('map_keys') && sql.includes('FROM')
    );
    assert.ok(deepSql, 'Expected a deep profiling query');
    assert.ok(
      deepSql.includes('LIMIT 200000'),
      'Expected subquery LIMIT sampling in deep profiling SQL'
    );
  });

  it('initial profile is never sampled (always runs unsampled)', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'val', type: 'Int32' }],
      initialProfileRow: {
        row_count: 5_000_000,
        val__min: 1,
        val__max: 100,
        val__avg: 50.5,
      },
    });

    const result = await profileTable(driver, 'db', 'big_table', {
      sampleThreshold: 1_000_000,
    });

    // Initial profile query should NOT have LIMIT or SAMPLE
    const initialSql = driver.calls.find((s) => s.includes('count() as row_count'));
    assert.ok(initialSql, 'Expected initial profile query');
    assert.ok(!initialSql.includes('LIMIT'), 'Initial profile should not use LIMIT');
    assert.ok(!initialSql.includes('SAMPLE'), 'Initial profile should not use SAMPLE');

    // But result should still report sampled=true (for deep profiling)
    assert.equal(result.sampled, true);
  });

  it('does not use sampling when row count is below threshold', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'meta', type: 'Map(String, String)' }],
      initialProfileRow: {
        row_count: 500,
        meta__key_count: 5,
      },
      deepProfileResult: {
        meta__map_keys: ['a', 'b'],
        meta__value_rows: 500,
      },
    });

    const result = await profileTable(driver, 'db', 'small_table');

    assert.equal(result.sampled, false);
    assert.equal(result.sample_size, null);

    const deepSql = driver.calls.find(
      (sql) => sql.includes('meta__') && sql.includes('map_keys') && sql.includes('FROM')
    );
    if (deepSql) {
      assert.ok(!deepSql.includes('LIMIT'), 'Should not contain LIMIT sampling');
    }
  });

  it('respects custom sampleThreshold', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'meta', type: 'Map(String, String)' }],
      initialProfileRow: {
        row_count: 200,
        meta__key_count: 3,
      },
      deepProfileResult: {
        meta__map_keys: ['a'],
        meta__value_rows: 20,
      },
    });

    const result = await profileTable(driver, 'db', 'tbl', {
      sampleThreshold: 100,
    });

    assert.equal(result.sampled, true);
    assert.equal(result.sample_size, 20); // 200 * 0.1
  });
});

// ---------------------------------------------------------------------------
// profileTable — partition WHERE clause
// ---------------------------------------------------------------------------

describe('profileTable — partition WHERE clause', () => {
  it('includes WHERE clause in initial profile and deep profiling for internal tables', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'meta', type: 'Map(String, String)' }],
      initialProfileRow: {
        row_count: 10,
        meta__key_count: 2,
      },
      deepProfileResult: {
        meta__map_keys: ['a', 'b'],
        meta__value_rows: 10,
      },
    });

    await profileTable(driver, 'db', 'events', {
      partition: '2024-03',
      internalTables: ['events'],
    });

    const initialSql = driver.calls.find((s) => s.includes('count() as row_count'));
    assert.ok(initialSql.includes(`WHERE partition IN ('2024-03')`));

    const deepSql = driver.calls.find(
      (s) => s.includes('meta__') && s.includes('map_keys')
    );
    if (deepSql) {
      assert.ok(deepSql.includes(`WHERE partition IN ('2024-03')`));
    }
  });

  it('omits WHERE clause when table is not in internalTables', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'x', type: 'Int32' }],
      initialProfileRow: {
        row_count: 10,
        x__min: 0,
        x__max: 9,
        x__avg: 4.5,
      },
    });

    await profileTable(driver, 'db', 'events', {
      partition: '2024-03',
      internalTables: ['other_table'],
    });

    const initialSql = driver.calls.find((s) => s.includes('count() as row_count'));
    assert.ok(!initialSql.includes('WHERE'));
  });
});

// ---------------------------------------------------------------------------
// profileTable — return shape
// ---------------------------------------------------------------------------

describe('profileTable — return shape', () => {
  it('returns the expected top-level fields', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'id', type: 'UInt64' }],
      initialProfileRow: { row_count: 42 },
    });

    const result = await profileTable(driver, 'mydb', 'orders', {
      partition: '2024-01',
    });

    assert.equal(result.database, 'mydb');
    assert.equal(result.table, 'orders');
    assert.equal(result.partition, '2024-01');
    assert.equal(result.row_count, 42);
    assert.equal(typeof result.sampled, 'boolean');
    assert.ok(result.columns instanceof Map);
  });

  it('returns sampled=false and sample_size=null for small tables', async () => {
    const driver = createMockDriver({
      describeRows: [],
      initialProfileRow: { row_count: 10 },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    assert.equal(result.sampled, false);
    assert.equal(result.sample_size, null);
  });

  it('returns sampled=true and sample_size for large tables', async () => {
    const driver = createMockDriver({
      describeRows: [],
      initialProfileRow: { row_count: 2_000_000 },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    assert.equal(result.sampled, true);
    assert.equal(result.sample_size, 200_000);
  });
});

// ---------------------------------------------------------------------------
// profileTable — deep profiling only for maps + nested
// ---------------------------------------------------------------------------

describe('profileTable — deep profiling scope', () => {
  it('does not deep-profile scalar columns (covered by initial profile)', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'amount', type: 'Float64' },
        { name: 'status', type: 'String' },
        { name: 'ts', type: 'DateTime' },
      ],
      initialProfileRow: {
        row_count: 100,
        amount__min: 1.0,
        amount__max: 99.0,
        amount__avg: 50.0,
        status__count: 5,
        ts__min: '2024-01-01',
        ts__max: '2024-12-31',
      },
    });

    await profileTable(driver, 'db', 'tbl');

    // No deep profiling queries — only initial profile, DESCRIBE, metadata, and LC probe
    const deepQueries = driver.calls.filter(
      (s) =>
        !s.startsWith('DESCRIBE') &&
        !s.includes('system.parts_columns') &&
        !s.includes('count() as row_count') &&
        !s.includes('SAMPLE') &&
        !s.includes('lc_values') &&
        (s.includes('amount__') || s.includes('status__') || s.includes('ts__'))
    );
    assert.equal(deepQueries.length, 0, 'Scalar columns should not trigger deep profiling');
  });

  it('deep-profiles Map columns to discover keys', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'x', type: 'Int32' },
        { name: 'meta', type: 'Map(String, String)' },
      ],
      initialProfileRow: {
        row_count: 100,
        x__min: 1,
        x__max: 50,
        x__avg: 25.0,
        meta__key_count: 5,
      },
      deepProfileResult: {
        meta__map_keys: ['color', 'size'],
        meta__value_rows: 80,
      },
    });

    await profileTable(driver, 'db', 'tbl');

    // There should be a deep profiling query containing map_keys
    const deepQuery = driver.calls.find(
      (s) => s.includes('meta__map_keys') && s.includes('groupUniqArrayArray')
    );
    assert.ok(deepQuery, 'Expected deep profiling query for Map column');
  });

  it('deep-profiles nested sub-columns in active groups', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'group.name', type: 'Array(String)' },
        { name: 'group.value', type: 'Array(Int32)' },
      ],
      initialProfileRow: {
        row_count: 100,
        group__max_length: 3,
      },
      deepProfileResult: {
        group_name__value_rows: 90,
        group_name__distinct_count: 10,
        group_value__value_rows: 85,
        group_value__min_value: 0,
        group_value__max_value: 100,
      },
    });

    await profileTable(driver, 'db', 'tbl');

    // There should be deep profiling query for nested sub-columns
    const deepQuery = driver.calls.find(
      (s) => (s.includes('group_name__') || s.includes('group_value__')) &&
             !s.includes('count() as row_count') &&
             !s.includes('max_length')
    );
    assert.ok(deepQuery, 'Expected deep profiling query for nested group sub-columns');
  });
});

// ---------------------------------------------------------------------------
// profileTable — emitter integration
// ---------------------------------------------------------------------------

describe('profileTable — emitter', () => {
  it('calls emitter with progress events', async () => {
    const events = [];
    const emitter = {
      emit(step, msg, progress, detail) {
        events.push({ step, msg, progress, detail });
      },
    };

    const driver = createMockDriver({
      describeRows: [{ name: 'x', type: 'Int32' }],
      initialProfileRow: {
        row_count: 10,
        x__min: 0,
        x__max: 9,
        x__avg: 4.5,
      },
    });

    await profileTable(driver, 'db', 'tbl', { emitter });

    const steps = events.map((e) => e.step);
    assert.ok(steps.includes('init'));
    assert.ok(steps.includes('initial_profile'));
    assert.ok(steps.includes('profiling'));
    assert.ok(events.length >= 4);
  });
});

// ---------------------------------------------------------------------------
// profileTable — SQL correctness
// ---------------------------------------------------------------------------

describe('profileTable — generated SQL', () => {
  it('generates correct DESCRIBE TABLE query', async () => {
    const driver = createMockDriver({
      describeRows: [],
      initialProfileRow: { row_count: 0 },
    });

    await profileTable(driver, 'analytics', 'page_views');

    const describeSql = driver.calls.find((s) => s.startsWith('DESCRIBE'));
    assert.equal(describeSql, 'DESCRIBE TABLE analytics.`page_views`');
  });

  it('generates initial profile SQL with correct aggregates for STRING column', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'status', type: 'String' }],
      initialProfileRow: { row_count: 10 },
    });

    await profileTable(driver, 'db', 'tbl');

    const initialSql = driver.calls.find((s) => s.includes('count() as row_count'));
    assert.ok(initialSql.includes("uniqIf(`status`, `status` != '') as status__count"), 'String should use uniqIf() excluding empty strings');
  });

  it('generates initial profile SQL with correct aggregates for NUMBER column', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'amount', type: 'Float64' }],
      initialProfileRow: { row_count: 10 },
    });

    await profileTable(driver, 'db', 'tbl');

    const initialSql = driver.calls.find((s) => s.includes('count() as row_count'));
    assert.ok(initialSql.includes('min(`amount`) as amount__min'));
    assert.ok(initialSql.includes('max(`amount`) as amount__max'));
    assert.ok(initialSql.includes('avg(`amount`) as amount__avg'));
  });

  it('generates initial profile SQL with correct aggregates for DATE column', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'ts', type: 'DateTime' }],
      initialProfileRow: { row_count: 10 },
    });

    await profileTable(driver, 'db', 'tbl');

    const initialSql = driver.calls.find((s) => s.includes('count() as row_count'));
    assert.ok(initialSql.includes('min(`ts`) as ts__min'));
    assert.ok(initialSql.includes('max(`ts`) as ts__max'));
    assert.ok(!initialSql.includes('avg(`ts`)'), 'Date should not have avg');
  });

  it('generates initial profile SQL with uniq(mapKeys()) for MAP columns', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'meta', type: 'Map(String, String)' }],
      initialProfileRow: { row_count: 10 },
    });

    await profileTable(driver, 'db', 'tbl');

    const initialSql = driver.calls.find((s) => s.includes('count() as row_count'));
    assert.ok(initialSql.includes('uniq(mapKeys(`meta`)) as meta__key_count'));
  });

  it('generates initial profile SQL with max(length(sentinel)) for nested groups', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'nested.field', type: 'Array(String)' },
        { name: 'nested.other', type: 'Array(Int32)' },
      ],
      initialProfileRow: { row_count: 10, nested__max_length: 3 },
    });

    await profileTable(driver, 'db', 'tbl');

    const initialSql = driver.calls.find((s) => s.includes('count() as row_count'));
    assert.ok(initialSql.includes('max(length(`nested.field`)) as nested__max_length') ||
              initialSql.includes('max(length(`nested.other`)) as nested__max_length'),
              'Should include max(length()) for the group sentinel');
  });

  it('generates correct deep profiling SQL for MAP column', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'meta', type: 'Map(String, String)' }],
      initialProfileRow: { row_count: 10, meta__key_count: 3 },
      deepProfileResult: { meta__map_keys: ['a'], meta__value_rows: 10 },
    });

    await profileTable(driver, 'db', 'tbl');

    const deepSql = driver.calls.find(
      (s) => s.includes('meta__map_keys') && !s.includes('count() as row_count')
    );
    assert.ok(deepSql, 'Expected deep profiling query');
    assert.ok(deepSql.includes('groupUniqArrayArray(200)(mapKeys(`meta`)) as meta__map_keys'));
    assert.ok(deepSql.includes('meta__value_rows'));
  });

  it('replaces dots with underscores in aliases for grouped columns', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'nested.field', type: 'Array(String)' }],
      initialProfileRow: {
        row_count: 10,
        nested__max_length: 5,
      },
      deepProfileResult: {
        nested_field__value_rows: 8,
        nested_field__distinct_count: 3,
      },
    });

    await profileTable(driver, 'db', 'tbl');

    const deepSql = driver.calls.find(
      (s) => s.includes('nested_field__') && !s.includes('count() as row_count') && !s.includes('max_length')
    );
    assert.ok(deepSql, 'Expected deep profiling query for nested column');
    assert.ok(deepSql.includes('nested_field__'), 'Alias should replace dots with underscores');
    assert.ok(deepSql.includes('`nested.field`'), 'Column expression should use original name');
  });
});
