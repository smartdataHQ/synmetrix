import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCubesFromTemplate } from '../cubeBuilder.js';
import { generateYaml } from '../yamlGenerator.js';
import { ColumnType, ValueType } from '../typeParser.js';

const TEMPLATE_CHECKSUM = 'ab12cd34';

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

function makeProfile(overrides = {}) {
  return {
    database: 'cst',
    table: 'semantic_events',
    partition: 'elko.is',
    row_count: 42,
    columns: new Map([
      col('partition', 'String', ColumnType.BASIC, ValueType.STRING),
      col('type', 'String', ColumnType.BASIC, ValueType.STRING),
      col('user_name', 'String', ColumnType.BASIC, ValueType.STRING),
      col('amount', 'Float64', ColumnType.BASIC, ValueType.NUMBER),
    ]),
    ...overrides,
  };
}

function makeTemplateCube() {
  return {
    name: 'SemanticEvents',
    sql_table: 'cst.semantic_events',
    meta: { admin_note: 'canonical events model' },
    dimensions: [
      { name: 'partition', sql: 'partition', type: 'string' },
      // a stray auto_generated marker in the template must be superseded by
      // from_template — template-owned is a distinct provenance class
      { name: 'event_type', sql: 'type', type: 'string', meta: { auto_generated: true } },
    ],
    measures: [{ name: 'count', type: 'count', sql: '*' }],
  };
}

const options = () => ({
  partition: 'elko.is',
  internalTables: ['semantic_events'],
  templateName: 'semantic_events',
  templateChecksum: TEMPLATE_CHECKSUM,
});

describe('cubeBuilder – buildCubesFromTemplate', () => {
  it('stamps cube-level provenance meta (default_model, template, template_checksum)', () => {
    const { cube } = buildCubesFromTemplate(makeTemplateCube(), makeProfile(), options());

    assert.equal(cube.meta.default_model, true);
    assert.equal(cube.meta.template, 'semantic_events');
    assert.equal(cube.meta.template_checksum, TEMPLATE_CHECKSUM);
    // template's own meta is preserved
    assert.equal(cube.meta.admin_note, 'canonical events model');
  });

  it('marks every template field from_template and clears auto_generated on them', () => {
    const { cube } = buildCubesFromTemplate(makeTemplateCube(), makeProfile(), options());

    const partitionDim = cube.dimensions.find((d) => d.name === 'partition');
    const eventTypeDim = cube.dimensions.find((d) => d.name === 'event_type');
    const countMeasure = cube.measures.find((m) => m.name === 'count');

    for (const field of [partitionDim, eventTypeDim, countMeasure]) {
      assert.ok(field, 'template field present');
      assert.equal(field.meta.from_template, true);
      assert.notEqual(field.meta.auto_generated, true);
    }
  });

  it('bakes the partition literal into the cube SQL source', () => {
    const { cube } = buildCubesFromTemplate(makeTemplateCube(), makeProfile(), options());

    assert.equal(cube.sql_table, undefined);
    assert.match(cube.sql, /partition = 'elko\.is'/);
    assert.match(cube.sql, /cst\.semantic_events/);
  });

  it('adds probe-derived fields (auto_generated) without duplicating template fields', () => {
    const { cube, skeleton } = buildCubesFromTemplate(
      makeTemplateCube(),
      makeProfile(),
      options()
    );

    assert.equal(skeleton, false);

    const userName = cube.dimensions.find((d) => d.name === 'user_name');
    assert.ok(userName, 'probe-derived dimension present');
    assert.equal(userName.meta.auto_generated, true);
    assert.notEqual(userName.meta.from_template, true);

    // template-owned names never duplicated by probe output
    const partitionDims = cube.dimensions.filter((d) => d.name === 'partition');
    assert.equal(partitionDims.length, 1);
    assert.equal(partitionDims[0].meta.from_template, true);
    const countMeasures = cube.measures.filter((m) => m.name === 'count');
    assert.equal(countMeasures.length, 1);
    assert.equal(countMeasures[0].meta.from_template, true);
  });

  it('emits a skeleton (template structure only) for an empty profile', () => {
    const empty = makeProfile({ row_count: 0 });
    const { cube, skeleton } = buildCubesFromTemplate(makeTemplateCube(), empty, options());

    assert.equal(skeleton, true);
    assert.deepEqual(
      cube.dimensions.map((d) => d.name).sort(),
      ['event_type', 'partition']
    );
    assert.deepEqual(cube.measures.map((m) => m.name), ['count']);
    // provenance + scoping still apply in skeleton mode
    assert.equal(cube.meta.default_model, true);
    assert.match(cube.sql, /partition = 'elko\.is'/);
  });

  it('treats a missing profile as skeleton mode', () => {
    const { skeleton } = buildCubesFromTemplate(makeTemplateCube(), null, options());
    assert.equal(skeleton, true);
  });
});

