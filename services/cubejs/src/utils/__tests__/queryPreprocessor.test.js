import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createQueryPreprocessor } from '../queryPreprocessor.js';

const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

// unsigned-shape JWTs are fine: the middleware only DECODES (it never
// authorizes); the gateway verifies afterwards
const tokenWith = (payload) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;

const FRAIOS_TOKEN = tokenWith({ partition: 'elko.is', accountId: 'acc-1' });

const TARGET_DS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const context = () => ({
  datasourceId: TARGET_DS,
  memberMap: new Map([
    [
      'SemanticEvents',
      {
        template: 'semantic_events',
        members: new Set(['partition', 'event_type', 'count']),
        hasScopeDimension: true,
      },
    ],
  ]),
});

const makeReq = ({
  method = 'POST',
  body,
  query = {},
  headers = {},
} = {}) => ({
  method,
  body,
  query,
  headers: {
    authorization: `Bearer ${FRAIOS_TOKEN}`,
    'x-hasura-datasource-id': TARGET_DS,
    ...headers,
  },
});

const makeRes = () => {
  const res = { statusCode: null, jsonBody: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.jsonBody = payload;
    return res;
  };
  return res;
};

const run = async (middleware, req) => {
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
};

describe('queryPreprocessor middleware', () => {
  it('injects the scope filter for an in-scope POST query', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => context(),
    });
    const req = makeReq({
      body: { query: { measures: ['SemanticEvents.count'] } },
    });
    const { nextCalled } = await run(middleware, req);

    assert.equal(nextCalled, true);
    assert.ok(Array.isArray(req.body.query.filters));
    assert.equal(req.body.query.filters[0].member, 'SemanticEvents.partition');
    assert.deepEqual(req.body.query.filters[0].values, ['elko.is']);
  });

  it('rejects an absent default-model member with 400 DEFAULT_MODEL_MEMBER_UNAVAILABLE', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => context(),
    });
    const req = makeReq({
      body: {
        query: {
          measures: ['SemanticEvents.count'],
          dimensions: ['SemanticEvents.checkout_step'],
        },
      },
    });
    const { res, nextCalled } = await run(middleware, req);

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.jsonBody.code, 'DEFAULT_MODEL_MEMBER_UNAVAILABLE');
    assert.equal(res.jsonBody.member, 'SemanticEvents.checkout_step');
  });

  it('same-named cube on a DIFFERENT datasource passes through byte-identical', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => context(),
    });
    const body = { query: { measures: ['SemanticEvents.count'] } };
    const snapshot = JSON.stringify(body);
    const req = makeReq({
      body,
      headers: { 'x-hasura-datasource-id': 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    });
    const { nextCalled } = await run(middleware, req);

    assert.equal(nextCalled, true);
    assert.equal(JSON.stringify(req.body), snapshot);
  });

  it('branch/version-preview requests pass through untouched', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => context(),
    });
    for (const header of ['x-hasura-branch-id', 'x-hasura-branch-version-id']) {
      const body = { query: { measures: ['SemanticEvents.count'] } };
      const snapshot = JSON.stringify(body);
      const req = makeReq({ body, headers: { [header]: 'some-branch' } });
      const { nextCalled } = await run(middleware, req);
      assert.equal(nextCalled, true);
      assert.equal(JSON.stringify(req.body), snapshot);
    }
  });

  it('out-of-scope queries (no default-model member) pass through byte-identical', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => context(),
    });
    const body = { query: { measures: ['TeamCube.count'] } };
    const snapshot = JSON.stringify(body);
    const req = makeReq({ body });
    const { nextCalled } = await run(middleware, req);

    assert.equal(nextCalled, true);
    assert.equal(JSON.stringify(req.body), snapshot);
  });

  it('handles array (blending) queries element by element', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => context(),
    });
    const req = makeReq({
      body: {
        query: [
          { measures: ['SemanticEvents.count'] },
          { measures: ['TeamCube.count'] },
        ],
      },
    });
    const { nextCalled } = await run(middleware, req);

    assert.equal(nextCalled, true);
    assert.ok(req.body.query[0].filters?.length === 1, 'first element scoped');
    assert.equal(req.body.query[1].filters, undefined, 'second untouched');
  });

  it('handles the GET JSON-string form', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => context(),
    });
    const req = makeReq({
      method: 'GET',
      body: undefined,
      query: {
        query: JSON.stringify({ measures: ['SemanticEvents.count'] }),
      },
    });
    const { nextCalled } = await run(middleware, req);

    assert.equal(nextCalled, true);
    const parsed = JSON.parse(req.query.query);
    assert.equal(parsed.filters[0].member, 'SemanticEvents.partition');
  });

  it('fails open to the gateway on a missing or unparseable JWT', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => context(),
    });
    for (const headers of [
      { authorization: undefined },
      { authorization: 'Bearer not-a-jwt' },
    ]) {
      const body = { query: { measures: ['SemanticEvents.count'] } };
      const snapshot = JSON.stringify(body);
      const req = makeReq({ body, headers });
      if (headers.authorization === undefined) delete req.headers.authorization;
      const { nextCalled, res } = await run(middleware, req);
      assert.equal(nextCalled, true, 'passed through to gateway auth');
      assert.equal(res.statusCode, null, 'middleware never blocks on auth');
      assert.equal(JSON.stringify(req.body), snapshot);
    }
  });

  it('fails open when meta resolution throws (contract guarantee 3)', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => {
        throw new Error('hasura is down');
      },
    });
    const body = { query: { measures: ['SemanticEvents.count'] } };
    const snapshot = JSON.stringify(body);
    const req = makeReq({ body });
    const { nextCalled } = await run(middleware, req);

    assert.equal(nextCalled, true);
    assert.equal(JSON.stringify(req.body), snapshot);
  });

  it('fails open when the partition resolves to no context (unknown team)', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => null,
    });
    const body = { query: { measures: ['SemanticEvents.count'] } };
    const snapshot = JSON.stringify(body);
    const req = makeReq({ body });
    const { nextCalled } = await run(middleware, req);

    assert.equal(nextCalled, true);
    assert.equal(JSON.stringify(req.body), snapshot);
  });

  it('handles unparseable query payloads by passing through', async () => {
    const middleware = createQueryPreprocessor({
      resolveContext: async () => context(),
    });
    const req = makeReq({
      method: 'GET',
      body: undefined,
      query: { query: '{not json' },
    });
    const { nextCalled } = await run(middleware, req);
    assert.equal(nextCalled, true);
    assert.equal(req.query.query, '{not json');
  });
});
