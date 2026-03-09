import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ColumnType,
  ValueType,
  resolveValueType,
  parseType,
} from '../typeParser.js';

// ---------------------------------------------------------------------------
// resolveValueType
// ---------------------------------------------------------------------------

describe('resolveValueType', () => {
  it('returns STRING for String', () => {
    assert.equal(resolveValueType('String'), ValueType.STRING);
  });

  it('returns STRING for FixedString(16)', () => {
    assert.equal(resolveValueType('FixedString(16)'), ValueType.STRING);
  });

  it('returns STRING for Enum8 / Enum16 / Enum', () => {
    assert.equal(resolveValueType('Enum8(\'a\' = 1)'), ValueType.STRING);
    assert.equal(resolveValueType('Enum16(\'b\' = 2)'), ValueType.STRING);
    assert.equal(resolveValueType('Enum'), ValueType.STRING);
  });

  it('returns STRING for IPv4 / IPv6', () => {
    assert.equal(resolveValueType('IPv4'), ValueType.STRING);
    assert.equal(resolveValueType('IPv6'), ValueType.STRING);
  });

  it('returns NUMBER for Int32', () => {
    assert.equal(resolveValueType('Int32'), ValueType.NUMBER);
  });

  it('returns NUMBER for UInt64', () => {
    assert.equal(resolveValueType('UInt64'), ValueType.NUMBER);
  });

  it('returns NUMBER for Int128 / Int256', () => {
    assert.equal(resolveValueType('Int128'), ValueType.NUMBER);
    assert.equal(resolveValueType('UInt256'), ValueType.NUMBER);
  });

  it('returns NUMBER for Float32 / Float64', () => {
    assert.equal(resolveValueType('Float32'), ValueType.NUMBER);
    assert.equal(resolveValueType('Float64'), ValueType.NUMBER);
  });

  it('returns NUMBER for Decimal types', () => {
    assert.equal(resolveValueType('Decimal(10,2)'), ValueType.NUMBER);
    assert.equal(resolveValueType('Decimal128(4)'), ValueType.NUMBER);
  });

  it('returns DATE for Date / Date32', () => {
    assert.equal(resolveValueType('Date'), ValueType.DATE);
    assert.equal(resolveValueType('Date32'), ValueType.DATE);
  });

  it('returns DATE for DateTime / DateTime64', () => {
    assert.equal(resolveValueType('DateTime'), ValueType.DATE);
    assert.equal(resolveValueType('DateTime64(3)'), ValueType.DATE);
    assert.equal(resolveValueType("DateTime('UTC')"), ValueType.DATE);
  });

  it('returns UUID for UUID', () => {
    assert.equal(resolveValueType('UUID'), ValueType.UUID);
  });

  it('returns BOOLEAN for Bool', () => {
    assert.equal(resolveValueType('Bool'), ValueType.BOOLEAN);
  });

  it('returns BOOLEAN for Int8 (ClickHouse boolean convention)', () => {
    assert.equal(resolveValueType('Int8'), ValueType.BOOLEAN);
  });

  it('returns OTHER for unknown types', () => {
    assert.equal(resolveValueType('AggregateFunction(sum, Int64)'), ValueType.OTHER);
    assert.equal(resolveValueType('Tuple(String, Int32)'), ValueType.OTHER);
  });

  it('returns OTHER for null / undefined / empty', () => {
    assert.equal(resolveValueType(null), ValueType.OTHER);
    assert.equal(resolveValueType(undefined), ValueType.OTHER);
    assert.equal(resolveValueType(''), ValueType.OTHER);
  });
});

// ---------------------------------------------------------------------------
// parseType — basic / scalar types
// ---------------------------------------------------------------------------

describe('parseType — basic types', () => {
  it('parses String', () => {
    const r = parseType('String', 'name');
    assert.equal(r.columnType, ColumnType.BASIC);
    assert.equal(r.valueType, ValueType.STRING);
    assert.equal(r.isNullable, false);
    assert.equal(r.innerType, 'String');
  });

  it('parses Int32', () => {
    const r = parseType('Int32', 'age');
    assert.equal(r.columnType, ColumnType.BASIC);
    assert.equal(r.valueType, ValueType.NUMBER);
  });

  it('parses UInt64', () => {
    const r = parseType('UInt64', 'count');
    assert.equal(r.valueType, ValueType.NUMBER);
  });

  it('parses Float64', () => {
    const r = parseType('Float64', 'price');
    assert.equal(r.valueType, ValueType.NUMBER);
  });

  it('parses Date', () => {
    const r = parseType('Date', 'created');
    assert.equal(r.valueType, ValueType.DATE);
  });

  it('parses DateTime', () => {
    const r = parseType('DateTime', 'updated_at');
    assert.equal(r.valueType, ValueType.DATE);
  });

  it('parses UUID', () => {
    const r = parseType('UUID', 'id');
    assert.equal(r.valueType, ValueType.UUID);
  });

  it('parses Bool', () => {
    const r = parseType('Bool', 'active');
    assert.equal(r.valueType, ValueType.BOOLEAN);
  });

  it('preserves rawType', () => {
    const r = parseType('DateTime64(3)', 'ts');
    assert.equal(r.rawType, 'DateTime64(3)');
  });
});

