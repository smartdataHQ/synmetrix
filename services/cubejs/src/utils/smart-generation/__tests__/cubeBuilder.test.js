import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { buildCubes, deriveCubeNameFromFlatFilters } from '../cubeBuilder.js';
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

    it('should list ClickHouse ALIAS columns after SELECT * when aliasColumnNames is provided', () => {
      const { cubes } = buildCubes(table, { aliasColumnNames: ['duration_ratio'] });
      assert.strictEqual(cubes[0].sql, 'SELECT *, duration_ratio FROM test_db.events');
      assert.strictEqual(cubes[0].sql_table, undefined);
    });

    it('should append ALIAS columns to filtered cube sql', () => {
      const { cubes } = buildCubes(table, {
        aliasColumnNames: ['duration_ratio'],
        filters: [{ column: 'id', operator: '=', value: 'x' }],
      });
      assert.strictEqual(
        cubes[0].sql,
        "SELECT *, duration_ratio FROM test_db.events WHERE id = 'x'"
      );
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
    it('expands Map columns and prefers the bare key when no clash', () => {
      const t = makeTable({
        columns: new Map([
          col('props', 'Map(String, String)', ColumnType.MAP, ValueType.OTHER, {
            uniqueKeys: ['color', 'size'],
          }),
        ]),
      });

      const { cubes } = buildCubes(t);
      const dimNames = cubes[0].dimensions.map((d) => d.name);
      // Shortest-unique resolver drops the `props_` prefix when nothing else
      // wants `color` / `size`.
      assert.ok(dimNames.includes('color'), `expected 'color' in ${JSON.stringify(dimNames)}`);
      assert.ok(dimNames.includes('size'), `expected 'size' in ${JSON.stringify(dimNames)}`);
      // Native map accessor keeps its qualified name (already includes the column name).
      assert.ok(dimNames.includes('props_map'));
    });

    it('falls back to the qualified name when the bare key clashes', () => {
      // A basic `color` column already owns the leaf name → map key advances
      // to `props_color`.
      const t = makeTable({
        columns: new Map([
          col('color', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 5,
          }),
          col('props', 'Map(String, String)', ColumnType.MAP, ValueType.OTHER, {
            uniqueKeys: ['color', 'size'],
          }),
        ]),
      });
      const { cubes } = buildCubes(t);
      const dimNames = cubes[0].dimensions.map((d) => d.name);
      assert.ok(dimNames.includes('color'), 'basic column keeps its leaf name');
      assert.ok(dimNames.includes('props_color'), 'map key falls back to qualified name on clash');
      assert.ok(dimNames.includes('size'), `'size' should still be unique → bare leaf. Got: ${JSON.stringify(dimNames)}`);
    });
  });

  describe('provenance metadata', () => {
    it('embeds auto_generated, source_database, source_table (no volatile generated_at — §4)', () => {
      const { cubes } = buildCubes(table);
      const meta = cubes[0].meta;
      assert.strictEqual(meta.auto_generated, true);
      assert.strictEqual(meta.source_database, 'test_db');
      assert.strictEqual(meta.source_table, 'events');
      // Lean trim (§4): generated_at is volatile (breaks byte-identical reruns,
      // SC-002) and grain_description duplicates `grain` — both are gone.
      assert.strictEqual(meta.generated_at, undefined);
      assert.strictEqual(meta.grain_description, undefined);
    });
  });

  describe('meta trim — bounded, data-plane-first', () => {
    it('bakes no volatile or redundant per-field meta (range / raw_type / max_array_length)', () => {
      const t = makeTable({
        columns: new Map([
          col('amount', 'Float64', ColumnType.BASIC, ValueType.NUMBER, {
            hasValues: true, uniqueValues: 4200, minValue: 1, maxValue: 950, avgValue: 77.3,
          }),
        ]),
      });
      const { cubes } = buildCubes(t);
      const amount = cubes[0].measures.find((m) => m.name === 'amount');
      assert.ok(amount, 'amount measure expected');
      assert.strictEqual(amount.meta.range, undefined);
      assert.strictEqual(amount.meta.raw_type, undefined);
      assert.strictEqual(amount.meta.max_array_length, undefined);
      // §4: source_column + field_type are dropped — the member's own `type`
      // carries the shape; only `auto_generated` (the merge key) remains.
      assert.strictEqual(amount.meta.field_type, undefined);
      assert.strictEqual(amount.meta.source_column, undefined);
      assert.strictEqual(amount.meta.auto_generated, true);
    });

    it('does not bake per-field cardinality snapshots (unique_values) — §4 data-plane-first', () => {
      const t = makeTable({
        columns: new Map([
          col('status', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 5, lcValues: ['a', 'b', 'c', 'd', 'e'],
          }),
          col('city', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 8314,
          }),
        ]),
      });
      const { cubes } = buildCubes(t);
      const status = cubes[0].dimensions.find((d) => d.name === 'status');
      const city = cubes[0].dimensions.find((d) => d.name === 'city');
      // Cardinality snapshots rot as data arrives — /meta/dynamic answers it.
      assert.strictEqual(status.meta.unique_values, undefined);
      assert.strictEqual(city.meta.unique_values, undefined);
    });

    it('does not bake sampled values (lc_values) into meta — §4 (they rot and leak data)', () => {
      const t = makeTable({
        columns: new Map([
          col('tier', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 3, lcValues: ['bronze', 'gold', 'silver'],
          }),
          col('sku_bucket', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 40,
            lcValues: Array.from({ length: 12 }, (_, i) => `v${i}`),
          }),
          // identifier-shaped values are especially PII-adjacent — never baked
          col('user_ref', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 2,
            lcValues: [
              '067289d0-cd97-401e-b0cc-d45630bd9e97',
              'b99d4d95-cdfc-4c8a-8085-a8030c15ad78',
            ],
          }),
        ]),
      });
      const { cubes } = buildCubes(t);
      const dim = (n) => cubes[0].dimensions.find((d) => d.name === n);
      // No enum list is baked anymore — live queries answer value questions.
      assert.strictEqual(dim('tier').meta.lc_values, undefined);
      assert.strictEqual(dim('sku_bucket').meta.lc_values, undefined);
      assert.strictEqual(dim('user_ref').meta.lc_values, undefined);
    });

    it('emits descriptions as the Cube-native property, never meta, and not on expanded map keys', () => {
      const t = makeTable({
        columns: new Map([
          col('status', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 2, lcValues: ['on', 'off'],
          }),
          col('props', 'Map(String, String)', ColumnType.MAP, ValueType.OTHER, {
            uniqueKeys: ['color'],
          }),
        ]),
        columnDescriptions: new Map([
          ['status', 'Current status'],
          ['props', 'Additional low-cardinality dimensions'],
        ]),
      });
      const { cubes } = buildCubes(t);
      const dim = (n) => cubes[0].dimensions.find((d) => d.name === n);
      assert.strictEqual(dim('status').description, 'Current status');
      assert.strictEqual(dim('status').meta.description, undefined);
      // expanded key: no parent-description copy
      assert.strictEqual(dim('color').description, undefined);
      // native map accessor keeps the column description, no baked key inventory
      assert.strictEqual(dim('props_map').description, 'Additional low-cardinality dimensions');
      assert.strictEqual(dim('props_map').meta.known_keys, undefined);
    });

    it('bakes titles only where they differ from the derived default (acronyms)', () => {
      const t = makeTable({
        columns: new Map([
          col('order_id', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 900,
          }),
          col('store_format', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 8,
          }),
        ]),
      });
      const { cubes } = buildCubes(t);
      const dim = (n) => cubes[0].dimensions.find((d) => d.name === n);
      assert.strictEqual(dim('order_id').title, 'Order ID');
      assert.strictEqual(dim('store_format').title, undefined);
    });

    it('cube meta carries no refresh_cadence or description duplicate (native description wins)', () => {
      const { cubes } = buildCubes(table);
      assert.strictEqual(cubes[0].meta.refresh_cadence, undefined);
      assert.strictEqual(cubes[0].meta.description, undefined);
      assert.ok(typeof cubes[0].description === 'string' && cubes[0].description.length > 0);
      // generated_at trimmed (§4) — no volatile timestamp in cube meta
      assert.strictEqual(cubes[0].meta.generated_at, undefined);
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

  describe('single empty/zero value exclusion', () => {
    it('skips numeric columns whose only value is 0', () => {
      const t = makeTable({
        columns: new Map([
          col('amount', 'Float64', ColumnType.BASIC, ValueType.NUMBER, {
            hasValues: true, uniqueValues: 1, minValue: 0, maxValue: 0,
          }),
          col('count', 'Int32', ColumnType.BASIC, ValueType.NUMBER, {
            hasValues: true, uniqueValues: 5, minValue: 0, maxValue: 42,
          }),
        ]),
      });
      const { cubes } = buildCubes(t);
      const names = cubes[0].measures.map((m) => m.name);
      assert.ok(!names.includes('amount'), 'all-zero numeric should be skipped');
      assert.ok(names.includes('count'), 'numeric with non-zero values must remain');
    });

    it('skips string columns whose only LC-probed value is empty / whitespace / "0"', () => {
      const t = makeTable({
        columns: new Map([
          col('blank_text', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 1, lcValues: [''],
          }),
          col('whitespace', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 1, lcValues: ['   '],
          }),
          col('zero_text', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 1, lcValues: ['0'],
          }),
          col('useful', 'String', ColumnType.BASIC, ValueType.STRING, {
            hasValues: true, uniqueValues: 1, lcValues: ['active'],
          }),
        ]),
      });
      const { cubes } = buildCubes(t);
      const names = cubes[0].dimensions.map((d) => d.name);
      assert.ok(!names.includes('blank_text'));
      assert.ok(!names.includes('whitespace'));
      assert.ok(!names.includes('zero_text'));
      assert.ok(names.includes('useful'), 'meaningful constant string should be kept');
    });

    it('keeps numeric column when min!==max even if min is 0', () => {
      const t = makeTable({
        columns: new Map([
          col('score', 'Float64', ColumnType.BASIC, ValueType.NUMBER, {
            hasValues: true, uniqueValues: 10, minValue: 0, maxValue: 100,
          }),
        ]),
      });
      const { cubes } = buildCubes(t);
      const names = cubes[0].measures.map((m) => m.name);
      assert.ok(names.includes('score'));
    });

    it('skips boolean column with single distinct value (always-true OR always-false)', () => {
      const t = makeTable({
        columns: new Map([
          col('always_false_flag', 'Bool', ColumnType.BASIC, ValueType.BOOLEAN, {
            hasValues: true, uniqueValues: 1,
          }),
          col('always_true_flag', 'Bool', ColumnType.BASIC, ValueType.BOOLEAN, {
            hasValues: true, uniqueValues: 1,
          }),
          col('mixed_flag', 'Bool', ColumnType.BASIC, ValueType.BOOLEAN, {
            hasValues: true, uniqueValues: 2,
          }),
        ]),
      });
      const { cubes } = buildCubes(t);
      const names = [
        ...cubes[0].dimensions.map((d) => d.name),
        ...cubes[0].measures.map((m) => m.name),
      ];
      assert.ok(!names.includes('always_false_flag'), 'always-same bool should be skipped');
      assert.ok(!names.includes('always_true_flag'), 'always-same bool should be skipped');
      assert.ok(names.includes('mixed_flag'), 'genuinely-varying bool should be kept');
    });

    it('skips Int8/Bool basic columns by min===max (initial profile has no uniqueValues)', () => {
      // Reproduces the `customer_facing Int8 Min 0 Max 0 Avg 0` case: the
      // profiler's initial pass writes min/max/avg for BOOLEAN scalars but
      // doesn't compute uniqueValues — so the skip must be range-based too.
      const t = makeTable({
        columns: new Map([
          col('customer_facing', 'Int8', ColumnType.BASIC, ValueType.BOOLEAN, {
            hasValues: true, minValue: 0, maxValue: 0, avgValue: 0,
            // uniqueValues intentionally omitted — matches real profiler output
          }),
          col('always_one', 'Int8', ColumnType.BASIC, ValueType.BOOLEAN, {
            hasValues: true, minValue: 1, maxValue: 1, avgValue: 1,
          }),
          col('actually_used', 'Int8', ColumnType.BASIC, ValueType.BOOLEAN, {
            hasValues: true, minValue: 0, maxValue: 1, avgValue: 0.3,
          }),
        ]),
      });
      const { cubes } = buildCubes(t);
      const names = [
        ...cubes[0].dimensions.map((d) => d.name),
        ...cubes[0].measures.map((m) => m.name),
      ];
      assert.ok(!names.includes('customer_facing'), 'all-zero Int8 should be skipped via min===max');
      assert.ok(!names.includes('always_one'), 'all-one Int8 should be skipped via min===max');
      assert.ok(names.includes('actually_used'), 'mixed Int8 should be kept');
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

      // Resolver shortens unique keys → expanded keys land as their leaf
      // names. Plus the native `big_map_map` accessor.
      // source_column is trimmed from serialized meta (§4); the builder keeps
      // the origin on the transient `_sourceColumn` (present on in-memory cubes).
      const allMapFields = cubes[0].dimensions.filter(
        (d) => d._sourceColumn === 'big_map'
      );
      assert.strictEqual(allMapFields.length, 4); // 3 expanded + big_map_map
      assert.ok(dimNames.includes('big_map_map'));
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
      const allMapFields = cubes[0].dimensions.filter(
        (d) => d._sourceColumn === 'small_map'
      );
      assert.strictEqual(allMapFields.length, 4); // 3 expanded + small_map_map
      assert.ok(dimNames.includes('small_map_map'));
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

    it('should use the cubeName override when provided', () => {
      const { cubes } = buildCubes(table, { cubeName: 'stockout_ended' });
      assert.strictEqual(cubes[0].name, 'stockout_ended');
    });
  });
});

