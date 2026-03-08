import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { profileTable, buildWhereClause } from '../profiler.js';
import { ColumnType, ValueType } from '../typeParser.js';

// ---------------------------------------------------------------------------
// Mock driver factory
// ---------------------------------------------------------------------------

/**
 * Create a mock driver whose `query` method dispatches based on SQL content.
 *
 * @param {Object} opts
 * @param {Array}  opts.describeRows   Rows returned for DESCRIBE TABLE
 * @param {number} opts.rowCount       Value returned for count() query
 * @param {Object} opts.profileResult  Row returned for profiling SELECT(s)
 * @param {Function} [opts.onQuery]    Optional spy/interceptor (receives sql)
 * @param {Function} [opts.queryImpl]  Full override for driver.query
 * @returns {{ query: Function, calls: string[] }}
 */
function createMockDriver(opts = {}) {
  const {
    describeRows = [],
    rowCount = 0,
    profileResult = {},
    onQuery,
    queryImpl,
  } = opts;

  const calls = [];

  async function query(sql) {
    calls.push(sql);
    if (onQuery) onQuery(sql);

    if (queryImpl) return queryImpl(sql, calls);

    if (sql.startsWith('DESCRIBE TABLE')) {
      return describeRows;
    }
    if (sql.includes('count()')) {
      return [{ cnt: rowCount }];
    }
    // profiling SELECT
    return [profileResult];
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
      rowCount: 0,
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
      rowCount: 0,
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
      rowCount: 0,
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
      rowCount: 0,
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
      rowCount: 0,
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
      rowCount: 0,
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('x').profile;

    assert.equal(profile.hasValues, false);
    assert.equal(profile.valueRows, 0);
    assert.equal(profile.uniqueValues, 0);
    assert.equal(profile.minValue, null);
    assert.equal(profile.maxValue, null);
    assert.deepEqual(profile.uniqueKeys, []);
    assert.equal(profile.lcValues, null);
  });
});

// ---------------------------------------------------------------------------
// profileTable — data profiling pass
// ---------------------------------------------------------------------------

describe('profileTable — data profiling', () => {
  it('profiles NUMBER columns with min/max/valueRows', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'amount', type: 'Float64' }],
      rowCount: 100,
      profileResult: {
        amount__min_value: 1.5,
        amount__max_value: 999.99,
        amount__value_rows: 98,
      },
    });

    const result = await profileTable(driver, 'db', 'orders');
    const profile = result.columns.get('amount').profile;

    assert.equal(profile.minValue, 1.5);
    assert.equal(profile.maxValue, 999.99);
    assert.equal(profile.valueRows, 98);
    assert.equal(profile.hasValues, true);
  });

  it('profiles STRING columns with distinct_count and value_rows', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'status', type: 'String' }],
      rowCount: 50,
      profileResult: {
        status__distinct_count: 5,
        status__value_rows: 48,
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('status').profile;

    assert.equal(profile.uniqueValues, 5);
    assert.equal(profile.valueRows, 48);
    assert.equal(profile.hasValues, true);
  });

  it('profiles DATE columns with min/max', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'ts', type: 'DateTime' }],
      rowCount: 10,
      profileResult: {
        ts__min_value: '2024-01-01',
        ts__max_value: '2024-06-15',
        ts__value_rows: 10,
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('ts').profile;

    assert.equal(profile.minValue, '2024-01-01');
    assert.equal(profile.maxValue, '2024-06-15');
    assert.equal(profile.valueRows, 10);
    assert.equal(profile.hasValues, true);
  });

  it('profiles MAP columns with map_keys and distinct_count', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'props', type: 'Map(String, Float64)' }],
      rowCount: 20,
      profileResult: {
        props__map_keys: ['width', 'height', 'depth'],
        props__distinct_count: 3,
        props__value_rows: 18,
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('props').profile;

    assert.deepEqual(profile.uniqueKeys, ['width', 'height', 'depth']);
    assert.equal(profile.uniqueValues, 3);
    assert.equal(profile.valueRows, 18);
    assert.equal(profile.hasValues, true);
  });

  it('handles string values for numeric fields (coercion)', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'x', type: 'String' }],
      rowCount: 5,
      profileResult: {
        x__distinct_count: '42',
        x__value_rows: '5',
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('x').profile;

    assert.equal(profile.uniqueValues, 42);
    assert.equal(profile.valueRows, 5);
    assert.equal(profile.hasValues, true);
  });
});

