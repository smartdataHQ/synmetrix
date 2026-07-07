import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberMap } from '../defaultModelMeta.js';

const SLOT_MODEL = `cubes:
  - name: SemanticEvents
    sql: SELECT * FROM cst.semantic_events WHERE partition = 'elko.is'
    meta:
      default_model: true
      template: semantic_events
    dimensions:
      - name: partition
        sql: partition
        type: string
        meta:
          from_template: true
      - name: dim_key_a
        sql: "{FILTER_PARAMS.SemanticEvents.dim_key_a.filter((v) => v)}"
        type: string
        public: false
        meta:
          from_template: true
          param_slot: {map: dimensions, role: key, slot: a}
      - name: dim_value_a
        sql: "{CUBE}.dimensions[{FILTER_PARAMS.SemanticEvents.dim_key_a.filter(lambda v: v)}]"
        type: string
        meta:
          from_template: true
          param_slot: {map: dimensions, role: value, slot: a}
      - name: dim_key_b
        sql: "{FILTER_PARAMS.SemanticEvents.dim_key_b.filter((v) => v)}"
        type: string
        meta:
          from_template: true
          param_slot: {map: dimensions, role: key, slot: b}
      - name: dim_value_b
        sql: "{CUBE}.dimensions[{FILTER_PARAMS.SemanticEvents.dim_key_b.filter(lambda v: v)}]"
        type: string
        meta:
          from_template: true
          param_slot: {map: dimensions, role: value, slot: b}
      - name: flag_key_a
        sql: "{FILTER_PARAMS.SemanticEvents.flag_key_a.filter((v) => v)}"
        type: string
        meta:
          from_template: true
          param_slot: {map: flags, role: key, slot: a}
      - name: flag_value_a
        sql: "{CUBE}.flags[{FILTER_PARAMS.SemanticEvents.flag_key_a.filter(lambda v: v)}]"
        type: boolean
        meta:
          from_template: true
          param_slot: {map: flags, role: value, slot: a}
      - name: metric_key_a
        sql: "{FILTER_PARAMS.SemanticEvents.metric_key_a.filter((v) => v)}"
        type: string
        meta:
          from_template: true
          param_slot: {map: metrics, role: key, slot: a}
    measures:
      - name: count
        type: count
        meta:
          from_template: true
      - name: metric_sum_a
        sql: "CAST({CUBE}.metrics[{FILTER_PARAMS.SemanticEvents.metric_key_a.filter(lambda v: v)}] AS Float64)"
        type: sum
        meta:
          from_template: true
          param_slot: {map: metrics, role: value, slot: a, agg: sum}
      - name: metric_avg_a
        sql: "CAST({CUBE}.metrics[{FILTER_PARAMS.SemanticEvents.metric_key_a.filter(lambda v: v)}] AS Float64)"
        type: avg
        meta:
          from_template: true
          param_slot: {map: metrics, role: value, slot: a, agg: avg}
`;

const PLAIN_MODEL = `cubes:
  - name: PlainCube
    sql_table: cst.other
    meta:
      default_model: true
      template: plain
    dimensions:
      - name: partition
        sql: partition
        type: string
`;

describe('defaultModelMeta — slot registry extraction (014 T106)', () => {
  const map = buildMemberMap([
    { id: '1', name: 'semantic_events.yml', code: SLOT_MODEL },
    { id: '2', name: 'plain.yml', code: PLAIN_MODEL },
  ]);

  it('surfaces param_slot members as a per-map registry', () => {
    const entry = map.get('SemanticEvents');
    assert.ok(entry.slots, 'slots registry present');

    const dims = entry.slots.dimensions;
    assert.equal(dims.length, 2);
    assert.deepEqual(
      dims.map((s) => [s.id, s.keyMember, s.valueMember, s.memberKind]),
      [
        ['a', 'dim_key_a', 'dim_value_a', 'dimension'],
        ['b', 'dim_key_b', 'dim_value_b', 'dimension'],
      ]
    );
  });

  it('measure slots carry their aggregation variants', () => {
    const metrics = map.get('SemanticEvents').slots.metrics;
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].keyMember, 'metric_key_a');
    assert.equal(metrics[0].valueMember, 'metric_sum_a', 'sum is the default');
    assert.equal(metrics[0].memberKind, 'measure');
    assert.deepEqual(metrics[0].aggs, {
      sum: 'metric_sum_a',
      avg: 'metric_avg_a',
    });
  });

  it('flag slots keep dimension kind with boolean typing downstream', () => {
    const flags = map.get('SemanticEvents').slots.flags;
    assert.equal(flags.length, 1);
    assert.equal(flags[0].valueMember, 'flag_value_a');
    assert.equal(flags[0].memberKind, 'dimension');
  });

  it('slot ordering is deterministic (by slot id)', () => {
    const ids = map.get('SemanticEvents').slots.dimensions.map((s) => s.id);
    assert.deepEqual(ids, ['a', 'b']);
  });

  it('cubes without param_slot members expose an empty registry', () => {
    const entry = map.get('PlainCube');
    assert.deepEqual(entry.slots, {});
  });

  it('slot members remain ordinary members (R1 validation still sees them)', () => {
    const entry = map.get('SemanticEvents');
    for (const name of ['dim_key_a', 'dim_value_a', 'metric_sum_a', 'flag_value_a']) {
      assert.ok(entry.members.has(name), `${name} in members set`);
    }
  });
});
