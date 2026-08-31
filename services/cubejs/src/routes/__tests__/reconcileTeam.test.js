import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVersionChecksum,
  reconcileTeamCore,
} from '../reconcileTeam.js';

const SYSTEM_USER = '99999999-9999-4999-8999-999999999999';

const DERIVED_YAML = `cubes:
  - name: SemanticEvents
    sql: SELECT * FROM cst.semantic_events WHERE partition = 'elko.is'
    meta:
      default_model: true
      template: semantic_events
      template_checksum: old123
    dimensions:
      - name: partition
        sql: partition
        type: string
        meta:
          from_template: true
`;

const TEAM_AUTHORED_YAML = `cubes:
  - name: PageMetrics
    sql_table: cst.page_metrics
    dimensions:
      - name: url
        sql: url
        type: string
`;

const RETIRED_YAML = `cubes:
  - name: LegacyEvents
    sql_table: cst.legacy_events
    meta:
      default_model: true
      template: legacy_events
      template_checksum: aa11
    dimensions:
      - name: partition
        sql: partition
        type: string
        meta:
          from_template: true
`;

const template = (name, overrides = {}) => ({
  name,
  fileName: `${name}.yml`,
  code: `cubes:\n  - name: ${name}\n    sql_table: cst.${name}\n`,
  checksum: 'tpl-checksum-1',
  ...overrides,
});

const baseParams = (overrides = {}) => ({
  teamId: 'team-1',
  partition: 'elko.is',
  templates: [template('semantic_events')],
  optOut: [],
  dryRun: false,
  systemUserId: SYSTEM_USER,
  internalTables: ['semantic_events'],
  ...overrides,
});

// Fake deps: every io hook records its calls.
const makeDeps = (overrides = {}) => {
  const calls = { publish: [], validate: [], generate: [] };
  const deps = {
    loadCurrentSchemas: async () => [],
    probe: async () => ({ row_count: 10 }),
    generate: async ({ template: tpl }) => {
      calls.generate.push(tpl.name);
      return { code: `generated:${tpl.name}`, skeleton: false };
    },
    validate: async (files) => {
      calls.validate.push(files.map((f) => f.name));
      return { valid: true, errors: [] };
    },
    publish: async (payload) => {
      calls.publish.push(payload);
      return { versionId: 'version-new' };
    },
    diff: () => ({}),
    ...overrides,
  };
  return { deps, calls };
};

describe('computeVersionChecksum', () => {
  it('is order-insensitive (files sorted by name before hashing)', () => {
    const a = [
      { name: 'b.yml', code: 'B' },
      { name: 'a.yml', code: 'A' },
    ];
    const b = [
      { name: 'a.yml', code: 'A' },
      { name: 'b.yml', code: 'B' },
    ];
    assert.equal(computeVersionChecksum(a), computeVersionChecksum(b));
    assert.notEqual(
      computeVersionChecksum(a),
      computeVersionChecksum([{ name: 'a.yml', code: 'CHANGED' }, { name: 'b.yml', code: 'B' }])
    );
  });
});

