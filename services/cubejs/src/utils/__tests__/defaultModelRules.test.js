import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDefaultModelRules } from '../defaultModelRules.js';

const memberMap = () =>
  new Map([
    [
      'SemanticEvents',
      {
        template: 'semantic_events',
        members: new Set(['partition', 'event_type', 'count', 'created_at']),
        hasScopeDimension: true,
      },
    ],
    [
      'OrderMetrics',
      {
        template: 'order_metrics',
        members: new Set(['partition', 'total']),
        hasScopeDimension: true,
      },
    ],
  ]);

const ctx = (overrides = {}) => ({
  memberMap: memberMap(),
  partition: 'elko.is',
  adaptations: new Map(),
  ...overrides,
});

describe('defaultModelRules — R1 canonical translation', () => {
  it('passes queries that touch no default-model cube untouched', () => {
    const query = { measures: ['TeamCube.count'], dimensions: ['TeamCube.x'] };
    const result = applyDefaultModelRules(query, ctx());
    assert.equal(result.action, 'pass');
  });

  it('translates canonical references through the adaptation map', () => {
    const query = { measures: ['SemanticEvents.legacy_count'] };
    const result = applyDefaultModelRules(
      query,
      ctx({
        adaptations: new Map([
          ['SemanticEvents.legacy_count', 'SemanticEvents.count'],
        ]),
      })
    );
    assert.equal(result.action, 'rewrite');
    assert.deepEqual(result.query.measures, ['SemanticEvents.count']);
  });

  it('rejects a reference to a member absent from the team variant with the deterministic payload', () => {
    const query = {
      measures: ['SemanticEvents.count'],
      dimensions: ['SemanticEvents.checkout_step'],
    };
    const result = applyDefaultModelRules(query, ctx());

    assert.equal(result.action, 'reject');
    assert.equal(result.rejection.code, 'DEFAULT_MODEL_MEMBER_UNAVAILABLE');
    assert.equal(result.rejection.member, 'SemanticEvents.checkout_step');
    assert.equal(result.rejection.template, 'semantic_events');
    assert.equal(result.rejection.error, 'Default model member unavailable');
  });

  it('checks members referenced in filters and timeDimensions too', () => {
    const inFilter = applyDefaultModelRules(
      {
        measures: ['SemanticEvents.count'],
        filters: [
          {
            or: [
              { member: 'SemanticEvents.not_there', operator: 'set' },
              { member: 'SemanticEvents.event_type', operator: 'set' },
            ],
          },
        ],
      },
      ctx()
    );
    assert.equal(inFilter.action, 'reject');
    assert.equal(inFilter.rejection.member, 'SemanticEvents.not_there');

    const inTimeDim = applyDefaultModelRules(
      {
        measures: ['SemanticEvents.count'],
        timeDimensions: [
          { dimension: 'SemanticEvents.nope', granularity: 'day' },
        ],
      },
      ctx()
    );
    assert.equal(inTimeDim.action, 'reject');
  });
});

// ---------------------------------------------------------------------------
// 014 R3 — dynamic map-key rewrite onto parameter slots
// ---------------------------------------------------------------------------

const slotMemberMap = () =>
  new Map([
    [
      'SemanticEvents',
      {
        template: 'semantic_events',
        members: new Set([
          'partition', 'event_type', 'count',
          'dim_key_a', 'dim_value_a', 'dim_key_b', 'dim_value_b',
          'flag_key_a', 'flag_value_a',
          'metric_key_a', 'metric_sum_a', 'metric_avg_a',
          'metric_key_b', 'metric_sum_b',
        ]),
        hasScopeDimension: true,
        slots: {
          dimensions: [
            { id: 'a', keyMember: 'dim_key_a', valueMember: 'dim_value_a', memberKind: 'dimension', aggs: {} },
            { id: 'b', keyMember: 'dim_key_b', valueMember: 'dim_value_b', memberKind: 'dimension', aggs: {} },
          ],
          metrics: [
            { id: 'a', keyMember: 'metric_key_a', valueMember: 'metric_sum_a', memberKind: 'measure',
              aggs: { sum: 'metric_sum_a', avg: 'metric_avg_a' } },
            { id: 'b', keyMember: 'metric_key_b', valueMember: 'metric_sum_b', memberKind: 'measure',
              aggs: { sum: 'metric_sum_b' } },
          ],
          flags: [
            { id: 'a', keyMember: 'flag_key_a', valueMember: 'flag_value_a', memberKind: 'dimension', aggs: {} },
          ],
        },
      },
    ],
  ]);