// ---------------------------------------------------------------------------
// profileTable — empty column filtering
// ---------------------------------------------------------------------------

describe('profileTable — empty column filtering', () => {
  it('marks columns with zero value_rows as hasValues: false', async () => {
    const driver = createMockDriver({
      describeRows: [
        { name: 'filled', type: 'String' },
        { name: 'empty', type: 'String' },
      ],
      rowCount: 100,
      profileResult: {
        filled__distinct_count: 10,
        filled__value_rows: 90,
        empty__distinct_count: 0,
        empty__value_rows: 0,
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    assert.equal(result.columns.get('filled').profile.hasValues, true);
    assert.equal(result.columns.get('empty').profile.hasValues, false);
  });

  it('leaves profiles at defaults when row count is 0', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'col', type: 'Int32' }],
      rowCount: 0,
    });

    const result = await profileTable(driver, 'db', 'tbl');
    const profile = result.columns.get('col').profile;

    assert.equal(profile.hasValues, false);
    assert.equal(profile.valueRows, 0);
  });
});

// ---------------------------------------------------------------------------
// profileTable — batch failure fallback
// ---------------------------------------------------------------------------

describe('profileTable — batch failure fallback', () => {
  it('falls back to individual queries when batch query fails', async () => {
    // Create 3 columns — all fit in one batch. The batch query fails,
    // so the profiler should retry each column individually.
    const describeRows = [
      { name: 'a', type: 'Int32' },
      { name: 'b', type: 'String' },
      { name: 'c', type: 'Float64' },
    ];

    let batchAttempted = false;

    const driver = createMockDriver({
      describeRows,
      rowCount: 100,
      queryImpl(sql) {
        if (sql.startsWith('DESCRIBE TABLE')) return describeRows;
        if (sql.includes('count()')) return [{ cnt: 100 }];

        // First profiling query is the batch — fail it
        if (!batchAttempted) {
          batchAttempted = true;
          throw new Error('batch query syntax error');
        }

        // Individual fallback queries
        if (sql.includes('a__')) {
          return [{ a__min_value: 0, a__max_value: 50, a__value_rows: 100 }];
        }
        if (sql.includes('b__')) {
          return [{ b__distinct_count: 20, b__value_rows: 95 }];
        }
        if (sql.includes('c__')) {
          return [{ c__min_value: 1.1, c__max_value: 9.9, c__value_rows: 80 }];
        }
        return [{}];
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    // All three columns should still have their profiles populated
    assert.equal(result.columns.get('a').profile.hasValues, true);
    assert.equal(result.columns.get('a').profile.minValue, 0);
    assert.equal(result.columns.get('a').profile.maxValue, 50);

    assert.equal(result.columns.get('b').profile.hasValues, true);
    assert.equal(result.columns.get('b').profile.uniqueValues, 20);

    assert.equal(result.columns.get('c').profile.hasValues, true);
    assert.equal(result.columns.get('c').profile.minValue, 1.1);
  });

  it('skips column gracefully when individual fallback also fails', async () => {
    const describeRows = [
      { name: 'good', type: 'String' },
      { name: 'bad', type: 'String' },
    ];

    let batchAttempted = false;

    const driver = createMockDriver({
      describeRows,
      rowCount: 10,
      queryImpl(sql) {
        if (sql.startsWith('DESCRIBE TABLE')) return describeRows;
        if (sql.includes('count()')) return [{ cnt: 10 }];

        if (!batchAttempted) {
          batchAttempted = true;
          throw new Error('batch fail');
        }

        if (sql.includes('good__')) {
          return [{ good__distinct_count: 5, good__value_rows: 10 }];
        }
        if (sql.includes('bad__')) {
          throw new Error('individual column fail');
        }
        return [{}];
      },
    });

    const result = await profileTable(driver, 'db', 'tbl');

    assert.equal(result.columns.get('good').profile.hasValues, true);
    // 'bad' column stays at defaults
    assert.equal(result.columns.get('bad').profile.hasValues, false);
    assert.equal(result.columns.get('bad').profile.valueRows, 0);
  });
});

// ---------------------------------------------------------------------------
// profileTable — sampling behavior
// ---------------------------------------------------------------------------

describe('profileTable — sampling behavior', () => {
  it('uses SAMPLE clause when row count exceeds threshold', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'val', type: 'Int32' }],
      rowCount: 5_000_000,
      profileResult: {
        val__min_value: 1,
        val__max_value: 100,
        val__value_rows: 500_000,
      },
    });

    const result = await profileTable(driver, 'db', 'big_table', {
      sampleThreshold: 1_000_000,
    });

    assert.equal(result.sampled, true);
    assert.equal(result.sample_size, 500_000);

    // Verify SAMPLE appears in the profiling SQL (not in DESCRIBE or count)
    const profilingSql = driver.calls.find(
      (sql) => !sql.startsWith('DESCRIBE') && !sql.includes('count()')
    );
    assert.ok(profilingSql, 'Expected a profiling query');
    assert.ok(profilingSql.includes('SAMPLE 0.1'), 'Expected SAMPLE 0.1 in SQL');
  });

  it('does not use SAMPLE when row count is below threshold', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'val', type: 'Int32' }],
      rowCount: 500,
      profileResult: {
        val__min_value: 1,
        val__max_value: 100,
        val__value_rows: 500,
      },
    });

    const result = await profileTable(driver, 'db', 'small_table');

    assert.equal(result.sampled, false);
    assert.equal(result.sample_size, null);

    const profilingSql = driver.calls.find(
      (sql) => !sql.startsWith('DESCRIBE') && !sql.includes('count()')
    );
    assert.ok(profilingSql);
    assert.ok(!profilingSql.includes('SAMPLE'), 'Should not contain SAMPLE');
  });

  it('respects custom sampleThreshold', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'x', type: 'Int32' }],
      rowCount: 200,
      profileResult: { x__min_value: 1, x__max_value: 5, x__value_rows: 200 },
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
  it('includes WHERE clause in count and profiling queries for internal tables', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'x', type: 'Int32' }],
      rowCount: 10,
      profileResult: { x__min_value: 0, x__max_value: 9, x__value_rows: 10 },
    });

    await profileTable(driver, 'db', 'events', {
      partition: '2024-03',
      internalTables: ['events'],
    });

    const countSql = driver.calls.find((s) => s.includes('count()'));
    assert.ok(countSql.includes(`WHERE partition IN ('2024-03')`));

    const profilingSql = driver.calls.find(
      (s) => !s.startsWith('DESCRIBE') && !s.includes('count()')
    );
    assert.ok(profilingSql.includes(`WHERE partition IN ('2024-03')`));
  });

  it('omits WHERE clause when table is not in internalTables', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'x', type: 'Int32' }],
      rowCount: 10,
      profileResult: { x__min_value: 0, x__max_value: 9, x__value_rows: 10 },
    });

    await profileTable(driver, 'db', 'events', {
      partition: '2024-03',
      internalTables: ['other_table'],
    });

    const countSql = driver.calls.find((s) => s.includes('count()'));
    assert.ok(!countSql.includes('WHERE'));
  });
});

