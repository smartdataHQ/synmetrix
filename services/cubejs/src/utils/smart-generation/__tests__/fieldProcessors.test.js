import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeFieldName,
  BasicFieldProcessor,
  MapFieldProcessor,
  NestedFieldProcessor,
  ArrayFieldProcessor,
  FieldProcessorFactory,
  processColumn,
} from '../fieldProcessors.js';

// Re-export NestedFieldProcessor for coordinate tests
const NestedFieldProcessorClass = NestedFieldProcessor;

import { ColumnType, ValueType } from '../typeParser.js';

// ---------------------------------------------------------------------------
// sanitizeFieldName
// ---------------------------------------------------------------------------

describe('sanitizeFieldName', () => {
  it('passes through simple alphanumeric names', () => {
    assert.equal(sanitizeFieldName('user_id'), 'user_id');
  });

  it('replaces special characters with underscores', () => {
    assert.equal(sanitizeFieldName('my-field.name'), 'my_field_name');
  });

  it('collapses consecutive underscores', () => {
    assert.equal(sanitizeFieldName('a___b'), 'a_b');
  });

  it('strips leading and trailing underscores', () => {
    assert.equal(sanitizeFieldName('__foo__'), 'foo');
  });

  it('prefixes names starting with a digit', () => {
    assert.equal(sanitizeFieldName('3col'), 'field_3col');
  });

  it('handles a name that is entirely special characters', () => {
    assert.equal(sanitizeFieldName('---'), 'field');
  });

  it('handles empty string', () => {
    assert.equal(sanitizeFieldName(''), 'field');
  });
});

// ---------------------------------------------------------------------------
// BasicFieldProcessor
// ---------------------------------------------------------------------------

describe('BasicFieldProcessor', () => {
  const processor = new BasicFieldProcessor();

  it('string column -> dimension with type "string"', () => {
    const col = {
      name: 'city',
      rawType: 'String',
      columnType: ColumnType.BASIC,
      valueType: ValueType.STRING,
    };
    const result = processor.process(col, null);
    assert.deepEqual(result, {
      name: 'city',
      sql: '{CUBE}.city',
      type: 'string',
      fieldType: 'dimension',
    });
  });

  it('Int32 column -> measure with type "sum"', () => {
    const col = {
      name: 'amount',
      rawType: 'Int32',
      columnType: ColumnType.BASIC,
      valueType: ValueType.NUMBER,
    };
    const result = processor.process(col, null);
    assert.deepEqual(result, {
      name: 'amount',
      sql: '{CUBE}.amount',
      type: 'sum',
      fieldType: 'measure',
    });
  });

  it('Float64 column -> measure with type "sum"', () => {
    const col = {
      name: 'price',
      rawType: 'Float64',
      columnType: ColumnType.BASIC,
      valueType: ValueType.NUMBER,
    };
    const result = processor.process(col, null);
    assert.deepEqual(result, {
      name: 'price',
      sql: '{CUBE}.price',
      type: 'sum',
      fieldType: 'measure',
    });
  });

  it('Date column -> dimension with type "time"', () => {
    const col = {
      name: 'created_at',
      rawType: 'DateTime',
      columnType: ColumnType.BASIC,
      valueType: ValueType.DATE,
    };
    const result = processor.process(col, null);
    assert.deepEqual(result, {
      name: 'created_at',
      sql: '{CUBE}.created_at',
      type: 'time',
      fieldType: 'dimension',
    });
  });

  it('"timestamp" column -> dimension + min/max measures', () => {
    const col = {
      name: 'timestamp',
      rawType: 'DateTime',
      columnType: ColumnType.BASIC,
      valueType: ValueType.DATE,
    };
    const result = processor.process(col, null);
    assert.deepEqual(result, [
      { name: 'timestamp', sql: '{CUBE}.timestamp', type: 'time', fieldType: 'dimension' },
      { name: 'timestamp_min', sql: '{CUBE}.timestamp', type: 'min', fieldType: 'measure' },
      { name: 'timestamp_max', sql: '{CUBE}.timestamp', type: 'max', fieldType: 'measure' },
    ]);
  });

  it('UUID column -> dimension with type "string" and toString SQL', () => {
    const col = {
      name: 'id',
      rawType: 'UUID',
      columnType: ColumnType.BASIC,
      valueType: ValueType.UUID,
    };
    const result = processor.process(col, null);
    assert.deepEqual(result, {
      name: 'id',
      sql: 'toString({CUBE}.id)',
      type: 'string',
      fieldType: 'dimension',
    });
  });

  it('Int8 column -> dimension with type "boolean"', () => {
    const col = {
      name: 'is_active',
      rawType: 'Int8',
      columnType: ColumnType.BASIC,
      valueType: ValueType.BOOLEAN,
    };
    const result = processor.process(col, null);
    assert.deepEqual(result, {
      name: 'is_active',
      sql: '({CUBE}.is_active) = 1',
      type: 'boolean',
      fieldType: 'dimension',
    });
  });

  it('Nullable(Int8) -> dimension with type "boolean"', () => {
    const col = {
      name: 'flag',
      rawType: 'Nullable(Int8)',
      columnType: ColumnType.BASIC,
      valueType: ValueType.BOOLEAN,
    };
    const result = processor.process(col, null);
    assert.deepEqual(result, {
      name: 'flag',
      sql: '({CUBE}.flag) = 1',
      type: 'boolean',
      fieldType: 'dimension',
    });
  });

  it('Int8 with values beyond 0/1 -> reclassified as number measure', () => {
    const col = {
      name: 'importance',
      rawType: 'Nullable(Int8)',
      columnType: ColumnType.BASIC,
      valueType: ValueType.BOOLEAN,
    };
    const profile = {
      hasValues: true,
      minValue: 1,
      maxValue: 5,
      lcValues: [1, 2, 3, 4, 5],
    };
    const result = processor.process(col, profile);
    assert.equal(result.type, 'sum', 'should be numeric measure');
    assert.equal(result.fieldType, 'measure');
    assert.equal(result.sql, '{CUBE}.importance', 'should NOT use = 1 comparison');
  });

  it('Int8 with only 0/1 values stays boolean', () => {
    const col = {
      name: 'is_active',
      rawType: 'Int8',
      columnType: ColumnType.BASIC,
      valueType: ValueType.BOOLEAN,
    };
    const profile = {
      hasValues: true,
      minValue: 0,
      maxValue: 1,
      lcValues: [0, 1],
    };
    const result = processor.process(col, profile);
    assert.equal(result.type, 'boolean');
    assert.equal(result.fieldType, 'dimension');
    assert.equal(result.sql, '({CUBE}.is_active) = 1');
  });
});

