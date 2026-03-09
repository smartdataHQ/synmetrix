import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

import { mergeModels, hasUserContent } from '../merger.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Auto-generated cube with provenance metadata. */
function autoCube(name, { dimensions = [], measures = [], extra = {} } = {}) {
  return {
    name,
    sql_table: `db.${name}`,
    meta: { auto_generated: true, source_database: 'ch', source_table: name },
    dimensions,
    measures,
    ...extra,
  };
}

/** A single auto-generated dimension. */
function autoDim(name, type = 'string', extra = {}) {
  return {
    name,
    sql: `{CUBE}.\`${name}\``,
    type,
    meta: { auto_generated: true },
    ...extra,
  };
}

/** A single auto-generated measure. */
function autoMeasure(name, type = 'count', extra = {}) {
  return {
    name,
    type,
    meta: { auto_generated: true },
    ...extra,
  };
}

/** A user-created dimension (no auto_generated flag). */
function userDim(name, type = 'string') {
  return { name, sql: `{CUBE}.\`${name}\``, type };
}

/** A user-created measure (no auto_generated flag). */
function userMeasure(name, type = 'count') {
  return { name, type };
}

function toYaml(doc) {
  return YAML.stringify(doc);
}

function fromYaml(str) {
  return YAML.parse(str);
}

// ---------------------------------------------------------------------------
// hasUserContent
// ---------------------------------------------------------------------------

describe('hasUserContent', () => {
  it('returns false for null / empty / non-string input', () => {
    assert.equal(hasUserContent(null), false);
    assert.equal(hasUserContent(''), false);
    assert.equal(hasUserContent(42), false);
  });

  it('returns true for malformed YAML (safest default)', () => {
    assert.equal(hasUserContent('cubes: [{ invalid:: yaml::'), true);
  });

  it('returns false for empty cubes array', () => {
    assert.equal(hasUserContent(toYaml({ cubes: [] })), false);
  });

  it('returns false for purely auto-generated cubes with no user content', () => {
    const doc = {
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), autoDim('status')],
          measures: [autoMeasure('count')],
        }),
      ],
    };
    assert.equal(hasUserContent(toYaml(doc)), false);
  });

  it('returns true when a cube is not auto_generated (standard / hand-written)', () => {
    const doc = {
      cubes: [{ name: 'orders', sql_table: 'orders', dimensions: [] }],
    };
    assert.equal(hasUserContent(toYaml(doc)), true);
  });

  it('returns true when a dimension lacks auto_generated meta', () => {
    const doc = {
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), userDim('custom_status')],
        }),
      ],
    };
    assert.equal(hasUserContent(toYaml(doc)), true);
  });

  it('returns true when an auto field has a description', () => {
    const doc = {
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id', 'string', { description: 'Primary key' })],
        }),
      ],
    };
    assert.equal(hasUserContent(toYaml(doc)), true);
  });

  it('returns true when cube has joins', () => {
    const doc = {
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          extra: {
            joins: [{ name: 'users', sql: '{CUBE}.user_id = {users}.id', relationship: 'many_to_one' }],
          },
        }),
      ],
    };
    assert.equal(hasUserContent(toYaml(doc)), true);
  });

  it('returns true when cube has pre_aggregations', () => {
    const doc = {
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          extra: {
            pre_aggregations: [{ name: 'main', type: 'rollup' }],
          },
        }),
      ],
    };
    assert.equal(hasUserContent(toYaml(doc)), true);
  });

  it('returns true when cube has segments', () => {
    const doc = {
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          extra: {
            segments: [{ name: 'active', sql: '{CUBE}.status = \'active\'' }],
          },
        }),
      ],
    };
    assert.equal(hasUserContent(toYaml(doc)), true);
  });
});

// ---------------------------------------------------------------------------
// Strategy: replace
// ---------------------------------------------------------------------------

