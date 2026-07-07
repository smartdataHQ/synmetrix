import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFilterWhere,
  buildMapProbeSql,
  buildJsonProbeSql,
  parseMapValueType,
  shapeMapEntries,
  shapeJsonEntries,
  createProbeCache,
  escapeSqlString,
} from '../dynamicPropertyProbe.js';

const CUBE_DEF = {
  name: 'SemanticEvents',
  sql_table: 'cst.semantic_events',
  dimensions: [
    { name: 'partition', sql: 'partition', type: 'string' },
    { name: 'event', sql: '{CUBE}.event', type: 'string' },
    { name: 'weird', sql: "concat(a, b)", type: 'string' },
  ],
};

describe('dynamicPropertyProbe — SQL builders', () => {
  it('escapes hostile values (injection guard, FR-006)', () => {
    assert.equal(escapeSqlString("elko'; DROP TABLE x--"), "elko\\'; DROP TABLE x--");
  });

  it('builds the WHERE from partition + simple member filters', () => {
    const where = buildFilterWhere({
      partition: 'elko.is',
      filters: [
        {
          member: 'SemanticEvents.event',
          operator: 'equals',
          values: ['Support Conversation Ended'],
        },
      ],
      cubeDef: CUBE_DEF,
    });
    assert.match(where, /partition = 'elko\.is'/);
    assert.match(where, /event IN \('Support Conversation Ended'\)/);
  });

  it('rejects filters on members whose SQL is not a plain column', () => {
    assert.throws(
      () =>
        buildFilterWhere({
          partition: 'elko.is',
          filters: [{ member: 'SemanticEvents.weird', operator: 'equals', values: ['x'] }],
          cubeDef: CUBE_DEF,
        }),
      /unsupported_filter/
    );
  });

  it('map probe: arrayJoin over the map, grouped per key, scoped WHERE', () => {
    const sql = buildMapProbeSql({
      table: 'cst.semantic_events',
      column: 'dimensions',
      where: "partition = 'elko.is'",
      sampleLimit: 5,
    });
    assert.match(sql, /arrayJoin\(dimensions\)/);
    assert.match(sql, /GROUP BY key/);
    assert.match(sql, /partition = 'elko\.is'/);
    assert.match(sql, /groupUniqArray\(5\)/);
  });

  it('json probe: JSONAllPathsWithTypes grouped per path+type', () => {
    const sql = buildJsonProbeSql({
      table: 'cst.semantic_events',
      column: 'properties',
      where: "partition = 'elko.is'",
    });
    assert.match(sql, /JSONAllPathsWithTypes\(properties\)/);
    assert.match(sql, /GROUP BY path, type/);
  });

  it('parses map value types through LowCardinality/Nullable wrappers', () => {
    assert.equal(parseMapValueType('Map(LowCardinality(String), LowCardinality(String))'), 'String');
    assert.equal(parseMapValueType('Map(LowCardinality(String), Float32)'), 'Float32');
    assert.equal(parseMapValueType('Map(String, Nullable(Bool))'), 'Bool');
    assert.equal(parseMapValueType('String'), null);
  });
});

describe('dynamicPropertyProbe — member shaping', () => {
  it('string map keys become dimensions with rest + sql query forms', () => {
    const entries = shapeMapEntries({
      cube: 'SemanticEvents',
      column: 'dimensions',
      valueType: 'String',
      totalRows: 100,
      sampleLimit: 2,
      rows: [
        {
          key: 'outcome',
          occurrences: '80',
          cardinality: '4',
          sample_values: ['resolved', 'unresolved', 'x'],
        },
      ],
    });

    const entry = entries[0];
    assert.equal(entry.name, 'SemanticEvents.dimensions.outcome');
    assert.equal(entry.memberKind, 'dimension');
    assert.equal(entry.type, 'string');
    assert.equal(entry.source.key, 'outcome');
    assert.equal(entry.stats.occurrences, 80);
    assert.equal(entry.stats.coverage, 0.8);
    assert.equal(entry.stats.cardinality, 4);
    assert.equal(entry.stats.sampleValues.length, 2, 'bounded by sampleLimit');
    assert.deepEqual(entry.query.rest, {
      dimension: 'SemanticEvents.dimensions.outcome',
    });
    assert.equal(entry.query.sql, "dimensions['outcome']");
  });

  it('float map keys become measures; bool map keys become segments', () => {
    const measures = shapeMapEntries({
      cube: 'SemanticEvents', column: 'metrics', valueType: 'Float32',
      totalRows: 10, sampleLimit: 5,
      rows: [{ key: 'duration', occurrences: '7', cardinality: '7', sample_values: [] }],
    });
    assert.equal(measures[0].memberKind, 'measure');
    assert.equal(measures[0].type, 'number');
    assert.deepEqual(measures[0].aggregations, ['sum', 'avg']);
    assert.deepEqual(measures[0].query.rest, { measure: 'SemanticEvents.metrics.duration' });

    const segments = shapeMapEntries({
      cube: 'SemanticEvents', column: 'flags', valueType: 'Bool',
      totalRows: 10, sampleLimit: 5,
      rows: [{ key: 'escalated', occurrences: '3', cardinality: '2', sample_values: [] }],
    });
    assert.equal(segments[0].memberKind, 'segment');
    assert.deepEqual(segments[0].query.rest, { dimension: 'SemanticEvents.flags.escalated' });
  });

  it('json paths report dominant type + share and a typed sql form', () => {
    const entries = shapeJsonEntries({
      cube: 'SemanticEvents',
      column: 'properties',
      totalRows: 100,
      rows: [
        { path: 'user_needed_help_with', type: 'String', occurrences: '90' },
        { path: 'user_needed_help_with', type: 'Int64', occurrences: '10' },
        { path: 'amount', type: 'Float64', occurrences: '20' },
      ],
    });

    const help = entries.find((e) => e.source.path === 'user_needed_help_with');
    assert.equal(help.source.dominantType, 'String');
    assert.equal(help.source.typeShare, 0.9);
    assert.equal(help.stats.occurrences, 100);
    assert.equal(help.type, 'string');
    assert.equal(help.query.sql, 'toString(properties.user_needed_help_with)');

    const amount = entries.find((e) => e.source.path === 'amount');
    assert.equal(amount.type, 'number');
    assert.match(amount.query.sql, /Float64/);
  });
});

describe('dynamicPropertyProbe — TTL cache', () => {
  it('hits within TTL, expires after, keys on all inputs', () => {
    let now = 1_000_000;
    const cache = createProbeCache({ ttlMs: 1000, now: () => now });
    const keyInput = {
      partition: 'elko.is', cube: 'SemanticEvents',
      targets: ['dimensions'], filters: [], schemaVersion: 'v1',
    };

    assert.equal(cache.get(keyInput), null);
    cache.set(keyInput, { hello: 1 });
    assert.deepEqual(cache.get(keyInput), { hello: 1 });

    // any input change misses
    assert.equal(cache.get({ ...keyInput, schemaVersion: 'v2' }), null);
    assert.equal(cache.get({ ...keyInput, partition: 'other.is' }), null);
    assert.equal(
      cache.get({ ...keyInput, filters: [{ member: 'x', operator: 'equals', values: ['y'] }] }),
      null
    );

    now += 1001;
    assert.equal(cache.get(keyInput), null, 'expired after TTL');
  });
});