// ---------------------------------------------------------------------------
// Coordinate detection
// ---------------------------------------------------------------------------

describe('Coordinate column detection', () => {
  const processor = new BasicFieldProcessor();

  it('latitude -> number dimension, not sum measure', () => {
    const col = {
      name: 'latitude',
      rawType: 'Float64',
      columnType: ColumnType.BASIC,
      valueType: ValueType.NUMBER,
    };
    const result = processor.process(col, null);
    assert.equal(result.fieldType, 'dimension');
    assert.equal(result.type, 'number');
  });

  it('longitude -> number dimension, not sum measure', () => {
    const col = {
      name: 'longitude',
      rawType: 'Float64',
      columnType: ColumnType.BASIC,
      valueType: ValueType.NUMBER,
    };
    const result = processor.process(col, null);
    assert.equal(result.fieldType, 'dimension');
    assert.equal(result.type, 'number');
  });

  it('nested location.latitude -> number dimension', () => {
    const nestedProcessor = new NestedFieldProcessor();
    const col = {
      name: 'location.latitude',
      rawType: 'Float64',
      columnType: ColumnType.GROUPED,
      valueType: ValueType.NUMBER,
      parentName: 'location',
      childName: 'latitude',
    };
    const result = nestedProcessor.process(col, null);
    assert.equal(result.fieldType, 'dimension');
    assert.equal(result.type, 'number');
    assert.equal(result.name, 'location_latitude');
  });
});

// ---------------------------------------------------------------------------
// MapFieldProcessor
// ---------------------------------------------------------------------------