describe('mergeModels — replace strategy', () => {
  it('returns new YAML as-is regardless of existing content', () => {
    const existing = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id'), userDim('custom')] })],
    });
    const newYaml = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });

    const result = mergeModels(existing, newYaml, 'replace');
    assert.equal(result, newYaml);
  });

  it('does not parse YAML at all for replace', () => {
    const existing = 'this is not valid yaml: {{{{';
    const newYaml = toYaml({ cubes: [autoCube('t')] });

    const result = mergeModels(existing, newYaml, 'replace');
    assert.equal(result, newYaml);
  });
});

// ---------------------------------------------------------------------------
// Strategy: merge
// ---------------------------------------------------------------------------

describe('mergeModels — merge strategy', () => {
  it('updates auto fields when column definition changes', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('amount', 'string')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('amount', 'number')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const dim = result.cubes[0].dimensions.find((d) => d.name === 'amount');
    assert.equal(dim.type, 'number');
  });

  it('adds new auto fields from new YAML', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), autoDim('status')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const names = result.cubes[0].dimensions.map((d) => d.name);
    assert.deepEqual(names, ['id', 'status']);
  });

  it('removes auto fields for dropped columns', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), autoDim('old_col')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const names = result.cubes[0].dimensions.map((d) => d.name);
    assert.deepEqual(names, ['id']);
  });

  it('preserves user-created fields unchanged', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), userDim('custom_field', 'number')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), autoDim('status')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const names = result.cubes[0].dimensions.map((d) => d.name);
    assert.ok(names.includes('custom_field'), 'user field preserved');
    assert.ok(names.includes('id'), 'auto field kept');
    assert.ok(names.includes('status'), 'new auto field added');
  });

  it('preserves user-edited descriptions on auto fields', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id', 'string', { description: 'My custom description' })],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id', 'string', { description: 'Auto description' })],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const dim = result.cubes[0].dimensions.find((d) => d.name === 'id');
    assert.equal(dim.description, 'My custom description');
  });

  it('does not override description when both match', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id', 'string', { description: 'Same' })],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id', 'string', { description: 'Same' })],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const dim = result.cubes[0].dimensions.find((d) => d.name === 'id');
    assert.equal(dim.description, 'Same');
  });

  it('preserves cube-level description', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          extra: { description: 'Orders from our store' },
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          extra: { description: 'Regenerated description' },
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    assert.equal(result.cubes[0].description, 'Orders from our store');
  });

  it('preserves joins block', () => {
    const joins = [
      { name: 'users', sql: '{CUBE}.user_id = {users}.id', relationship: 'many_to_one' },
    ];
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          extra: { joins },
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    assert.deepEqual(result.cubes[0].joins, joins);
  });

  it('preserves pre_aggregations block', () => {
    const preAggs = [{ name: 'main', type: 'rollup', dimensions: ['id'] }];
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          extra: { pre_aggregations: preAggs },
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    assert.deepEqual(result.cubes[0].pre_aggregations, preAggs);
  });

  it('preserves segments block', () => {
    const segments = [{ name: 'active', sql: "{CUBE}.status = 'active'" }];
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          extra: { segments },
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    assert.deepEqual(result.cubes[0].segments, segments);
  });

  it('preserves user-added meta keys on cube', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
        }),
      ],
    });
    // Inject a custom meta key
    const existingDoc = fromYaml(existing);
    existingDoc.cubes[0].meta.custom_tag = 'important';
    const existingWithMeta = toYaml(existingDoc);

    const newYaml = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });

    const result = fromYaml(mergeModels(existingWithMeta, newYaml, 'merge'));
    assert.equal(result.cubes[0].meta.custom_tag, 'important');
    assert.equal(result.cubes[0].meta.auto_generated, true);
  });

  it('preserves public flag from existing cube', () => {
    const existingDoc = {
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          extra: { public: false },
        }),
      ],
    };
    const newDoc = {
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    };

    const result = fromYaml(mergeModels(toYaml(existingDoc), toYaml(newDoc), 'merge'));
    assert.equal(result.cubes[0].public, false);
  });

  it('falls back to replacement when existing YAML is unparseable', () => {
    const existing = 'not: valid: yaml: {{{';
    const newYaml = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });

    const result = mergeModels(existing, newYaml, 'merge');
    assert.equal(result, newYaml);
  });
});

