import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterWhereClause } from '../filterBuilder.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const tableColumns = ['country', 'event_date', 'amount', 'status', 'is_active'];

// ---------------------------------------------------------------------------
// Empty / baseline
// ---------------------------------------------------------------------------

describe('buildFilterWhereClause', () => {
  it('returns empty string for empty filters array', () => {
    const result = buildFilterWhereClause([], tableColumns);
    assert.equal(result, '');
  });

  // -------------------------------------------------------------------------
  // Single filter
  // -------------------------------------------------------------------------

  it('single = filter returns correct WHERE clause', () => {
    const filters = [{ column: 'country', operator: '=', value: 'US' }];
    const result = buildFilterWhereClause(filters, tableColumns);
    // Leading space is intentional — designed for appending to existing SQL
    assert.equal(result.trim(), "WHERE country = 'US'");
    assert.ok(result.includes("country = 'US'"));
  });

  // -------------------------------------------------------------------------
  // Multiple filters
  // -------------------------------------------------------------------------

  it('multiple filters are AND-ed together', () => {
    const filters = [
      { column: 'country', operator: '=', value: 'US' },
      { column: 'amount', operator: '>', value: 100 },
    ];
    const result = buildFilterWhereClause(filters, tableColumns);
    assert.ok(result.includes('WHERE'));
    assert.ok(result.includes(' AND '));
    assert.ok(result.includes("country = 'US'"));
    assert.ok(result.includes('amount > 100'));
  });

  // -------------------------------------------------------------------------
  // IN operator
  // -------------------------------------------------------------------------

  it('IN operator with array values returns correct IN (...) clause', () => {
    const filters = [{ column: 'status', operator: 'IN', value: ['active', 'pending'] }];
    const result = buildFilterWhereClause(filters, tableColumns);
    assert.ok(result.includes("IN ('active', 'pending')") || result.includes("IN ('active','pending')"));
  });

  it('empty IN array throws or rejects', () => {
    const filters = [{ column: 'status', operator: 'IN', value: [] }];
    assert.throws(() => buildFilterWhereClause(filters, tableColumns));
  });

  // -------------------------------------------------------------------------
  // IS NULL / IS NOT NULL
  // -------------------------------------------------------------------------

  it('IS NULL with no value produces correct SQL', () => {
    const filters = [{ column: 'event_date', operator: 'IS NULL', value: null }];
    const result = buildFilterWhereClause(filters, tableColumns);
    assert.ok(result.includes('event_date IS NULL'));
  });

  it('IS NOT NULL with no value produces correct SQL', () => {
    const filters = [{ column: 'event_date', operator: 'IS NOT NULL', value: null }];
    const result = buildFilterWhereClause(filters, tableColumns);
    assert.ok(result.includes('event_date IS NOT NULL'));
  });

  // -------------------------------------------------------------------------
  // Invalid column
  // -------------------------------------------------------------------------

  it('invalid column name throws error', () => {
    const filters = [{ column: 'nonexistent', operator: '=', value: 'x' }];
    assert.throws(
      () => buildFilterWhereClause(filters, tableColumns),
      (err) => err instanceof Error && /column/i.test(err.message),
    );
  });

  // -------------------------------------------------------------------------
  // SQL injection safety
  // -------------------------------------------------------------------------

  it('SQL injection attempts in values are safely escaped', () => {
    const filters = [{ column: 'country', operator: '=', value: "'; DROP TABLE --" }];
    const result = buildFilterWhereClause(filters, tableColumns);
    // The single quote in the value must be doubled (escaped), not left raw
    // Raw injection: country = ''; DROP TABLE --'
    // Safe escaped: country = '''; DROP TABLE --'
    // Key: the value's internal single quote is doubled
    assert.ok(result.includes("''"), 'single quotes should be doubled for escaping');
    // The result should not allow a string-terminating quote to break out
    // After the opening quote for the value, the next unescaped quote should be the closing one
    assert.ok(!result.includes("= '';")); // would indicate raw interpolation
  });

  // -------------------------------------------------------------------------
  // Max filters enforcement
  // -------------------------------------------------------------------------

  it('max 10 filters enforced — 11 throws', () => {
    const filters = Array.from({ length: 11 }, (_, i) => ({
      column: 'country',
      operator: '=',
      value: `val${i}`,
    }));
    assert.throws(
      () => buildFilterWhereClause(filters, tableColumns),
      (err) => err instanceof Error && /max|limit|10/i.test(err.message),
    );
  });

  // -------------------------------------------------------------------------
  // All 11 operators produce valid SQL
  // -------------------------------------------------------------------------

  describe('all 11 operators produce valid SQL', () => {
    const operatorsWithValue = [
      { op: '=', value: 'US', check: "= 'US'" },
      { op: '!=', value: 'US', check: "!= 'US'" },
      { op: '>', value: 100, check: '> 100' },
      { op: '>=', value: 100, check: '>= 100' },
      { op: '<', value: 100, check: '< 100' },
      { op: '<=', value: 100, check: '<= 100' },
      { op: 'IN', value: ['a', 'b'], check: 'IN' },
      { op: 'NOT IN', value: ['a', 'b'], check: 'NOT IN' },
      { op: 'LIKE', value: '%test%', check: 'LIKE' },
    ];

    for (const { op, value, check } of operatorsWithValue) {
      it(`operator ${op}`, () => {
        const col = op === '>' || op === '>=' || op === '<' || op === '<=' ? 'amount' : 'country';
        const filters = [{ column: col, operator: op, value }];
        const result = buildFilterWhereClause(filters, tableColumns);
        assert.ok(result.includes('WHERE'));
        assert.ok(result.includes(check));
      });
    }

    it('operator IS NULL', () => {
      const filters = [{ column: 'country', operator: 'IS NULL', value: null }];
      const result = buildFilterWhereClause(filters, tableColumns);
      assert.ok(result.includes('IS NULL'));
    });

    it('operator IS NOT NULL', () => {
      const filters = [{ column: 'country', operator: 'IS NOT NULL', value: null }];
      const result = buildFilterWhereClause(filters, tableColumns);
      assert.ok(result.includes('IS NOT NULL'));
    });
  });

  // -------------------------------------------------------------------------
  // Type coercion
  // -------------------------------------------------------------------------

  it('numeric values interpolated unquoted', () => {
    const filters = [{ column: 'amount', operator: '=', value: 42 }];
    const result = buildFilterWhereClause(filters, tableColumns);
    assert.ok(result.includes('amount = 42'));
    // Should NOT be quoted
    assert.ok(!result.includes("'42'"));
  });

  it('string values single-quoted with internal quotes doubled', () => {
    const filters = [{ column: 'country', operator: '=', value: "it's" }];
    const result = buildFilterWhereClause(filters, tableColumns);
    assert.ok(result.includes("'it''s'"));
  });

  it('date values treated as quoted ISO strings', () => {
    const filters = [{ column: 'event_date', operator: '>=', value: '2025-01-01' }];
    const result = buildFilterWhereClause(filters, tableColumns);
    assert.ok(result.includes("'2025-01-01'"));
  });

  it('boolean values mapped to 1/0', () => {
    const filtersTrue = [{ column: 'is_active', operator: '=', value: true }];
    const resultTrue = buildFilterWhereClause(filtersTrue, tableColumns);
    assert.ok(resultTrue.includes('1'));

    const filtersFalse = [{ column: 'is_active', operator: '=', value: false }];
    const resultFalse = buildFilterWhereClause(filtersFalse, tableColumns);
    assert.ok(resultFalse.includes('0'));
  });
});