describe('MapFieldProcessor', () => {
  const processor = new MapFieldProcessor();

  it('returns empty array when profile is null', () => {
    const col = {
      name: 'props',
      rawType: 'Map(String, String)',
      columnType: ColumnType.MAP,
      valueType: ValueType.OTHER,
    };
    assert.deepEqual(processor.process(col, null), []);
  });

  it('returns empty array when profile has no uniqueKeys', () => {
    const col = {
      name: 'props',
      rawType: 'Map(String, String)',
      columnType: ColumnType.MAP,
      valueType: ValueType.OTHER,
    };
    assert.deepEqual(processor.process(col, { uniqueKeys: [] }), []);
  });

  it('string value map -> string dimensions per key', () => {
    // valueType is OTHER for Map columns; valueDataType holds the actual type
    const col = {
      name: 'tags',
      rawType: 'Map(String, String)',
      columnType: ColumnType.MAP,
      valueType: ValueType.OTHER,
      valueDataType: ValueType.STRING,
    };
    const profile = { uniqueKeys: ['color', 'size'] };
    const result = processor.process(col, profile);

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      name: 'tags_color',
      sql: "{CUBE}.tags['color']",
      type: 'string',
      fieldType: 'dimension',
      _mapKey: 'color',
    });
    assert.deepEqual(result[1], {
      name: 'tags_size',
      sql: "{CUBE}.tags['size']",
      type: 'string',
      fieldType: 'dimension',
      _mapKey: 'size',
    });
  });

  it('numeric value map (Float64) -> measures with CAST and sum', () => {
    const col = {
      name: 'metrics',
      rawType: 'Map(String, Float64)',
      columnType: ColumnType.MAP,
      valueType: ValueType.OTHER,
      valueDataType: ValueType.NUMBER,
    };
    const profile = { uniqueKeys: ['latency'] };
    const result = processor.process(col, profile);

    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      name: 'metrics_latency',
      sql: "CAST({CUBE}.metrics['latency'] AS Float64)",
      type: 'sum',
      fieldType: 'measure',
      _mapKey: 'latency',
    });
  });

  it('numeric value map with LowCardinality wrappers -> measures (real-world)', () => {
    // Map(LowCardinality(String), Float32) — as seen in real ClickHouse tables
    const col = {
      name: 'metrics',
      rawType: 'Map(LowCardinality(String), Float32)',
      columnType: ColumnType.MAP,
      valueType: ValueType.OTHER,
      valueDataType: ValueType.NUMBER,
    };
    const profile = { uniqueKeys: ['total_trips', 'avg_speed_kmh'] };
    const result = processor.process(col, profile);

    assert.equal(result.length, 2);
    assert.equal(result[0].fieldType, 'measure');
    assert.equal(result[0].type, 'sum');
    assert.ok(result[0].sql.includes('CAST'));
    assert.equal(result[1].fieldType, 'measure');
  });

  it('numeric value map (UInt32) -> CAST to UInt64', () => {
    const col = {
      name: 'counts',
      rawType: 'Map(String, UInt32)',
      columnType: ColumnType.MAP,
      valueType: ValueType.OTHER,
      valueDataType: ValueType.NUMBER,
    };
    const profile = { uniqueKeys: ['hits'] };
    const result = processor.process(col, profile);

    assert.equal(result[0].sql, "CAST({CUBE}.counts['hits'] AS UInt64)");
  });

  it('numeric value map (Int32) -> CAST to Int64', () => {
    const col = {
      name: 'deltas',
      rawType: 'Map(String, Int32)',
      columnType: ColumnType.MAP,
      valueType: ValueType.OTHER,
      valueDataType: ValueType.NUMBER,
    };
    const profile = { uniqueKeys: ['diff'] };
    const result = processor.process(col, profile);

    assert.equal(result[0].sql, "CAST({CUBE}.deltas['diff'] AS Int64)");
  });

  it('numeric value map with Int8 value subtype -> boolean dimension', () => {
    const col = {
      name: 'flags',
      rawType: 'Map(String, Int8)',
      columnType: ColumnType.MAP,
      valueType: ValueType.OTHER,
      valueDataType: ValueType.NUMBER,
    };
    const profile = { uniqueKeys: ['enabled'] };
    const result = processor.process(col, profile);

    assert.deepEqual(result[0], {
      name: 'flags_enabled',
      sql: "({CUBE}.flags['enabled']) = 1",
      type: 'boolean',
      fieldType: 'dimension',
      _mapKey: 'enabled',
    });
  });

  it('boolean value map -> boolean dimensions', () => {
    // Map(LowCardinality(String), Bool) — as seen in real ClickHouse tables
    const col = {
      name: 'settings',
      rawType: 'Map(LowCardinality(String), Bool)',
      columnType: ColumnType.MAP,
      valueType: ValueType.OTHER,
      valueDataType: ValueType.BOOLEAN,
    };
    const profile = { uniqueKeys: ['dark_mode'] };
    const result = processor.process(col, profile);

    assert.deepEqual(result[0], {
      name: 'settings_dark_mode',
      sql: "{CUBE}.settings['dark_mode']",
      type: 'boolean',
      fieldType: 'dimension',
      _mapKey: 'dark_mode',
    });
  });

  it('sanitizes special characters in map keys', () => {
    const col = {
      name: 'data',
      rawType: 'Map(String, String)',
      columnType: ColumnType.MAP,
      valueType: ValueType.STRING,
    };
    const profile = { uniqueKeys: ['my-key.v2'] };
    const result = processor.process(col, profile);

    assert.equal(result[0].name, 'data_my_key_v2');
    // SQL still uses the original key name for ClickHouse access
    assert.equal(result[0].sql, "{CUBE}.data['my-key.v2']");
  });
});