const slotCtx = (overrides = {}) => ({
  memberMap: slotMemberMap(),
  partition: 'elko.is',
  adaptations: new Map(),
  ...overrides,
});

const keyFilterFor = (query, keyMember) =>
  (query.filters || []).find((f) => f.member === `SemanticEvents.${keyMember}`);

describe('defaultModelRules — R3 dynamic key rewrite (014)', () => {
  it('rewrites a single dynamic dimension onto slot a with the key filter injected (FR-004)', () => {
    const query = {
      measures: ['SemanticEvents.count'],
      dimensions: ['SemanticEvents.dimensions.outcome'],
    };
    const result = applyDefaultModelRules(query, slotCtx());

    assert.equal(result.action, 'rewrite');
    assert.deepEqual(result.query.dimensions, ['SemanticEvents.dim_value_a']);
    const keyFilter = keyFilterFor(result.query, 'dim_key_a');
    assert.ok(keyFilter, 'key filter ALWAYS injected');
    assert.equal(keyFilter.operator, 'equals');
    assert.deepEqual(keyFilter.values, ['outcome']);
  });

  it('two distinct keys of one map occupy independent slots (deterministic order)', () => {
    const query = {
      measures: ['SemanticEvents.count'],
      dimensions: [
        'SemanticEvents.dimensions.urgency',
        'SemanticEvents.dimensions.outcome',
      ],
    };
    const result = applyDefaultModelRules(query, slotCtx());

    // deterministic: keys sorted alphabetically → outcome=a, urgency=b
    assert.deepEqual(result.query.dimensions, [
      'SemanticEvents.dim_value_b',
      'SemanticEvents.dim_value_a',
    ]);
    assert.deepEqual(keyFilterFor(result.query, 'dim_key_a').values, ['outcome']);
    assert.deepEqual(keyFilterFor(result.query, 'dim_key_b').values, ['urgency']);
  });

  it('exhaustion: three distinct keys of a two-slot map → deterministic rejection', () => {
    const query = {
      dimensions: [
        'SemanticEvents.dimensions.outcome',
        'SemanticEvents.dimensions.urgency',
        'SemanticEvents.dimensions.channel',
      ],
    };
    const result = applyDefaultModelRules(query, slotCtx());

    assert.equal(result.action, 'reject');
    assert.equal(result.rejection.code, 'DYNAMIC_KEY_SLOTS_EXHAUSTED');
    assert.equal(result.rejection.map, 'dimensions');
    assert.equal(result.rejection.slots, 2);
    assert.deepEqual(
      [...result.rejection.requested].sort(),
      ['channel', 'outcome', 'urgency']
    );
  });

  it('metrics key becomes the sum slot measure by default; .avg suffix selects avg', () => {
    const query = {
      measures: [
        'SemanticEvents.metrics.duration',
        'SemanticEvents.metrics.duration.avg',
      ],
      dimensions: ['SemanticEvents.event_type'],
    };
    const result = applyDefaultModelRules(query, slotCtx());

    assert.deepEqual(result.query.measures, [
      'SemanticEvents.metric_sum_a',
      'SemanticEvents.metric_avg_a',
    ]);
    // one key, one slot — both aggregations share slot a's key member
    assert.deepEqual(keyFilterFor(result.query, 'metric_key_a').values, ['duration']);
    assert.equal(keyFilterFor(result.query, 'metric_key_b'), undefined);
  });

  it('flags key rewrites onto the boolean slot, including inside filters', () => {
    const query = {
      measures: ['SemanticEvents.count'],
      filters: [
        {
          member: 'SemanticEvents.flags.escalated',
          operator: 'equals',
          values: ['true'],
        },
      ],
    };
    const result = applyDefaultModelRules(query, slotCtx());

    const rewritten = result.query.filters.find(
      (f) => f.member === 'SemanticEvents.flag_value_a'
    );
    assert.ok(rewritten, 'filter member rewritten to slot value');
    assert.deepEqual(rewritten.values, ['true']);
    assert.deepEqual(keyFilterFor(result.query, 'flag_key_a').values, ['escalated']);
  });

  it('dynamic refs mix freely with declared members', () => {
    const query = {
      measures: ['SemanticEvents.count'],
      dimensions: [
        'SemanticEvents.event_type',
        'SemanticEvents.dimensions.outcome',
      ],
    };
    const result = applyDefaultModelRules(query, slotCtx());
    assert.deepEqual(result.query.dimensions, [
      'SemanticEvents.event_type',
      'SemanticEvents.dim_value_a',
    ]);
  });

  it('no dynamic refs → prior behavior unchanged (pass/rewrite only via R1/R2)', () => {
    const query = { measures: ['TeamCube.count'] };
    assert.equal(applyDefaultModelRules(query, slotCtx()).action, 'pass');
  });

  it('is idempotent: re-processing a rewritten query changes nothing further', () => {
    const query = {
      measures: ['SemanticEvents.count'],
      dimensions: ['SemanticEvents.dimensions.outcome'],
    };
    const first = applyDefaultModelRules(query, slotCtx());
    assert.equal(first.action, 'rewrite');
    const second = applyDefaultModelRules(first.query, slotCtx());
    assert.equal(second.action, 'pass');
  });

  it('unknown map name is NOT treated as dynamic (falls through to R1 rejection)', () => {
    const query = { dimensions: ['SemanticEvents.notamap.key'] };
    const result = applyDefaultModelRules(query, slotCtx());
    assert.equal(result.action, 'reject');
    assert.equal(result.rejection.code, 'DEFAULT_MODEL_MEMBER_UNAVAILABLE');
  });
});