// ---------------------------------------------------------------------------
// Strategy: merge_keep_stale
// ---------------------------------------------------------------------------

describe('mergeModels — merge_keep_stale strategy', () => {
  it('retains auto fields for removed columns instead of dropping them', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), autoDim('old_col')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge_keep_stale'));
    const names = result.cubes[0].dimensions.map((d) => d.name);
    assert.ok(names.includes('old_col'), 'stale auto field retained');
    assert.ok(names.includes('id'), 'current auto field kept');
  });

  it('still updates auto fields that exist in both', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('amount', 'string')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('amount', 'number')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge_keep_stale'));
    const dim = result.cubes[0].dimensions.find((d) => d.name === 'amount');
    assert.equal(dim.type, 'number');
  });

  it('still adds new auto fields', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), autoDim('new_col')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge_keep_stale'));
    const names = result.cubes[0].dimensions.map((d) => d.name);
    assert.deepEqual(names, ['id', 'new_col']);
  });

  it('preserves user fields just like regular merge', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), userDim('custom')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge_keep_stale'));
    const names = result.cubes[0].dimensions.map((d) => d.name);
    assert.ok(names.includes('custom'), 'user field preserved');
  });
});

// ---------------------------------------------------------------------------
// Strategy: auto
// ---------------------------------------------------------------------------

describe('mergeModels — auto strategy', () => {
  it('replaces when existing has no auto_generated cubes (standard-generated)', () => {
    const existing = toYaml({
      cubes: [{ name: 'orders', sql_table: 'orders', dimensions: [userDim('id')] }],
    });
    const newYaml = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });

    const result = mergeModels(existing, newYaml, 'auto');
    assert.equal(result, newYaml);
  });

  it('replaces when existing is smart-generated but has no user content', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), autoDim('status')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), autoDim('amount')],
        }),
      ],
    });

    const result = mergeModels(existing, newYaml, 'auto');
    assert.equal(result, newYaml);
  });

  it('merges when existing is smart-generated with user content (user field)', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), userDim('custom')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), autoDim('status')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'auto'));
    const names = result.cubes[0].dimensions.map((d) => d.name);
    assert.ok(names.includes('custom'), 'user field preserved via merge');
    assert.ok(names.includes('status'), 'new auto field added');
    assert.ok(names.includes('id'), 'existing auto field kept');
  });

  it('merges when existing has joins (user content)', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          extra: {
            joins: [{ name: 'users', sql: '{CUBE}.uid = {users}.id', relationship: 'many_to_one' }],
          },
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'auto'));
    assert.ok(Array.isArray(result.cubes[0].joins), 'joins preserved via merge');
    assert.equal(result.cubes[0].joins.length, 1);
  });

  it('defaults to auto strategy when no strategy argument is given', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id'), userDim('custom')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml));
    const names = result.cubes[0].dimensions.map((d) => d.name);
    assert.ok(names.includes('custom'), 'user field preserved with default auto strategy');
  });
});

// ---------------------------------------------------------------------------
// Multi-cube merge
// ---------------------------------------------------------------------------