// ---------------------------------------------------------------------------
// NestedFieldProcessor
// ---------------------------------------------------------------------------

describe('NestedFieldProcessor', () => {
  const processor = new NestedFieldProcessor();

  it('creates prefixed field name from parent and child', () => {
    const col = {
      name: 'parent.child',
      rawType: 'String',
      columnType: ColumnType.GROUPED,
      valueType: ValueType.STRING,
      parentName: 'parent',
      childName: 'child',
    };
    const result = processor.process(col, null);
    assert.equal(result.name, 'parent_child');
    assert.equal(result.fieldType, 'dimension');
    assert.equal(result.type, 'string');
  });

  it('uses childName when no parentName', () => {
    const col = {
      name: 'solo',
      rawType: 'String',
      columnType: ColumnType.GROUPED,
      valueType: ValueType.STRING,
      parentName: '',
      childName: 'solo',
    };
    const result = processor.process(col, null);
    assert.equal(result.name, 'solo');
  });

  it('handles numeric nested column as measure', () => {
    const col = {
      name: 'stats.count',
      rawType: 'UInt64',
      columnType: ColumnType.GROUPED,
      valueType: ValueType.NUMBER,
      parentName: 'stats',
      childName: 'count',
    };
    const result = processor.process(col, null);
    assert.equal(result.name, 'stats_count');
    assert.equal(result.fieldType, 'measure');
    assert.equal(result.type, 'sum');
  });

  it('sanitizes parent and child names', () => {
    const col = {
      name: 'my-group.3field',
      rawType: 'String',
      columnType: ColumnType.GROUPED,
      valueType: ValueType.STRING,
      parentName: 'my-group',
      childName: '3field',
    };
    const result = processor.process(col, null);
    assert.equal(result.name, 'my_group_field_3field');
  });
});

// ---------------------------------------------------------------------------
// ArrayFieldProcessor
// ---------------------------------------------------------------------------

describe('ArrayFieldProcessor', () => {
  it('produces toString dimension for a regular array column', () => {
    const processor = new ArrayFieldProcessor();
    const col = {
      name: 'items',
      rawType: 'Array(String)',
      columnType: ColumnType.ARRAY,
      valueType: ValueType.STRING,
    };
    const result = processor.process(col, null);
    assert.deepEqual(result, {
      name: 'items',
      sql: 'toString(items)',
      type: 'string',
      fieldType: 'dimension',
    });
  });

  it('uses ARRAY JOIN alias when column is in arrayJoinColumns', () => {
    const processor = new ArrayFieldProcessor(['items']);
    const col = {
      name: 'items',
      rawType: 'Array(String)',
      columnType: ColumnType.ARRAY,
      valueType: ValueType.STRING,
    };
    const result = processor.process(col, null);
    assert.deepEqual(result, {
      name: 'items_item',
      sql: 'items_item',
      type: 'string',
      fieldType: 'dimension',
    });
  });

  it('generates dotted ARRAY JOIN alias for nested column', () => {
    const processor = new ArrayFieldProcessor(['parent.child']);
    const col = {
      name: 'parent.child',
      rawType: 'Array(String)',
      columnType: ColumnType.ARRAY,
      valueType: ValueType.STRING,
    };
    const result = processor.process(col, null);
    assert.equal(result.name, 'parent_child_item');
  });

  it('shouldUseArrayJoin matches prefix when configured without dot', () => {
    const processor = new ArrayFieldProcessor(['events']);
    assert.equal(processor.shouldUseArrayJoin('events'), true);
    assert.equal(processor.shouldUseArrayJoin('events.type'), true);
    assert.equal(processor.shouldUseArrayJoin('other'), false);
  });
});

