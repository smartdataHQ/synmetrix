import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dynamicMeta from '../dynamicMeta.js';

const CUBE_YAML = `cubes:
  - name: SemanticEvents
    sql_table: cst.semantic_events
    meta:
      default_model: true
      template: semantic_events
      source_database: cst
      source_table: semantic_events
    dimensions:
      - name: partition
        sql: partition
        type: string
      - name: event
        sql: "{CUBE}.event"
        type: string
`;

const makeReq = (overrides = {}) => ({
  method: 'POST',
  body: { cube: 'SemanticEvents' },
  headers: {},
  securityContext: {
    userScope: {
      dataSource: {
        dataSourceId: 'ds-1',
        partition: 'elko.is',
        schemaVersion: 'sv-1',
        files: ['f1'],
      },
    },
  },
  ...overrides,
});

const makeRes = () => {
  const res = { statusCode: 200, jsonBody: null };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.jsonBody = b), res);
  return res;
};

const DESCRIBE_ROWS = [
  { name: 'partition', type: 'LowCardinality(String)' },
  { name: 'dimensions', type: 'Map(LowCardinality(String), LowCardinality(String))' },
  { name: 'metrics', type: 'Map(LowCardinality(String), Float32)' },
  { name: 'properties', type: 'JSON' },
];

const makeDeps = (overrides = {}) => {
  const queries = [];
  return {
    queries,
    deps: {
      loadSchemas: async () => [{ id: 'f1', name: 'semantic_events.yml', code: CUBE_YAML }],
      getDriver: async () => ({
        query: async (sql) => {
          queries.push(sql);
          if (/^DESCRIBE/i.test(sql)) return DESCRIBE_ROWS;
          if (sql.includes('arrayJoin(dimensions)')) {
            return [{ key: 'outcome', occurrences: '10', cardinality: '3', sample_values: ['resolved'] }];
          }
          if (sql.includes('arrayJoin(metrics)')) return [];
          if (sql.includes('JSONAllPathsWithTypes')) {
            return [{ path: 'client_ip', type: 'String', occurrences: '5' }];
          }
          if (/count\(\) AS total/.test(sql)) return [{ total: '100' }];
          return [];
        },
      }),
      ttlMs: 60000,
      sampleLimit: 5,
      cache: null, // route creates per-call? tests pass explicit cache when needed
      ...overrides,
    },
  };
};

describe('dynamicMeta route (014 US2)', () => {
  it('requires an authenticated security context', async () => {
    const res = makeRes();
    await dynamicMeta(makeReq({ securityContext: undefined }), res, null, makeDeps().deps);
    assert.equal(res.statusCode, 403);
  });

  it('requires a partition-scoped caller (never probes unscoped)', async () => {
    const req = makeReq();
    req.securityContext.userScope.dataSource.partition = null;
    const res = makeRes();
    await dynamicMeta(req, res, null, makeDeps().deps);
    assert.equal(res.statusCode, 400);
    assert.equal(res.jsonBody.code, 'partition_required');
  });

  it('returns a member-shaped directory with freshness metadata', async () => {
    const { deps } = makeDeps();
    const res = makeRes();
    await dynamicMeta(makeReq(), res, null, deps);

    assert.equal(res.statusCode, 200);
    const body = res.jsonBody;
    assert.equal(body.cube, 'SemanticEvents');
    assert.equal(body.freshness.ttlMs, 60000);
    assert.equal(typeof body.freshness.generatedAt, 'string');
    assert.equal(body.freshness.cached, false);

    const dim = body.dynamicMembers.dimensions[0];
    assert.equal(dim.name, 'SemanticEvents.dimensions.outcome');
    assert.equal(dim.query.sql, "dimensions['outcome']");
    assert.equal(body.dynamicMembers.properties[0].source.path, 'client_ip');
  });

  it('passes user filters into every probe WHERE (filter scoping)', async () => {
    const { deps, queries } = makeDeps();
    const req = makeReq();
    req.body.filters = [
      { member: 'SemanticEvents.event', operator: 'equals', values: ['Page Viewed'] },
    ];
    await dynamicMeta(req, res0(), null, deps);

    const probeSql = queries.filter((q) => !/^DESCRIBE/i.test(q));
    assert.ok(probeSql.length > 0);
    for (const sql of probeSql) {
      assert.match(sql, /event IN \('Page Viewed'\)/);
      assert.match(sql, /partition = 'elko\.is'/, 'partition scope always present');
    }
  });

  it('empty data yields an empty directory, not an error', async () => {
    const { deps } = makeDeps({
      getDriver: async () => ({
        query: async (sql) =>
          /^DESCRIBE/i.test(sql) ? DESCRIBE_ROWS : /total/.test(sql) ? [{ total: '0' }] : [],
      }),
    });
    const res = makeRes();
    await dynamicMeta(makeReq(), res, null, deps);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody.dynamicMembers.dimensions, []);
    assert.deepEqual(res.jsonBody.dynamicMembers.properties, []);
  });

  it('unknown cube → 404', async () => {
    const { deps } = makeDeps();
    const req = makeReq();
    req.body.cube = 'NoSuchCube';
    const res = makeRes();
    await dynamicMeta(req, res, null, deps);
    assert.equal(res.statusCode, 404);
  });
});

function res0() {
  const res = { statusCode: 200 };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = () => res;
  return res;
}