// ---------------------------------------------------------------------------
// parseType — LowCardinality wrapping
// ---------------------------------------------------------------------------

describe('parseType — LowCardinality', () => {
  it('peels LowCardinality(String) to String', () => {
    const r = parseType('LowCardinality(String)', 'status');
    assert.equal(r.columnType, ColumnType.BASIC);
    assert.equal(r.valueType, ValueType.STRING);
    assert.equal(r.isNullable, false);
    assert.equal(r.innerType, 'String');
  });

  it('peels LowCardinality(FixedString(2)) to FixedString(2)', () => {
    const r = parseType('LowCardinality(FixedString(2))', 'cc');
    assert.equal(r.valueType, ValueType.STRING);
    assert.equal(r.innerType, 'FixedString(2)');
  });
});

// ---------------------------------------------------------------------------
// parseType — Nullable wrapping
// ---------------------------------------------------------------------------

describe('parseType — Nullable', () => {
  it('peels Nullable(Int32) and sets isNullable', () => {
    const r = parseType('Nullable(Int32)', 'age');
    assert.equal(r.columnType, ColumnType.BASIC);
    assert.equal(r.valueType, ValueType.NUMBER);
    assert.equal(r.isNullable, true);
    assert.equal(r.innerType, 'Int32');
  });

  it('peels Nullable(String)', () => {
    const r = parseType('Nullable(String)', 'label');
    assert.equal(r.valueType, ValueType.STRING);
    assert.equal(r.isNullable, true);
  });
});

// ---------------------------------------------------------------------------
// parseType — nested wrapper combinations
// ---------------------------------------------------------------------------

describe('parseType — nested wrapper combinations', () => {
  it('peels LowCardinality(Nullable(String))', () => {
    const r = parseType('LowCardinality(Nullable(String))', 'tag');
    assert.equal(r.columnType, ColumnType.BASIC);
    assert.equal(r.valueType, ValueType.STRING);
    assert.equal(r.isNullable, true);
    assert.equal(r.innerType, 'String');
  });

  it('peels Nullable(LowCardinality(String)) — reverse order', () => {
    // ClickHouse normalizes to LowCardinality(Nullable(...)) but
    // the parser should handle either order gracefully.
    const r = parseType('Nullable(LowCardinality(String))', 'tag2');
    assert.equal(r.valueType, ValueType.STRING);
    assert.equal(r.isNullable, true);
    assert.equal(r.innerType, 'String');
  });
});

// ---------------------------------------------------------------------------
// parseType — Map type
// ---------------------------------------------------------------------------

describe('parseType — Map', () => {
  it('parses Map(String, Float64)', () => {
    const r = parseType('Map(String, Float64)', 'props');
    assert.equal(r.columnType, ColumnType.MAP);
    assert.equal(r.valueType, ValueType.OTHER);
    assert.equal(r.keyDataType, ValueType.STRING);
    assert.equal(r.valueDataType, ValueType.NUMBER);
    assert.equal(r.isNullable, false);
  });

  it('parses Map(String, String)', () => {
    const r = parseType('Map(String, String)', 'labels');
    assert.equal(r.columnType, ColumnType.MAP);
    assert.equal(r.keyDataType, ValueType.STRING);
    assert.equal(r.valueDataType, ValueType.STRING);
  });

  it('parses Map with wrapped inner types', () => {
    const r = parseType('Map(LowCardinality(String), Nullable(Float64))', 'metrics');
    assert.equal(r.columnType, ColumnType.MAP);
    assert.equal(r.keyDataType, ValueType.STRING);
    assert.equal(r.valueDataType, ValueType.NUMBER);
  });

  it('sets innerType to the full Map(...) expression', () => {
    const r = parseType('Map(String, Int32)', 'counts');
    assert.equal(r.innerType, 'Map(String, Int32)');
  });

  it('handles Nullable(Map(String, String))', () => {
    const r = parseType('Nullable(Map(String, String))', 'tags');
    assert.equal(r.columnType, ColumnType.MAP);
    assert.equal(r.isNullable, true);
    assert.equal(r.keyDataType, ValueType.STRING);
    assert.equal(r.valueDataType, ValueType.STRING);
  });
});