// ---------------------------------------------------------------------------
// FieldProcessorFactory
// ---------------------------------------------------------------------------

describe('FieldProcessorFactory', () => {
  it('returns BasicFieldProcessor for BASIC type', () => {
    const p = FieldProcessorFactory(ColumnType.BASIC);
    assert.ok(p instanceof BasicFieldProcessor);
  });

  it('returns MapFieldProcessor for MAP type', () => {
    const p = FieldProcessorFactory(ColumnType.MAP);
    assert.ok(p instanceof MapFieldProcessor);
  });

  it('returns ArrayFieldProcessor for ARRAY type', () => {
    const p = FieldProcessorFactory(ColumnType.ARRAY);
    assert.ok(p instanceof ArrayFieldProcessor);
  });

  it('returns NestedFieldProcessor for NESTED type', () => {
    const p = FieldProcessorFactory(ColumnType.NESTED);
    assert.ok(p instanceof NestedFieldProcessor);
  });

  it('returns NestedFieldProcessor for GROUPED type', () => {
    const p = FieldProcessorFactory(ColumnType.GROUPED);
    assert.ok(p instanceof NestedFieldProcessor);
  });

  it('defaults to BasicFieldProcessor for unknown type', () => {
    const p = FieldProcessorFactory('UNKNOWN');
    assert.ok(p instanceof BasicFieldProcessor);
  });
});

// ---------------------------------------------------------------------------
// processColumn (integration)
// ---------------------------------------------------------------------------

describe('processColumn', () => {
  it('returns an array with one field for basic columns', () => {
    const col = {
      name: 'status',
      rawType: 'String',
      columnType: ColumnType.BASIC,
      valueType: ValueType.STRING,
    };
    const result = processColumn(col, null);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'status');
    assert.equal(result[0].fieldType, 'dimension');
  });

  it('returns multiple fields for map columns with keys', () => {
    const col = {
      name: 'attrs',
      rawType: 'Map(String, String)',
      columnType: ColumnType.MAP,
      valueType: ValueType.STRING,
    };
    const profile = { uniqueKeys: ['a', 'b', 'c'] };
    const result = processColumn(col, profile);
    assert.equal(result.length, 3);
  });

  it('returns empty array for map column with no profile', () => {
    const col = {
      name: 'attrs',
      rawType: 'Map(String, String)',
      columnType: ColumnType.MAP,
      valueType: ValueType.STRING,
    };
    const result = processColumn(col, null);
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// Name collision / deduplication
// ---------------------------------------------------------------------------

describe('name deduplication via sanitizeFieldName', () => {
  it('different raw names can collide after sanitization', () => {
    const a = sanitizeFieldName('my-field');
    const b = sanitizeFieldName('my.field');
    assert.equal(a, b, 'both should sanitize to "my_field"');
    assert.equal(a, 'my_field');
  });

  it('consumers can disambiguate by appending a suffix', () => {
    const names = new Set();
    const rawNames = ['my-field', 'my.field', 'my_field'];
    for (const raw of rawNames) {
      let candidate = sanitizeFieldName(raw);
      let counter = 1;
      while (names.has(candidate)) {
        candidate = `${sanitizeFieldName(raw)}_${counter++}`;
      }
      names.add(candidate);
    }
    assert.equal(names.size, 3);
    assert.ok(names.has('my_field'));
    assert.ok(names.has('my_field_1'));
    assert.ok(names.has('my_field_2'));
  });
});
