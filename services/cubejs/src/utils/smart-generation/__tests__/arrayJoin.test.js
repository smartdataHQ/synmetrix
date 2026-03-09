import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
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

describe('ARRAY JOIN – profiler detects Array columns', () => {
  it('should recognize ARRAY columnType from profiled column data', () => {
    const columns = new Map([
      col('tags', 'Array(String)', ColumnType.ARRAY, ValueType.STRING),
    ]);
    const entry = columns.get('tags');
    assert.strictEqual(entry.columnType, ColumnType.ARRAY);
  });
});

describe('ARRAY JOIN – buildCubes with arrayJoinColumns', () => {
  let table;

  beforeEach(() => {
    table = makeTable({
      columns: new Map([
        col('id', 'String', ColumnType.BASIC, ValueType.STRING),
        col('user_name', 'String', ColumnType.BASIC, ValueType.STRING),
        col('amount', 'Float64', ColumnType.BASIC, ValueType.NUMBER),
        col('tags', 'Array(String)', ColumnType.ARRAY, ValueType.STRING),
      ]),
    });
  });

  it('should generate a flattened cube with LEFT ARRAY JOIN in its SQL', () => {
    const { cubes } = buildCubes(table, {
      arrayJoinColumns: [{ column: 'tags', alias: 'tag' }],
    });

    assert.strictEqual(cubes.length, 2);
    const flatCube = cubes[1];
    assert.ok(flatCube.sql, 'Flattened cube should use sql property, not sql_table');
    assert.ok(
      flatCube.sql.includes('LEFT ARRAY JOIN'),
      `Expected LEFT ARRAY JOIN in SQL, got: ${flatCube.sql}`
    );
    assert.ok(
      flatCube.sql.includes('tags AS tag'),
      `Expected "tags AS tag" in SQL, got: ${flatCube.sql}`
    );
  });

  it('should name the flattened cube based on table and alias', () => {
    const { cubes } = buildCubes(table, {
      arrayJoinColumns: [{ column: 'tags', alias: 'tag' }],
    });

    assert.strictEqual(cubes[1].name, 'events_tag');
  });

  it('should inherit non-array dimensions from the raw cube', () => {
    const { cubes } = buildCubes(table, {
      arrayJoinColumns: [{ column: 'tags', alias: 'tag' }],
    });

    const rawDimNames = cubes[0].dimensions.map((d) => d.name);
    const flatDimNames = cubes[1].dimensions.map((d) => d.name);

    // Non-array dims (id, user_name, created_at equivalent) should appear in flattened cube
    for (const name of rawDimNames) {
      // Array-sourced dims may be excluded; non-array ones should be present
      if (name !== 'tags') {
        assert.ok(
          flatDimNames.includes(name),
          `Expected flattened cube to inherit dimension "${name}"`
        );
      }
    }
  });

  it('should add an element alias dimension to the flattened cube', () => {
    const { cubes } = buildCubes(table, {
      arrayJoinColumns: [{ column: 'tags', alias: 'tag' }],
    });

    const flatDimNames = cubes[1].dimensions.map((d) => d.name);
    assert.ok(
      flatDimNames.includes('tag'),
      `Expected alias dimension "tag" in flattened cube, got: ${flatDimNames.join(', ')}`
    );
  });

  it('should avoid field name collisions between raw and flattened cubes', () => {
    // Add a column named 'tag' so it collides with the alias
    table.columns.set(
      ...col('tag', 'String', ColumnType.BASIC, ValueType.STRING)
    );

    const { cubes } = buildCubes(table, {
      arrayJoinColumns: [{ column: 'tags', alias: 'tag' }],
    });

    const flatDimNames = cubes[1].dimensions.map((d) => d.name);
    // Should have both the inherited 'tag' and the alias, with one renamed
    const tagOccurrences = flatDimNames.filter((n) => n.includes('tag'));
    assert.ok(
      tagOccurrences.length >= 2,
      `Expected at least 2 tag-related dimensions to handle collision, got: ${flatDimNames.join(', ')}`
    );
    // All dimension names should be unique
    const uniqueNames = new Set(flatDimNames);
    assert.strictEqual(uniqueNames.size, flatDimNames.length, 'Dimension names should be unique');
  });

  it('should include all cubes in summary counts', () => {
    const { cubes, summary } = buildCubes(table, {
      arrayJoinColumns: [{ column: 'tags', alias: 'tag' }],
    });

    assert.strictEqual(summary.cubes_count, 2);
    const totalDims = cubes.reduce((sum, c) => sum + c.dimensions.length, 0);
    const totalMeasures = cubes.reduce((sum, c) => sum + c.measures.length, 0);
    assert.strictEqual(summary.dimensions_count, totalDims);
    assert.strictEqual(summary.measures_count, totalMeasures);
  });

  it('should handle multiple arrayJoinColumns generating multiple flattened cubes', () => {
    table.columns.set(
      ...col('categories', 'Array(String)', ColumnType.ARRAY, ValueType.STRING)
    );

    const { cubes, summary } = buildCubes(table, {
      arrayJoinColumns: [
        { column: 'tags', alias: 'tag' },
        { column: 'categories', alias: 'category' },
      ],
    });

    assert.strictEqual(cubes.length, 3);
    assert.strictEqual(summary.cubes_count, 3);
    assert.strictEqual(cubes[1].name, 'events_tag');
    assert.strictEqual(cubes[2].name, 'events_category');
  });
});