describe('defaultModelRules — R2 scoping enforcement', () => {
  it('injects the canonical scope filter for every referenced default-model cube', () => {
    const query = {
      measures: ['SemanticEvents.count', 'OrderMetrics.total'],
    };
    const result = applyDefaultModelRules(query, ctx());

    assert.equal(result.action, 'rewrite');
    const scopeFilters = result.query.filters.filter(
      (f) => f.operator === 'equals' && f.values?.[0] === 'elko.is'
    );
    assert.deepEqual(
      scopeFilters.map((f) => f.member).sort(),
      ['OrderMetrics.partition', 'SemanticEvents.partition']
    );
  });

  it('deduplicates: an existing identical scope filter is not injected twice', () => {
    const query = {
      measures: ['SemanticEvents.count'],
      filters: [
        {
          member: 'SemanticEvents.partition',
          operator: 'equals',
          values: ['elko.is'],
        },
      ],
    };
    const result = applyDefaultModelRules(query, ctx());

    const scopeFilters = (result.query || query).filters.filter(
      (f) => f.member === 'SemanticEvents.partition'
    );
    assert.equal(scopeFilters.length, 1);
  });

  it('never touches cubes without the scope dimension', () => {
    const map = new Map([
      [
        'NoScope',
        { template: 'no_scope', members: new Set(['count']), hasScopeDimension: false },
      ],
    ]);
    const result = applyDefaultModelRules(
      { measures: ['NoScope.count'] },
      ctx({ memberMap: map })
    );
    // nothing to inject, nothing to reject
    assert.equal(result.action, 'pass');
  });

  it('is idempotent: processing an already-processed query changes nothing', () => {
    const query = { measures: ['SemanticEvents.count'] };
    const first = applyDefaultModelRules(query, ctx());
    assert.equal(first.action, 'rewrite');

    const second = applyDefaultModelRules(first.query, ctx());
    assert.equal(second.action, 'pass', 'no further changes on a second pass');
  });

  it('does not mutate the input query object', () => {
    const query = { measures: ['SemanticEvents.count'] };
    const snapshot = JSON.stringify(query);
    applyDefaultModelRules(query, ctx());
    assert.equal(JSON.stringify(query), snapshot);
  });
});
