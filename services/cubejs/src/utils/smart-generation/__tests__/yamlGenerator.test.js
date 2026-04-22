import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateYaml, generateFileName, generateJs } from '../yamlGenerator.js';

describe('yamlGenerator – generateYaml', () => {
  function makeCube(overrides = {}) {
    return {
      name: 'orders',
      sql_table: 'analytics.orders',
      meta: {
        auto_generated: true,
        source_database: 'analytics',
        source_table: 'orders',
        generated_at: '2026-01-15T10:00:00.000Z',
      },
      dimensions: [
        { name: 'order_id', sql: '{CUBE}.order_id', type: 'string', meta: { auto_generated: true } },
        { name: 'created_at', sql: '{CUBE}.created_at', type: 'time', meta: { auto_generated: true } },
      ],
      measures: [
        { name: 'total', sql: '{CUBE}.total', type: 'sum', meta: { auto_generated: true } },
      ],
      ...overrides,
    };
  }

  describe('cube to YAML serialization', () => {
    it('should produce valid YAML with cubes key', () => {
      const yaml = generateYaml([makeCube()]);
      assert.ok(yaml.includes('cubes:'));
      assert.ok(yaml.includes('name: orders'));
    });

    it('should include sql_table in output', () => {
      const yaml = generateYaml([makeCube()]);
      assert.ok(yaml.includes('sql_table: analytics.orders'));
    });

    it('should use sql instead of sql_table when cube has custom sql', () => {
      const cube = makeCube({ sql_table: undefined, sql: 'SELECT * FROM foo' });
      delete cube.sql_table;
      const yaml = generateYaml([cube]);
      assert.ok(yaml.includes('sql: SELECT * FROM foo'));
      assert.ok(!yaml.includes('sql_table'));
    });

    it('should include dimensions and measures sections', () => {
      const yaml = generateYaml([makeCube()]);
      assert.ok(yaml.includes('dimensions:'));
      assert.ok(yaml.includes('measures:'));
      assert.ok(yaml.includes('name: order_id'));
      assert.ok(yaml.includes('name: total'));
    });

    it('should omit dimensions section when empty', () => {
      const cube = makeCube({ dimensions: [] });
      const yaml = generateYaml([cube]);
      assert.ok(!yaml.includes('dimensions:'));
    });

    it('should omit measures section when empty', () => {
      const cube = makeCube({ measures: [] });
      const yaml = generateYaml([cube]);
      assert.ok(!yaml.includes('measures:'));
    });
  });

  describe('meta.auto_generated tags', () => {
    it('should include auto_generated: true in cube-level meta', () => {
      const yaml = generateYaml([makeCube()]);
      assert.ok(yaml.includes('auto_generated: true'));
    });

    it('should include auto_generated in each field meta', () => {
      const yaml = generateYaml([makeCube()]);
      // Count occurrences: 1 cube-level + 2 dimensions + 1 measure = 4
      const matches = yaml.match(/auto_generated: true/g);
      assert.ok(matches, 'Should have auto_generated markers');
      assert.ok(matches.length >= 4, `Expected at least 4 auto_generated tags, got ${matches.length}`);
    });
  });

  describe('provenance metadata at cube level', () => {
    it('should include source_database, source_table, and generated_at', () => {
      const yaml = generateYaml([makeCube()]);
      assert.ok(yaml.includes('source_database: analytics'));
      assert.ok(yaml.includes('source_table: orders'));
      assert.ok(yaml.includes('generated_at:'));
    });
  });

  describe('field name sanitization in output', () => {
    it('should output sanitized field names as-is', () => {
      const cube = makeCube({
        dimensions: [
          { name: 'my_field_123', sql: '{CUBE}.my_field_123', type: 'string', meta: { auto_generated: true } },
        ],
      });
      const yaml = generateYaml([cube]);
      assert.ok(yaml.includes('name: my_field_123'));
    });
  });

  describe('generateFileName', () => {
    it('should return table_name.js by default', () => {
      assert.strictEqual(generateFileName('orders'), 'orders.js');
    });

    it('should return .yml when js=false', () => {
      assert.strictEqual(generateFileName('orders', false), 'orders.yml');
    });

    it('should handle names with special characters', () => {
      assert.strictEqual(generateFileName('my-table'), 'my-table.js');
    });

    it('should handle names with dots', () => {
      assert.strictEqual(generateFileName('schema.table'), 'schema.table.js');
    });
  });

  describe('multi-cube serialization', () => {
    it('should serialize multiple cubes under the cubes key', () => {
      const cube1 = makeCube();
      const cube2 = makeCube({ name: 'users', sql_table: 'analytics.users' });
      const yaml = generateYaml([cube1, cube2]);

      assert.ok(yaml.includes('name: orders'));
      assert.ok(yaml.includes('name: users'));
      assert.ok(yaml.includes('sql_table: analytics.users'));
    });

    it('should include all cubes in a single YAML document', () => {
      const cube1 = makeCube();
      const cube2 = makeCube({ name: 'users', sql_table: 'analytics.users' });
      const yaml = generateYaml([cube1, cube2]);

      // Should have exactly one cubes: key
      const cubesMatches = yaml.match(/^cubes:/gm);
      assert.strictEqual(cubesMatches.length, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// generateJs — advanced measure properties
// ---------------------------------------------------------------------------

describe('yamlGenerator – generateJs advanced properties', () => {
  function makeCubeWithMeasure(measureOverrides = {}) {
    return {
      name: 'events',
      sql_table: 'analytics.events',
      meta: { auto_generated: true },
      dimensions: [],
      measures: [{
        name: 'total',
        sql: '{CUBE}.amount',
        type: 'sum',
        meta: { auto_generated: true },
        ...measureOverrides,
      }],
    };
  }

  it('serializes rollingWindow with to_date type', () => {
    const cube = makeCubeWithMeasure({
      name: 'ytd_amount',
      rollingWindow: { type: 'to_date', granularity: 'year' },
    });
    const js = generateJs([cube]);
    assert.ok(js.includes('rollingWindow:'), 'should include rollingWindow');
    assert.ok(js.includes("type: 'to_date'"), 'should include to_date type');
    assert.ok(js.includes("granularity: 'year'"), 'should include year granularity');
  });

  it('serializes rollingWindow with fixed type and trailing', () => {
    const cube = makeCubeWithMeasure({
      name: 'rolling_7d',
      rollingWindow: { type: 'fixed', trailing: '7 days' },
    });
    const js = generateJs([cube]);
    assert.ok(js.includes("type: 'fixed'"));
    assert.ok(js.includes("trailing: '7 days'"));
  });

  it('serializes multiStage: true', () => {
    const cube = makeCubeWithMeasure({
      name: 'yoy_amount',
      sql: '{total_amount}',
      type: 'number',
      multiStage: true,
    });
    const js = generateJs([cube]);
    assert.ok(js.includes('multiStage: true,'), 'should include multiStage: true');
  });

  it('serializes timeShift array', () => {
    const cube = makeCubeWithMeasure({
      name: 'yoy_amount',
      sql: '{total_amount}',
      type: 'number',
      multiStage: true,
      timeShift: [{ interval: '1 year', type: 'prior' }],
    });
    const js = generateJs([cube]);
    assert.ok(js.includes('timeShift:'), 'should include timeShift');
    assert.ok(js.includes("interval: '1 year'"), 'should include interval');
    assert.ok(js.includes("type: 'prior'"), 'should include type prior');
  });

  it('serializes multiple timeShift entries', () => {
    const cube = makeCubeWithMeasure({
      name: 'comparison',
      sql: '{total_amount}',
      type: 'number',
      multiStage: true,
      timeShift: [
        { interval: '1 year', type: 'prior' },
        { interval: '1 month', type: 'prior' },
      ],
    });
    const js = generateJs([cube]);
    assert.ok(js.includes("interval: '1 year'"));
    assert.ok(js.includes("interval: '1 month'"));
  });

  it('does not serialize properties when not present', () => {
    const cube = makeCubeWithMeasure();
    const js = generateJs([cube]);
    assert.ok(!js.includes('rollingWindow'));
    assert.ok(!js.includes('multiStage'));
    assert.ok(!js.includes('timeShift'));
  });

  it('converts {measure_name} to ${measure_name} in JS template', () => {
    const cube = makeCubeWithMeasure({
      name: 'yoy_amount',
      sql: '{total_amount}',
      type: 'number',
      multiStage: true,
    });
    const js = generateJs([cube]);
    assert.ok(js.includes('${total_amount}'), 'should convert {measure} to ${measure}');
  });

  it('emits cube-level sql with JSON string so ClickHouse backticks are not escaped (no \\\\`)', () => {
    const sql = 'SELECT *, `commerce.total`, duration_ratio FROM dev.semantic_events';
    const cube = {
      name: 'semantic_events',
      sql,
      meta: { auto_generated: true },
      dimensions: [],
      measures: [],
    };
    const js = generateJs([cube]);
    assert.ok(js.includes('sql: "SELECT *, `commerce.total`, duration_ratio FROM dev.semantic_events"'), js);
    assert.ok(!js.includes('\\`commerce'), 'should not escape inner backticks with backslash');
  });
});