describe('reconcileTeamCore — worker pipeline', () => {
  it('collision: team-authored file without provenance meta is skipped, nothing written', async () => {
    const { deps, calls } = makeDeps({
      loadCurrentSchemas: async () => [
        { id: 'ds-1', name: 'page_metrics.yml', code: TEAM_AUTHORED_YAML },
      ],
    });
    const result = await reconcileTeamCore(
      baseParams({ templates: [template('page_metrics')] }),
      deps
    );

    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0].result, 'skipped_collision');
    assert.match(result.outcomes[0].reason, /provenance/i);
    assert.equal(calls.generate.length, 0, 'no generation for collided template');
    assert.equal(calls.publish.length, 0, 'no version written');
  });

  it('no-op guard: identical candidate records skipped_no_change, no write', async () => {
    const { deps, calls } = makeDeps({
      loadCurrentSchemas: async () => [
        { id: 'ds-1', name: 'semantic_events.yml', code: DERIVED_YAML },
      ],
      generate: async () => ({ code: DERIVED_YAML, skeleton: false }),
    });
    const result = await reconcileTeamCore(baseParams(), deps);

    assert.equal(result.outcomes[0].result, 'skipped_no_change');
    assert.equal(calls.publish.length, 0);
  });

  it('validation failure is isolated: previous file survives, other templates continue', async () => {
    const { deps, calls } = makeDeps({
      loadCurrentSchemas: async () => [
        { id: 'ds-1', name: 'semantic_events.yml', code: DERIVED_YAML },
      ],
      generate: async ({ template: tpl }) => ({
        code: `generated:${tpl.name}`,
        skeleton: false,
      }),
      validate: async (files) => {
        const broken = files.some((f) => f.code === 'generated:broken_one');
        return broken
          ? { valid: false, errors: [{ message: "Unknown dimension 'foo'" }] }
          : { valid: true, errors: [] };
      },
    });

    const result = await reconcileTeamCore(
      baseParams({
        templates: [template('broken_one'), template('semantic_events')],
      }),
      deps
    );

    const brokenOutcome = result.outcomes.find((o) => o.template === 'broken_one');
    const goodOutcome = result.outcomes.find((o) => o.template === 'semantic_events');

    assert.equal(brokenOutcome.result, 'failed');
    assert.match(brokenOutcome.reason, /Unknown dimension/);
    assert.equal(goodOutcome.result, 'updated');
    assert.equal(goodOutcome.versionId, 'version-new');

    // exactly one publish; broken template's file is NOT in it (previous state kept),
    // the good template's new code IS
    assert.equal(calls.publish.length, 1);
    const published = calls.publish[0].files;
    assert.ok(!published.some((f) => f.code === 'generated:broken_one'));
    assert.ok(published.some((f) => f.code === 'generated:semantic_events'));
    assert.ok(
      !published.some((f) => f.name === 'broken_one.yml'),
      'no file created for the failed template'
    );
  });

  it('pre-broken branch: validation failure is classed preexisting_invalid_branch (never halts rollouts)', async () => {
    const brokenTeamFile = { id: 'ds-1', name: 'broken_legacy.js', code: 'not valid js (' };
    const { deps } = makeDeps({
      loadCurrentSchemas: async () => [brokenTeamFile],
      // ANY set containing the broken legacy file fails compile — including
      // the baseline (current) set
      validate: async (files) => {
        const broken = files.some((f) => f.name === 'broken_legacy.js');
        return broken
          ? { valid: false, errors: [{ message: 'FILTER_PARAMS is not defined' }] }
          : { valid: true, errors: [] };
      },
    });
    const result = await reconcileTeamCore(baseParams(), deps);

    assert.equal(result.outcomes[0].result, 'failed');
    assert.match(result.outcomes[0].reason, /^preexisting_invalid_branch:/);
  });

  it('publishes with the system user id (FR-014) and the sorted-set checksum', async () => {
    const { deps, calls } = makeDeps();
    await reconcileTeamCore(baseParams(), deps);

    assert.equal(calls.publish.length, 1);
    assert.equal(calls.publish[0].userId, SYSTEM_USER);
    assert.equal(
      calls.publish[0].checksum,
      computeVersionChecksum(calls.publish[0].files)
    );
  });

  it('retirement sweep: derived model absent from templates gets unmanaged stamp, content preserved', async () => {
    const { deps, calls } = makeDeps({
      loadCurrentSchemas: async () => [
        { id: 'ds-1', name: 'legacy_events.yml', code: RETIRED_YAML },
        { id: 'ds-2', name: 'semantic_events.yml', code: DERIVED_YAML },
      ],
    });
    const result = await reconcileTeamCore(baseParams(), deps);

    assert.equal(calls.publish.length, 1);
    const legacy = calls.publish[0].files.find((f) => f.name === 'legacy_events.yml');
    assert.ok(legacy, 'retired model still in the version');
    assert.match(legacy.code, /default_model_unmanaged: true/);
    assert.match(legacy.code, /name: partition/, 'content preserved');

    const retiredOutcome = result.outcomes.find((o) => o.template === 'legacy_events');
    assert.ok(retiredOutcome, 'retirement recorded');
    assert.equal(retiredOutcome.reason, 'retired');
  });

  it('retirement is idempotent: already-unmanaged model produces no further updates', async () => {
    const alreadyUnmanaged = RETIRED_YAML.replace(
      'template_checksum: aa11',
      "template_checksum: aa11\n      default_model_unmanaged: true"
    );
    const { deps, calls } = makeDeps({
      loadCurrentSchemas: async () => [
        { id: 'ds-1', name: 'legacy_events.yml', code: alreadyUnmanaged },
        { id: 'ds-2', name: 'semantic_events.yml', code: DERIVED_YAML },
      ],
      generate: async () => ({ code: DERIVED_YAML, skeleton: false }),
    });
    const result = await reconcileTeamCore(baseParams(), deps);

    assert.equal(calls.publish.length, 0, 'nothing changed, nothing written');
    assert.ok(!result.outcomes.some((o) => o.template === 'legacy_events'));
  });

  it('opt-out double-check: opted-out template neither generated nor touched', async () => {
    const { deps, calls } = makeDeps({
      loadCurrentSchemas: async () => [],
    });
    const result = await reconcileTeamCore(
      baseParams({ optOut: ['semantic_events'] }),
      deps
    );

    assert.equal(result.outcomes[0].result, 'skipped_opt_out');
    assert.equal(calls.generate.length, 0);
    assert.equal(calls.publish.length, 0);
  });

  it('opt-out makes deletion stick: deleted derived model is NOT recreated', async () => {
    // team deleted semantic_events.yml after opting out — current set is empty
    const { deps, calls } = makeDeps({
      loadCurrentSchemas: async () => [],
    });
    const result = await reconcileTeamCore(
      baseParams({ optOut: ['semantic_events'] }),
      deps
    );

    assert.equal(result.outcomes[0].result, 'skipped_opt_out');
    assert.equal(calls.publish.length, 0, 'deletion sticks — nothing recreated');
  });

  it('deletion WITHOUT opt-out: derived model is recreated on the next run (FR-013)', async () => {
    const { deps, calls } = makeDeps({
      loadCurrentSchemas: async () => [], // file deleted, no opt-out
    });
    const result = await reconcileTeamCore(baseParams(), deps);

    assert.equal(result.outcomes[0].result, 'updated');
    assert.equal(calls.publish.length, 1);
    assert.ok(
      calls.publish[0].files.some((f) => f.name === 'semantic_events.yml'),
      'model recreated'
    );
  });

  it('skeleton generation records updated_skeleton', async () => {
    const { deps } = makeDeps({
      probe: async () => ({ row_count: 0 }),
      generate: async ({ template: tpl }) => ({
        code: `skeleton:${tpl.name}`,
        skeleton: true,
      }),
    });
    const result = await reconcileTeamCore(baseParams(), deps);
    assert.equal(result.outcomes[0].result, 'updated_skeleton');
  });

  it('attaches the breaking removed-members diff to updated outcomes', async () => {
    const { deps } = makeDeps({
      loadCurrentSchemas: async () => [
        { id: 'ds-1', name: 'semantic_events.yml', code: DERIVED_YAML },
      ],
      diff: () => ({ semantic_events: ['SemanticEvents.checkout_step'] }),
    });
    const result = await reconcileTeamCore(baseParams(), deps);

    assert.deepEqual(result.outcomes[0].breaking, ['SemanticEvents.checkout_step']);
  });

  it('append-only publish: full file set inserted, untouched files carried unchanged', async () => {
    const untouched = { id: 'ds-9', name: 'my_own_model.yml', code: TEAM_AUTHORED_YAML };
    const { deps, calls } = makeDeps({
      loadCurrentSchemas: async () => [untouched],
    });
    await reconcileTeamCore(baseParams(), deps);

    assert.equal(calls.publish.length, 1);
    const carried = calls.publish[0].files.find((f) => f.name === 'my_own_model.yml');
    assert.ok(carried, 'team file carried into the new version');
    assert.equal(carried.code, TEAM_AUTHORED_YAML);
  });

  it('event-scoped explicit templates thread event filter + registry paths into the probe (014)', async () => {
    const explicitTemplate = {
      name: 'support_conversations',
      fileName: 'support_conversations.yml',
      code: `cubes:
  - name: SupportConversations
    sql: SELECT * FROM cst.semantic_events WHERE event = 'Support Conversation Ended'
    meta:
      default_model: true
      template: support_conversations
      field_policy: explicit
      event_scope: Support Conversation Ended
    dimensions:
      - name: outcome
        sql: "{CUBE}.dimensions['outcome']"
        type: string
        meta:
          registry_key: dimensions.outcome
      - name: help_topic
        sql: toString({CUBE}.properties.user_needed_help_with)
        type: string
        meta:
          registry_path: properties.user_needed_help_with (string)
    measures:
      - name: conversations
        type: count
`,
      checksum: 'tpl-ev-1',
    };

    const probeCalls = [];
    const { deps } = makeDeps({
      probe: async (args) => {
        probeCalls.push(args);
        return { row_count: 10 };
      },
    });
    await reconcileTeamCore(
      baseParams({ templates: [explicitTemplate, template('semantic_events')] }),
      deps
    );

    const scoped = probeCalls.find((c) => c.eventScope === 'Support Conversation Ended');
    assert.ok(scoped, 'probe receives the template event scope');
    assert.deepEqual(scoped.jsonPaths, {
      properties: ['user_needed_help_with'],
    });

    const unscoped = probeCalls.find((c) => !c.eventScope);
    assert.ok(unscoped, 'plain template probes without an event scope');
    // distinct probe cache entries: same table, different event scopes
    assert.equal(probeCalls.length, 2);
  });

  it('probe failure for one template records failed and continues with the rest', async () => {
    const { deps, calls } = makeDeps({
      probe: async ({ table }) => {
        if (table === 'broken_probe') throw new Error('probe timeout');
        return { row_count: 5 };
      },
    });
    const result = await reconcileTeamCore(
      baseParams({
        templates: [template('broken_probe'), template('semantic_events')],
      }),
      deps
    );

    const failed = result.outcomes.find((o) => o.template === 'broken_probe');
    const ok = result.outcomes.find((o) => o.template === 'semantic_events');
    assert.equal(failed.result, 'failed');
    assert.match(failed.reason, /probe timeout/);
    assert.equal(ok.result, 'updated');
    assert.equal(calls.publish.length, 1);
  });
});