describe('cubeBuilder – shortest-unique field naming', () => {
  function nestedCol(parent, child, valueType = ValueType.STRING) {
    const name = `${parent}.${child}`;
    return [name, {
      name,
      rawType: valueType === ValueType.NUMBER ? 'Float64' : 'String',
      columnType: ColumnType.GROUPED,
      valueType,
      parentName: parent,
      childName: child,
      isNullable: false,
      profile: { hasValues: true, uniqueValues: 5 },
    }];
  }

  it('drops parent prefix from nested fields when the leaf is unique', () => {
    const t = {
      database: 'db',
      table: 'events',
      partition: null,
      columns: new Map([
        nestedCol('location', 'lat', ValueType.NUMBER),
        nestedCol('location', 'lng', ValueType.NUMBER),
      ]),
    };
    const { cubes } = buildCubes(t);
    const all = [
      ...cubes[0].dimensions.map((d) => d.name),
      ...cubes[0].measures.map((m) => m.name),
    ];
    assert.ok(all.includes('lat'), `expected 'lat'. Got: ${JSON.stringify(all)}`);
    assert.ok(all.includes('lng'));
  });

  it('keeps parent prefix on nested field when leaf clashes with a basic column', () => {
    // `score` (basic NUMBER, doesn't match the coordinate regex) → measure.
    // `metrics.score` (nested NUMBER) → also a measure. Same leaf → resolver
    // forces the nested one to advance to `metrics_score`.
    const t = {
      database: 'db',
      table: 'events',
      partition: null,
      columns: new Map([
        ['score', {
          name: 'score', rawType: 'Float64', columnType: ColumnType.BASIC, valueType: ValueType.NUMBER,
          isNullable: false,
          profile: { hasValues: true, minValue: 1, maxValue: 100, avgValue: 50 },
        }],
        nestedCol('metrics', 'score', ValueType.NUMBER),
      ]),
    };
    const { cubes } = buildCubes(t);
    const measureNames = cubes[0].measures.map((m) => m.name);
    assert.ok(measureNames.includes('score'), `top-level score keeps the bare name. Got: ${JSON.stringify(measureNames)}`);
    assert.ok(measureNames.includes('metrics_score'), `nested score falls back to metrics_score. Got: ${JSON.stringify(measureNames)}`);
  });

  it('falls back through deeper levels when multiple nested fields share a leaf and a parent', () => {
    const t = {
      database: 'db',
      table: 'events',
      partition: null,
      columns: new Map([
        nestedCol('commerce.products', 'id', ValueType.STRING),
        nestedCol('commerce.shipping.products', 'id', ValueType.STRING),
      ]),
    };
    const { cubes } = buildCubes(t);
    const dimNames = cubes[0].dimensions.map((d) => d.name);
    assert.ok(
      dimNames.includes('commerce_products_id') || dimNames.includes('shipping_products_id'),
      `expected qualified names. Got: ${JSON.stringify(dimNames)}`
    );
    // Both must be unique
    assert.strictEqual(new Set(dimNames).size, dimNames.length, 'all dim names must be unique');
  });

  it('rebinds FILTER_PARAMS refs when a lookup-key dimension is shortened', () => {
    // Build a synthetic nested group with a `_type` lookup key + one data sibling.
    const t = {
      database: 'db',
      table: 'events',
      partition: null,
      columns: new Map([
        ['commerce.products.entry_type', {
          name: 'commerce.products.entry_type',
          rawType: 'Array(String)',
          columnType: ColumnType.GROUPED,
          valueType: ValueType.STRING,
          parentName: 'commerce.products',
          childName: 'entry_type',
          isNullable: false,
          profile: {
            hasValues: true, uniqueValues: 3,
            lcValues: ['Line Item', 'Cart Item', 'Order'],
          },
        }],
        ['commerce.products.value', {
          name: 'commerce.products.value',
          rawType: 'Array(String)',
          columnType: ColumnType.GROUPED,
          valueType: ValueType.STRING,
          parentName: 'commerce.products',
          childName: 'value',
          isNullable: false,
          profile: { hasValues: true, uniqueValues: 50 },
        }],
      ]),
    };
    const { cubes } = buildCubes(t);
    const dimNames = cubes[0].dimensions.map((d) => d.name);
    // Lookup-key dim should land on `type` (no clash for that name)
    assert.ok(dimNames.includes('type'), `expected resolved 'type'. Got: ${JSON.stringify(dimNames)}`);
    // Every FILTER_PARAMS ref in any dim sql must point at `type`, not the old name
    for (const d of cubes[0].dimensions) {
      if (typeof d.sql === 'string' && d.sql.includes('FILTER_PARAMS')) {
        assert.ok(
          d.sql.includes(`FILTER_PARAMS.${cubes[0].name}.type.`),
          `FILTER_PARAMS ref should point at resolved 'type' dim. SQL: ${d.sql}`
        );
        assert.ok(
          !d.sql.includes('commerce_products_type'),
          `Old qualified ref must be rewritten. SQL: ${d.sql}`
        );
      }
    }
  });
});