describe('template mode – probe-field safety filter', () => {
  it('excludes FILTER_PARAMS / jinja probe fields from derived models', async () => {
    const { isTemplateSafeProbeField } = await import('../cubeBuilder.js');

    assert.equal(
      isTemplateSafeProbeField({ name: 'plain', sql: '{CUBE}.plain' }),
      true
    );
    assert.equal(
      isTemplateSafeProbeField({
        name: 'lookup_metric',
        sql: "metrics[indexOf(metrics.keys, FILTER_PARAMS.SemanticEvents.metric_key.filter('x'))]",
      }),
      false,
      'FILTER_PARAMS lookup fields need runtime support the derived-model validator must not depend on'
    );
    assert.equal(
      isTemplateSafeProbeField({ name: 'jinja', sql: "{% if x %}a{% endif %}" }),
      false
    );
    assert.equal(isTemplateSafeProbeField({ name: 'no_sql' }), true);
  });

  it('sanitizes braces in every prose/data string but never in sql (deep walk)', async () => {
    const { sanitizeCubeProse } = await import('../cubeBuilder.js');

    const dirty = {
      name: 'x',
      sql: "SELECT * FROM t WHERE partition = 'p'",
      description: 'WHERE uses account_id = {FILTER_PARAMS.foo.partition.filter}',
      dimensions: [
        {
          name: 'd',
          sql: '{CUBE}.d',
          meta: {
            lc_values: ['plain', 'chat said {FILTER_PARAMS.x.y.filter} ok'],
            description: 'comment with {braces}',
          },
        },
      ],
    };
    const clean = sanitizeCubeProse(dirty);

    assert.equal(clean.sql, dirty.sql, 'cube sql untouched');
    assert.equal(clean.dimensions[0].sql, '{CUBE}.d', 'member sql untouched');
    assert.equal(
      clean.description,
      'WHERE uses account_id = (FILTER_PARAMS.foo.partition.filter)'
    );
    assert.equal(
      clean.dimensions[0].meta.lc_values[1],
      'chat said (FILTER_PARAMS.x.y.filter) ok'
    );
    assert.equal(clean.dimensions[0].meta.description, 'comment with (braces)');
    assert.equal(dirty.description.includes('{'), true, 'input not mutated');
  });
});

// ---------------------------------------------------------------------------
// 014 US3/US4 — field_policy: explicit (registry prune-only generation)
// ---------------------------------------------------------------------------

function makeExplicitTemplate() {
  return {
    name: 'SupportConversations',
    sql: "SELECT * FROM cst.semantic_events WHERE event = 'Support Conversation Ended'",
    meta: {
      default_model: true,
      template: 'support_conversations',
      field_policy: 'explicit',
      event_scope: 'Support Conversation Ended',
    },
    dimensions: [
      { name: 'partition', sql: 'partition', type: 'string' },
      {
        name: 'outcome',
        sql: "{CUBE}.dimensions['outcome']",
        type: 'string',
        meta: { registry_key: 'dimensions.outcome' },
      },
      {
        name: 'language_of_chat',
        sql: "{CUBE}.dimensions['language_of_chat']",
        type: 'string',
        meta: { registry_key: 'dimensions.language_of_chat' },
      },
      {
        name: 'help_topic',
        sql: 'toString({CUBE}.properties.user_needed_help_with)',
        type: 'string',
        meta: { registry_path: 'properties.user_needed_help_with (string)' },
      },
      {
        name: 'missing_topic',
        sql: 'toString({CUBE}.properties.never_seen)',
        type: 'string',
        meta: { registry_path: 'properties.never_seen (string)' },
      },
    ],
    measures: [{ name: 'conversations', type: 'count', sql: '*' }],
  };
}