// ---------------------------------------------------------------------------
// profileTable — return shape
// ---------------------------------------------------------------------------

describe('profileTable — return shape', () => {
  it('returns the expected top-level fields', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'id', type: 'UInt64' }],
      rowCount: 42,
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
      rowCount: 10,
    });

    const result = await profileTable(driver, 'db', 'tbl');

    assert.equal(result.sampled, false);
    assert.equal(result.sample_size, null);
  });

  it('returns sampled=true and sample_size for large tables', async () => {
    const driver = createMockDriver({
      describeRows: [],
      rowCount: 2_000_000,
    });

    const result = await profileTable(driver, 'db', 'tbl');

    assert.equal(result.sampled, true);
    assert.equal(result.sample_size, 200_000);
  });
});

// ---------------------------------------------------------------------------
// profileTable — batching
// ---------------------------------------------------------------------------

describe('profileTable — batching', () => {
  it('splits columns into batches of 10', async () => {
    // Create 12 columns — should result in 2 batches (10 + 2)
    const describeRows = [];
    for (let i = 0; i < 12; i++) {
      describeRows.push({ name: `col${i}`, type: 'Int32' });
    }

    const driver = createMockDriver({
      describeRows,
      rowCount: 5,
      profileResult: {},
    });

    await profileTable(driver, 'db', 'tbl');

    // Queries: DESCRIBE + count + 2 batch profiling queries = 4
    const profilingQueries = driver.calls.filter(
      (s) => !s.startsWith('DESCRIBE') && !s.includes('count()')
    );
    assert.equal(profilingQueries.length, 2);

    // First batch should have 10 columns (30 select parts for NUMBER: min, max, value_rows each)
    // Second batch should have 2 columns
    const firstBatchParts = profilingQueries[0].split(',').length;
    const secondBatchParts = profilingQueries[1].split(',').length;
    // 10 INT columns × 3 parts = 30 parts
    assert.equal(firstBatchParts, 30);
    // 2 INT columns × 3 parts = 6 parts
    assert.equal(secondBatchParts, 6);
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
      rowCount: 10,
      profileResult: { x__min_value: 0, x__max_value: 9, x__value_rows: 10 },
    });

    await profileTable(driver, 'db', 'tbl', { emitter });

    const steps = events.map((e) => e.step);
    assert.ok(steps.includes('schema_analysis'));
    assert.ok(steps.includes('profiling'));
    assert.ok(events.length >= 4); // at least: schema start, schema done, profiling batch, profiling complete
  });
});

