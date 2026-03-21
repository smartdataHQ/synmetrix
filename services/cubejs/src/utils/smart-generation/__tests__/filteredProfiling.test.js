/**
 * T016: Integration tests for filtered table profiling.
 *
 * Verifies that:
 *   - buildWhereClause with empty filters behaves identically to current (partition-only)
 *   - buildFilterWhereClause produces valid WHERE clauses composable with partition WHERE
 *   - Composing partition WHERE + filter WHERE with AND produces valid SQL
 *   - Invalid column names in filters are rejected before any query
 *   - Filter normalization: missing/invalid filters default to empty array
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhereClause } from '../profiler.js';
import { buildFilterWhereClause } from '../filterBuilder.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const schema = 'test_db';
const table = 'events';
const partition = '2025-01-01';
const internalTables = ['events', 'other_table'];
const tableColumns = ['country', 'event_date', 'amount', 'status'];

// ---------------------------------------------------------------------------
// 1. buildWhereClause with empty/missing filters — partition-only behavior
// ---------------------------------------------------------------------------

describe('buildWhereClause with filters parameter', () => {
  it('returns partition-only clause when filters is undefined', () => {
    const result = buildWhereClause(schema, table, partition, internalTables);
    assert.ok(result.includes('partition'));
    assert.ok(result.includes(partition));
    assert.ok(!result.includes('AND'));
  });

  it('returns partition-only clause when filters is empty array', () => {
    const result = buildWhereClause(schema, table, partition, internalTables, []);
    assert.ok(result.includes('partition'));
    assert.ok(result.includes(partition));
    assert.ok(!result.includes('AND'));
  });

  it('returns empty string with no partition and no filters', () => {
    const result = buildWhereClause(schema, table, null, internalTables, []);
    assert.equal(result, '');
  });

  it('returns empty string when table not in internalTables', () => {
    const result = buildWhereClause(schema, 'unknown_table', partition, internalTables, []);
    assert.equal(result, '');
  });

  it('composes partition + filter clauses with AND when both present', () => {
    const filters = [{ column: 'country', operator: '=', value: 'US' }];
    const result = buildWhereClause(schema, table, partition, internalTables, filters, tableColumns);
    assert.ok(result.includes('WHERE'));
    assert.ok(result.includes('partition'));
    assert.ok(result.includes('AND'));
    assert.ok(result.includes("country = 'US'"));
  });

  it('returns filter-only clause when no partition but filters provided', () => {
    const filters = [{ column: 'country', operator: '=', value: 'US' }];
    const result = buildWhereClause(schema, table, null, internalTables, filters, tableColumns);
    assert.ok(result.includes('WHERE'));
    assert.ok(result.includes("country = 'US'"));
    assert.ok(!result.includes('partition'));
  });
});

// ---------------------------------------------------------------------------
// 2. buildFilterWhereClause produces valid WHERE clause
// ---------------------------------------------------------------------------

describe('buildFilterWhereClause composability', () => {
  it('produces WHERE clause that starts with " WHERE "', () => {
    const filters = [{ column: 'country', operator: '=', value: 'US' }];
    const result = buildFilterWhereClause(filters, tableColumns);
    assert.ok(result.startsWith(' WHERE '));
  });

  it('empty filters returns empty string', () => {
    assert.equal(buildFilterWhereClause([], tableColumns), '');
    assert.equal(buildFilterWhereClause(null, tableColumns), '');
    assert.equal(buildFilterWhereClause(undefined, tableColumns), '');
  });
});

// ---------------------------------------------------------------------------
// 3. Composing partition WHERE + filter WHERE produces valid SQL
// ---------------------------------------------------------------------------

describe('partition + filter WHERE composition', () => {
  it('AND-composed clause is syntactically valid SQL', () => {
    const partitionWhere = ` WHERE partition IN ('2025-01-01')`;
    const filterWhere = buildFilterWhereClause(
      [{ column: 'country', operator: '=', value: 'US' }],
      tableColumns,
    );

    // Strip leading " WHERE " from filterWhere to get just conditions
    const filterConditions = filterWhere.replace(/^\s*WHERE\s+/, '');
    const composed = `${partitionWhere} AND ${filterConditions}`;

    assert.ok(composed.startsWith(' WHERE'));
    assert.ok(composed.includes('partition'));
    assert.ok(composed.includes('AND'));
    assert.ok(composed.includes("country = 'US'"));
    // Should have exactly one WHERE keyword
    const whereCount = (composed.match(/WHERE/g) || []).length;
    assert.equal(whereCount, 1, 'composed clause should have exactly one WHERE');
  });

  it('multiple filter conditions compose cleanly with partition', () => {
    const filters = [
      { column: 'country', operator: '=', value: 'US' },
      { column: 'amount', operator: '>', value: 100 },
    ];
    const filterWhere = buildFilterWhereClause(filters, tableColumns);
    const filterConditions = filterWhere.replace(/^\s*WHERE\s+/, '');

    const partitionWhere = ` WHERE partition IN ('2025-01-01')`;
    const composed = `${partitionWhere} AND ${filterConditions}`;

    assert.ok(composed.includes("country = 'US'"));
    assert.ok(composed.includes('amount > 100'));
    const whereCount = (composed.match(/WHERE/g) || []).length;
    assert.equal(whereCount, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid column name in filter is rejected before any query
// ---------------------------------------------------------------------------

describe('invalid column rejection', () => {
  it('throws for column not in table schema', () => {
    const filters = [{ column: 'nonexistent_col', operator: '=', value: 'x' }];
    assert.throws(
      () => buildFilterWhereClause(filters, tableColumns),
      (err) => err instanceof Error && /column/i.test(err.message),
    );
  });

  it('buildWhereClause throws when filters reference invalid columns', () => {
    const filters = [{ column: 'bad_col', operator: '=', value: 'x' }];
    assert.throws(
      () => buildWhereClause(schema, table, partition, internalTables, filters, tableColumns),
      (err) => err instanceof Error && /column/i.test(err.message),
    );
  });

  it('validation happens synchronously — no async query needed', () => {
    const filters = [{ column: 'injected; DROP TABLE', operator: '=', value: 'x' }];
    // Must throw synchronously, not return a rejected promise
    assert.throws(
      () => buildFilterWhereClause(filters, tableColumns),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Filter normalization: missing/invalid filters default to empty array
// ---------------------------------------------------------------------------

describe('filter normalization', () => {
  it('null filters treated as empty — no filtering applied', () => {
    const result = buildWhereClause(schema, table, partition, internalTables, null);
    // Should behave like no filters — partition only
    assert.ok(result.includes('partition'));
    assert.ok(!result.includes('AND'));
  });

  it('undefined filters treated as empty', () => {
    const result = buildWhereClause(schema, table, partition, internalTables, undefined);
    assert.ok(result.includes('partition'));
    assert.ok(!result.includes('AND'));
  });

  it('non-array filters (string) treated as empty', () => {
    const result = buildWhereClause(schema, table, partition, internalTables, 'not an array');
    assert.ok(result.includes('partition'));
    assert.ok(!result.includes('AND'));
  });

  it('non-array filters (object) treated as empty', () => {
    const result = buildWhereClause(schema, table, partition, internalTables, {});
    assert.ok(result.includes('partition'));
    assert.ok(!result.includes('AND'));
  });

  it('filters with valid entries are applied', () => {
    const filters = [{ column: 'status', operator: '=', value: 'active' }];
    const result = buildWhereClause(schema, table, null, [], filters, tableColumns);
    assert.ok(result.includes("status = 'active'"));
  });
});