// ---------------------------------------------------------------------------
// parseType — Array type
// ---------------------------------------------------------------------------

describe('parseType — Array', () => {
  it('parses Array(String)', () => {
    const r = parseType('Array(String)', 'tags');
    assert.equal(r.columnType, ColumnType.ARRAY);
    assert.equal(r.valueType, ValueType.STRING);
    assert.equal(r.innerType, 'String');
  });

  it('parses Array(UInt32)', () => {
    const r = parseType('Array(UInt32)', 'ids');
    assert.equal(r.columnType, ColumnType.ARRAY);
    assert.equal(r.valueType, ValueType.NUMBER);
    assert.equal(r.innerType, 'UInt32');
  });

  it('parses Array(Nullable(Float64)) — peels inner wrappers', () => {
    const r = parseType('Array(Nullable(Float64))', 'values');
    assert.equal(r.columnType, ColumnType.ARRAY);
    assert.equal(r.valueType, ValueType.NUMBER);
    assert.equal(r.innerType, 'Float64');
  });

  it('parses Array(LowCardinality(String))', () => {
    const r = parseType('Array(LowCardinality(String))', 'labels');
    assert.equal(r.columnType, ColumnType.ARRAY);
    assert.equal(r.valueType, ValueType.STRING);
    assert.equal(r.innerType, 'String');
  });
});

// ---------------------------------------------------------------------------
// parseType — Nested type
// ---------------------------------------------------------------------------

describe('parseType — Nested', () => {
  it('parses Nested(...) as NESTED column type', () => {
    const r = parseType('Nested(name String, value Float64)', 'attrs');
    assert.equal(r.columnType, ColumnType.NESTED);
    assert.equal(r.valueType, ValueType.OTHER);
    assert.equal(r.innerType, 'name String, value Float64');
  });
});

// ---------------------------------------------------------------------------
// parseType — Grouped (dotted column names)
// ---------------------------------------------------------------------------

describe('parseType — grouped / dotted column names', () => {
  it('detects dotted column as GROUPED', () => {
    const r = parseType('Array(String)', 'attrs.name');
    assert.equal(r.columnType, ColumnType.GROUPED);
    assert.equal(r.parentName, 'attrs');
    assert.equal(r.childName, 'name');
  });

  it('resolves value type through Array for grouped column', () => {
    const r = parseType('Array(UInt64)', 'metrics.ids');
    assert.equal(r.columnType, ColumnType.GROUPED);
    assert.equal(r.valueType, ValueType.NUMBER);
    assert.equal(r.parentName, 'metrics');
    assert.equal(r.childName, 'ids');
  });

  it('preserves GROUPED over MAP for dotted column with Map type', () => {
    const r = parseType('Map(String, String)', 'config.values');
    assert.equal(r.columnType, ColumnType.GROUPED);
    assert.equal(r.parentName, 'config');
    assert.equal(r.childName, 'values');
    assert.equal(r.keyDataType, ValueType.STRING);
    assert.equal(r.valueDataType, ValueType.STRING);
  });

  it('handles deeply dotted names (only first dot splits)', () => {
    const r = parseType('String', 'a.b.c');
    assert.equal(r.columnType, ColumnType.GROUPED);
    assert.equal(r.parentName, 'a');
    assert.equal(r.childName, 'b.c');
  });
});

// ---------------------------------------------------------------------------
// parseType — null defaults
// ---------------------------------------------------------------------------

describe('parseType — default null fields', () => {
  it('has null keyDataType / valueDataType for non-Map types', () => {
    const r = parseType('String', 'col');
    assert.equal(r.keyDataType, null);
    assert.equal(r.valueDataType, null);
  });

  it('has null parentName / childName for non-dotted columns', () => {
    const r = parseType('Int32', 'col');
    assert.equal(r.parentName, null);
    assert.equal(r.childName, null);
  });
});

// ---------------------------------------------------------------------------
// ColumnType / ValueType enum completeness
// ---------------------------------------------------------------------------

describe('ColumnType enum', () => {
  it('contains exactly five entries', () => {
    const keys = Object.keys(ColumnType);
    assert.equal(keys.length, 5);
    assert.deepEqual(keys.sort(), ['ARRAY', 'BASIC', 'GROUPED', 'MAP', 'NESTED']);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(ColumnType));
  });
});

describe('ValueType enum', () => {
  it('contains exactly six entries', () => {
    const keys = Object.keys(ValueType);
    assert.equal(keys.length, 6);
    assert.deepEqual(keys.sort(), ['BOOLEAN', 'DATE', 'NUMBER', 'OTHER', 'STRING', 'UUID']);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(ValueType));
  });
});