describe('mergeModels — multi-cube', () => {
  it('matches cubes by name property', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', { dimensions: [autoDim('id')] }),
        autoCube('users', { dimensions: [autoDim('uid')] }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('users', { dimensions: [autoDim('uid'), autoDim('email')] }),
        autoCube('orders', { dimensions: [autoDim('id'), autoDim('total')] }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const cubeNames = result.cubes.map((c) => c.name);
    assert.ok(cubeNames.includes('orders'));
    assert.ok(cubeNames.includes('users'));

    const ordersDims = result.cubes.find((c) => c.name === 'orders').dimensions.map((d) => d.name);
    assert.deepEqual(ordersDims, ['id', 'total']);

    const usersDims = result.cubes.find((c) => c.name === 'users').dimensions.map((d) => d.name);
    assert.deepEqual(usersDims, ['uid', 'email']);
  });

  it('removes auto-generated cubes not present in new YAML (deselected)', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', { dimensions: [autoDim('id')] }),
        autoCube('old_table', { dimensions: [autoDim('x')] }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', { dimensions: [autoDim('id')] }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const cubeNames = result.cubes.map((c) => c.name);
    assert.deepEqual(cubeNames, ['orders']);
  });

  it('preserves user-created cubes even when not in new YAML', () => {
    const userCube = {
      name: 'custom_view',
      sql_table: 'my_view',
      dimensions: [userDim('id')],
      measures: [userMeasure('total')],
    };
    const existing = toYaml({
      cubes: [
        autoCube('orders', { dimensions: [autoDim('id')] }),
        userCube,
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', { dimensions: [autoDim('id')] }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const cubeNames = result.cubes.map((c) => c.name);
    assert.ok(cubeNames.includes('custom_view'), 'user cube preserved');
    assert.ok(cubeNames.includes('orders'), 'auto cube kept');
  });

  it('adds new cubes from new YAML', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', { dimensions: [autoDim('id')] }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', { dimensions: [autoDim('id')] }),
        autoCube('products', { dimensions: [autoDim('pid')] }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const cubeNames = result.cubes.map((c) => c.name);
    assert.ok(cubeNames.includes('products'), 'new cube added');
  });

  it('user cube wins on name collision with auto cube', () => {
    // Existing has a user-created cube named "orders"
    const userCube = {
      name: 'orders',
      sql_table: 'custom_orders',
      dimensions: [userDim('order_id')],
    };
    const existing = toYaml({ cubes: [userCube] });

    // New YAML has an auto-generated cube also named "orders"
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', { dimensions: [autoDim('id')] }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    assert.equal(result.cubes.length, 1);
    assert.equal(result.cubes[0].name, 'orders');
    assert.equal(result.cubes[0].sql_table, 'custom_orders', 'user cube definition wins');
    // Should NOT have auto_generated meta
    assert.equal(result.cubes[0].meta?.auto_generated, undefined);
  });
});

// ---------------------------------------------------------------------------
// Measure-specific merge behaviour
// ---------------------------------------------------------------------------

describe('mergeModels — measures merge', () => {
  it('preserves user measures while updating auto measures', () => {
    const existing = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          measures: [autoMeasure('count'), userMeasure('revenue', 'sum')],
        }),
      ],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          measures: [autoMeasure('count'), autoMeasure('avg_amount', 'avg')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    const measureNames = result.cubes[0].measures.map((m) => m.name);
    assert.ok(measureNames.includes('revenue'), 'user measure preserved');
    assert.ok(measureNames.includes('count'), 'existing auto measure kept');
    assert.ok(measureNames.includes('avg_amount'), 'new auto measure added');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('mergeModels — edge cases', () => {
  it('handles existing YAML with no cubes array', () => {
    const existing = toYaml({ version: 1 });
    const newYaml = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    assert.equal(result.cubes.length, 1);
    assert.equal(result.cubes[0].name, 'orders');
  });

  it('handles new YAML with no cubes array', () => {
    const existing = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });
    const newYaml = toYaml({ version: 2 });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    // All auto cubes removed since none in new; user cubes would be kept
    assert.deepEqual(result.cubes, []);
  });

  it('returns new YAML when new YAML is unparseable', () => {
    const existing = toYaml({
      cubes: [autoCube('orders', { dimensions: [autoDim('id')] })],
    });
    // Use a YAML string that the library can't parse — unmatched block mapping
    const newYaml = 'key:\n  - item\n bad_indent: true';

    const result = mergeModels(existing, newYaml, 'merge');
    assert.equal(result, newYaml);
  });

  it('handles cube with empty dimensions and measures arrays', () => {
    const existing = toYaml({
      cubes: [autoCube('orders', { dimensions: [], measures: [] })],
    });
    const newYaml = toYaml({
      cubes: [
        autoCube('orders', {
          dimensions: [autoDim('id')],
          measures: [autoMeasure('count')],
        }),
      ],
    });

    const result = fromYaml(mergeModels(existing, newYaml, 'merge'));
    assert.equal(result.cubes[0].dimensions.length, 1);
    assert.equal(result.cubes[0].measures.length, 1);
  });
});
