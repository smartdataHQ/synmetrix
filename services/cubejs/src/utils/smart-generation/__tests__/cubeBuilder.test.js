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
      profile: { hasValues: true, uniqueValues: [], uniqueKeys: [], lcValues: [], ...profile },
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

describe('cubeBuilder – buildCubes', () => {
  let table;

  beforeEach(() => {
    table = makeTable({
      columns: new Map([
        col('id', 'String', ColumnType.BASIC, ValueType.STRING),
        col('user_name', 'String', ColumnType.BASIC, ValueType.STRING),
        col('amount', 'Float64', ColumnType.BASIC, ValueType.NUMBER),
        col('created_at', 'DateTime', ColumnType.BASIC, ValueType.DATE),
      ]),
    });
  });

  describe('ProfiledTable to cube object conversion', () => {
    it('should produce a cube with correct name and sql_table', () => {
      const { cubes } = buildCubes(table);
      assert.strictEqual(cubes.length, 1);
      assert.strictEqual(cubes[0].name, 'events');
      assert.strictEqual(cubes[0].sql_table, 'test_db.events');
    });

    it('should produce dimensions for string and date columns', () => {
      const { cubes } = buildCubes(table);
      const dimNames = cubes[0].dimensions.map((d) => d.name);
      assert.ok(dimNames.includes('id'));
      assert.ok(dimNames.includes('user_name'));
      assert.ok(dimNames.includes('created_at'));
    });

    it('should produce a measure for numeric columns', () => {
      const { cubes } = buildCubes(table);
      const measureNames = cubes[0].measures.map((m) => m.name);
      assert.ok(measureNames.includes('count'), 'should include auto-generated count measure');
      assert.ok(measureNames.includes('amount'));
      const amountMeasure = cubes[0].measures.find((m) => m.name === 'amount');
      assert.strictEqual(amountMeasure.type, 'sum');
    });

    it('should set correct cube type on dimensions', () => {
      const { cubes } = buildCubes(table);
      const dims = cubes[0].dimensions;
      const idDim = dims.find((d) => d.name === 'id');
      const dateDim = dims.find((d) => d.name === 'created_at');
      assert.strictEqual(idDim.type, 'string');
      assert.strictEqual(dateDim.type, 'time');
    });
  });

  describe('Map key expansion', () => {
    it('should expand Map column into separate fields per unique key', () => {
      const t = makeTable({
        columns: new Map([
          col('props', 'Map(String, String)', ColumnType.MAP, ValueType.OTHER, {
            uniqueKeys: ['color', 'size'],
          }),
        ]),
      });

      const { cubes } = buildCubes(t);
      const dimNames = cubes[0].dimensions.map((d) => d.name);
      assert.ok(dimNames.includes('props_color'));
      assert.ok(dimNames.includes('props_size'));
    });
  });

  describe('provenance metadata', () => {
    it('should embed auto_generated, source_database, source_table, and generated_at', () => {
      const { cubes } = buildCubes(table);
      const meta = cubes[0].meta;
      assert.strictEqual(meta.auto_generated, true);
      assert.strictEqual(meta.source_database, 'test_db');
      assert.strictEqual(meta.source_table, 'events');
      assert.ok(typeof meta.generated_at === 'string');
      // Should be a valid ISO date
      assert.ok(!isNaN(Date.parse(meta.generated_at)));
    });
  });

  describe('empty column exclusion', () => {
    it('should skip columns where hasValues is false', () => {
      const t = makeTable({
        columns: new Map([
          col('active_col', 'String', ColumnType.BASIC, ValueType.STRING, { hasValues: true }),
          col('empty_col', 'String', ColumnType.BASIC, ValueType.STRING, { hasValues: false }),
        ]),
      });

      const { cubes, summary } = buildCubes(t);
      const allFieldNames = [
        ...cubes[0].dimensions.map((d) => d.name),
        ...cubes[0].measures.map((m) => m.name),
      ];
      assert.ok(allFieldNames.includes('active_col'));
      assert.ok(!allFieldNames.includes('empty_col'));
      assert.strictEqual(summary.columns_skipped, 1);
      assert.strictEqual(summary.columns_profiled, 1);
    });
  });

  describe('max Map key limit enforcement', () => {
    it('should truncate Map keys when exceeding maxMapKeys', () => {
      // Create 10 keys but set limit to 3
      const keys = Array.from({ length: 10 }, (_, i) => `key_${i}`);
      const t = makeTable({
        columns: new Map([
          col('big_map', 'Map(String, String)', ColumnType.MAP, ValueType.OTHER, {
            uniqueKeys: keys,
          }),
        ]),
      });

      const { cubes } = buildCubes(t, { maxMapKeys: 3 });
      const dimNames = cubes[0].dimensions.map((d) => d.name);

      // Should have exactly 3 expanded fields + 1 native map accessor
      const mapFields = dimNames.filter((n) => n.startsWith('big_map_'));
      assert.strictEqual(mapFields.length, 4); // 3 expanded + big_map_map
    });

    it('should keep all keys when under the limit', () => {
      const keys = ['a', 'b', 'c'];
      const t = makeTable({
        columns: new Map([
          col('small_map', 'Map(String, String)', ColumnType.MAP, ValueType.OTHER, {
            uniqueKeys: keys,
          }),
        ]),
      });

      const { cubes } = buildCubes(t, { maxMapKeys: 500 });
      const dimNames = cubes[0].dimensions.map((d) => d.name);
      const mapFields = dimNames.filter((n) => n.startsWith('small_map_'));
      assert.strictEqual(mapFields.length, 4); // 3 expanded + small_map_map
    });
  });

  describe('primary key marking', () => {
    it('should set primary_key and public on primary key dimensions', () => {
      const { cubes } = buildCubes(table, { primaryKeys: ['id'] });
      const idDim = cubes[0].dimensions.find((d) => d.name === 'id');
      assert.strictEqual(idDim.primary_key, true);
      assert.strictEqual(idDim.public, true);
    });

    it('should not mark non-primary-key fields', () => {
      const { cubes } = buildCubes(table, { primaryKeys: ['id'] });
      const nameDim = cubes[0].dimensions.find((d) => d.name === 'user_name');
      assert.strictEqual(nameDim.primary_key, undefined);
    });
  });

  describe('field deduplication', () => {
    it('should rename colliding field names', () => {
      // Two columns that would produce the same field name after processing
      const t = makeTable({
        columns: new Map([
          col('status', 'String', ColumnType.BASIC, ValueType.STRING),
          // A grouped column where parent.child yields "status" after sanitization
          [
            'meta.status',
            {
              name: 'meta.status',
              rawType: 'String',
              columnType: ColumnType.GROUPED,
              valueType: ValueType.STRING,
              isNullable: false,
              parentName: 'meta',
              childName: 'status',
              profile: { hasValues: true, uniqueValues: [], uniqueKeys: [], lcValues: [] },
            },
          ],
        ]),
      });

      const { cubes } = buildCubes(t);
      const dimNames = cubes[0].dimensions.map((d) => d.name);
      // All names should be unique
      const uniqueNames = new Set(dimNames);
      assert.strictEqual(uniqueNames.size, dimNames.length, 'All dimension names should be unique');
    });
  });

  describe('summary counts', () => {
    it('should report correct summary counts', () => {
      const { summary } = buildCubes(table);
      // id, user_name, created_at = 3 dimensions; count + amount = 2 measures
      assert.strictEqual(summary.dimensions_count, 3);
      assert.strictEqual(summary.measures_count, 2);
      assert.strictEqual(summary.cubes_count, 1);
      assert.strictEqual(summary.columns_profiled, 4);
      assert.strictEqual(summary.columns_skipped, 0);
    });
  });

  describe('cube name sanitization', () => {
    it('should prefix numeric-leading table names', () => {
      const t = makeTable({ table: '123_events' });
      t.columns = new Map([col('id', 'String', ColumnType.BASIC, ValueType.STRING)]);
      const { cubes } = buildCubes(t);
      assert.ok(!(/^\d/.test(cubes[0].name)), 'Cube name should not start with a digit');
      assert.strictEqual(cubes[0].name, 'cube_123_events');
    });

    it('should replace special characters with underscores', () => {
      const t = makeTable({ table: 'my-table.v2' });
      t.columns = new Map([col('id', 'String', ColumnType.BASIC, ValueType.STRING)]);
      const { cubes } = buildCubes(t);
      assert.ok(!cubes[0].name.includes('-'));
      assert.ok(!cubes[0].name.includes('.'));
    });
  });
});