describe('template mode – field_policy: explicit (014 FR-008/FR-010)', () => {
  const options014 = () => ({
    partition: 'elko.is',
    internalTables: ['semantic_events'],
    templateName: 'support_conversations',
    templateChecksum: 'tpl-x1',
  });

  const profileWith = ({ dimensionKeys = [], jsonPaths = null }) => {
    const profile = makeProfile();
    profile.columns.set('dimensions', {
      name: 'dimensions',
      rawType: 'Map(LowCardinality(String), LowCardinality(String))',
      columnType: ColumnType.BASIC,
      valueType: ValueType.STRING,
      isNullable: false,
      profile: { hasValues: true, uniqueValues: 0, uniqueKeys: dimensionKeys, lcValues: [] },
    });
    if (jsonPaths) profile.jsonPaths = new Set(jsonPaths);
    return profile;
  };

  it('never adds probe-derived fields (SC-003)', () => {
    const { cube } = buildCubesFromTemplate(
      makeExplicitTemplate(),
      profileWith({ dimensionKeys: ['outcome', 'language_of_chat'] }),
      options014()
    );
    const names = cube.dimensions.map((d) => d.name);
    assert.ok(!names.includes('user_name'), 'probe columns never become members');
    assert.ok(!names.includes('amount'));
  });

  it('prunes registry_key members whose key is absent from the profile', () => {
    const { cube } = buildCubesFromTemplate(
      makeExplicitTemplate(),
      profileWith({ dimensionKeys: ['outcome'] }), // language_of_chat missing
      options014()
    );
    const names = cube.dimensions.map((d) => d.name);
    assert.ok(names.includes('outcome'), 'present key kept');
    assert.ok(!names.includes('language_of_chat'), 'absent key pruned');
    assert.ok(names.includes('partition'), 'non-registry template members untouched');
  });

  it('prunes registry_path members by JSON path presence (FR-010)', () => {
    const { cube } = buildCubesFromTemplate(
      makeExplicitTemplate(),
      profileWith({
        dimensionKeys: ['outcome', 'language_of_chat'],
        jsonPaths: ['user_needed_help_with'],
      }),
      options014()
    );
    const names = cube.dimensions.map((d) => d.name);
    assert.ok(names.includes('help_topic'), 'registered present path kept, cast SQL intact');
    assert.equal(
      cube.dimensions.find((d) => d.name === 'help_topic').sql,
      'toString({CUBE}.properties.user_needed_help_with)'
    );
    assert.ok(!names.includes('missing_topic'), 'absent path pruned');
  });

  it('keeps all registry members when path presence is unknown (no jsonPaths probed)', () => {
    const { cube } = buildCubesFromTemplate(
      makeExplicitTemplate(),
      profileWith({ dimensionKeys: ['outcome', 'language_of_chat'] }),
      options014()
    );
    assert.ok(cube.dimensions.some((d) => d.name === 'missing_topic'));
  });

  it('skeleton mode keeps the full registry (013 skeleton semantics)', () => {
    const { cube, skeleton } = buildCubesFromTemplate(
      makeExplicitTemplate(),
      { ...profileWith({}), row_count: 0 },
      options014()
    );
    assert.equal(skeleton, true);
    const names = cube.dimensions.map((d) => d.name);
    assert.ok(names.includes('outcome'));
    assert.ok(names.includes('help_topic'));
  });

  it('default policy is byte-for-byte unchanged (013 regression guard)', () => {
    const legacy = buildCubesFromTemplate(makeTemplateCube(), makeProfile(), options());
    assert.ok(legacy.cube.dimensions.some((d) => d.name === 'user_name'),
      'probe fields still added without the explicit policy');
  });
});

describe('yamlGenerator – template provenance round-trip', () => {
  it('does not stamp auto_generated onto from_template fields', () => {
    const { cube } = buildCubesFromTemplate(makeTemplateCube(), makeProfile(), options());
    const yamlText = generateYaml([cube]);

    assert.match(yamlText, /from_template: true/);
    assert.match(yamlText, /default_model: true/);
    assert.match(yamlText, /template_checksum: ab12cd34/);

    // parse back and check the partition dimension specifically
    const lines = yamlText.split('\n');
    const partitionIdx = lines.findIndex((l) => l.includes('name: partition'));
    const nextFieldIdx = lines.findIndex(
      (l, i) => i > partitionIdx && /^\s+- name:/.test(l)
    );
    const partitionBlock = lines
      .slice(partitionIdx, nextFieldIdx === -1 ? undefined : nextFieldIdx)
      .join('\n');
    assert.doesNotMatch(partitionBlock, /auto_generated: true/);
  });
});