describe('cubeBuilder – deriveCubeNameFromFlatFilters', () => {
  it('returns empty for no filters', () => {
    assert.strictEqual(deriveCubeNameFromFlatFilters([]), '');
    assert.strictEqual(deriveCubeNameFromFlatFilters(null), '');
  });

  it('builds an identifier from a single equality filter value', () => {
    const name = deriveCubeNameFromFlatFilters([
      { column: 'event', operator: '=', value: 'Stockout Ended' },
    ]);
    assert.strictEqual(name, 'stockout_ended');
  });

  it('joins multiple filter values with underscores', () => {
    const name = deriveCubeNameFromFlatFilters([
      { column: 'event', operator: '=', value: 'Stockout Ended' },
      { column: 'store_id', operator: '=', value: 42 },
    ]);
    assert.strictEqual(name, 'stockout_ended_42');
  });

  it('expands IN values', () => {
    const name = deriveCubeNameFromFlatFilters([
      { column: 'event', operator: 'IN', value: ['Order Placed', 'Order Shipped'] },
    ]);
    assert.strictEqual(name, 'order_placed_order_shipped');
  });

  it('ignores non-equality operators', () => {
    assert.strictEqual(
      deriveCubeNameFromFlatFilters([{ column: 'event', operator: '!=', value: 'X' }]),
      ''
    );
    assert.strictEqual(
      deriveCubeNameFromFlatFilters([{ column: 'event', operator: 'LIKE', value: '%foo%' }]),
      ''
    );
    assert.strictEqual(
      deriveCubeNameFromFlatFilters([{ column: 'event', operator: 'IS NULL', value: null }]),
      ''
    );
  });

  it('prefixes purely numeric names so they are valid identifiers', () => {
    const name = deriveCubeNameFromFlatFilters([
      { column: 'store_id', operator: '=', value: 42 },
    ]);
    assert.ok(!/^\d/.test(name));
    assert.strictEqual(name, 'cube_42');
  });

  it('caps absurdly long names', () => {
    const longValue = 'x'.repeat(200);
    const name = deriveCubeNameFromFlatFilters([
      { column: 'event', operator: '=', value: longValue },
    ]);
    assert.ok(name.length <= 60);
  });
});