// ---------------------------------------------------------------------------
// profileTable — SQL correctness
// ---------------------------------------------------------------------------

describe('profileTable — generated SQL', () => {
  it('generates correct DESCRIBE TABLE query', async () => {
    const driver = createMockDriver({
      describeRows: [],
      rowCount: 0,
    });

    await profileTable(driver, 'analytics', 'page_views');

    assert.equal(driver.calls[0], 'DESCRIBE TABLE analytics.`page_views`');
  });

  it('generates correct count query', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'x', type: 'Int32' }],
      rowCount: 0,
    });

    await profileTable(driver, 'analytics', 'page_views');

    const countSql = driver.calls.find((s) => s.includes('count()'));
    assert.equal(countSql, 'SELECT count() as cnt FROM analytics.`page_views`');
  });

  it('generates correct profiling SQL for STRING column', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'status', type: 'String' }],
      rowCount: 10,
      profileResult: {},
    });

    await profileTable(driver, 'db', 'tbl');

    const profilingSql = driver.calls.find(
      (s) => !s.startsWith('DESCRIBE') && !s.includes('count()')
    );
    assert.ok(profilingSql.includes('uniqExact(`status`) as status__distinct_count'));
    assert.ok(profilingSql.includes("countIf(`status` IS NOT NULL and `status` != '') as status__value_rows"));
  });

  it('generates correct profiling SQL for MAP column', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'meta', type: 'Map(String, String)' }],
      rowCount: 10,
      profileResult: {},
    });

    await profileTable(driver, 'db', 'tbl');

    const profilingSql = driver.calls.find(
      (s) => !s.startsWith('DESCRIBE') && !s.includes('count()')
    );
    assert.ok(profilingSql.includes('groupUniqArrayArray(mapKeys(`meta`)) as meta__map_keys'));
    assert.ok(profilingSql.includes('meta__distinct_count'));
    assert.ok(profilingSql.includes('meta__value_rows'));
  });

  it('replaces dots with underscores in aliases for grouped columns', async () => {
    const driver = createMockDriver({
      describeRows: [{ name: 'nested.field', type: 'String' }],
      rowCount: 10,
      profileResult: {},
    });

    await profileTable(driver, 'db', 'tbl');

    const profilingSql = driver.calls.find(
      (s) => !s.startsWith('DESCRIBE') && !s.includes('count()')
    );
    // Alias should use underscore, column expression uses original name
    assert.ok(profilingSql.includes('nested_field__'), 'Alias should replace dots with underscores');
    assert.ok(profilingSql.includes('`nested.field`'), 'Column expression should use original name');
  });
});
