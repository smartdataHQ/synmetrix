import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prepareCompiler } from '@cubejs-backend/schema-compiler';
import { generateYaml, generateJs } from '../yamlGenerator.js';

/**
 * 014 T102 — ASSUMPTION GATE (spec Assumptions #3).
 *
 * Parameter-slot members fetch a map element by a query-supplied key via
 * FILTER_PARAMS. This gate proves the slot pattern COMPILES in the standalone
 * validator (the exact compile the 013 worker runs before every publish).
 * If this file fails, STOP 014 work and re-plan slot SQL.
 *
 * The YAML-safe form is the identity arrow `(v) => v`, which
 * transpileArrowsForYaml renders as the python lambda `lambda v: v` —
 * the same pattern smart-generation already ships for nested lookups.
 */

const slotCube = () => ({
  name: 'SemanticEvents',
  sql: "SELECT * FROM cst.semantic_events WHERE partition = 'elko.is'",
  meta: { default_model: true, template: 'semantic_events' },
  dimensions: [
    {
      name: 'partition',
      sql: 'partition',
      type: 'string',
      meta: { from_template: true },
    },
    // slot a: key selector (filter-only) + value fetcher
    {
      name: 'dim_key_a',
      sql: '{FILTER_PARAMS.SemanticEvents.dim_key_a.filter((v) => v)}',
      type: 'string',
      public: false,
      meta: {
        from_template: true,
        param_slot: { map: 'dimensions', role: 'key', slot: 'a' },
      },
    },
    {
      name: 'dim_value_a',
      sql: '{CUBE}.dimensions[{FILTER_PARAMS.SemanticEvents.dim_key_a.filter((v) => v)}]',
      type: 'string',
      meta: {
        from_template: true,
        param_slot: { map: 'dimensions', role: 'value', slot: 'a' },
      },
    },
    {
      name: 'flag_key_a',
      sql: '{FILTER_PARAMS.SemanticEvents.flag_key_a.filter((v) => v)}',
      type: 'string',
      public: false,
      meta: {
        from_template: true,
        param_slot: { map: 'flags', role: 'key', slot: 'a' },
      },
    },
    {
      name: 'flag_value_a',
      sql: '{CUBE}.flags[{FILTER_PARAMS.SemanticEvents.flag_key_a.filter((v) => v)}]',
      type: 'boolean',
      meta: {
        from_template: true,
        param_slot: { map: 'flags', role: 'value', slot: 'a' },
      },
    },
  ],
  measures: [
    { name: 'count', sql: '*', type: 'count', meta: { from_template: true } },
    {
      name: 'metric_key_a',
      sql: '{FILTER_PARAMS.SemanticEvents.metric_key_a.filter((v) => v)}',
      type: 'max',
      public: false,
      meta: {
        from_template: true,
        param_slot: { map: 'metrics', role: 'key', slot: 'a' },
      },
    },
    {
      name: 'metric_sum_a',
      sql: 'CAST({CUBE}.metrics[{FILTER_PARAMS.SemanticEvents.metric_key_a.filter((v) => v)}] AS Float64)',
      type: 'sum',
      meta: {
        from_template: true,
        param_slot: { map: 'metrics', role: 'value', slot: 'a', agg: 'sum' },
      },
    },
  ],
});

class InMemoryRepo {
  constructor(files) {
    this.files = files;
  }

  localPath() {
    return '/';
  }

  async dataSchemaFiles() {
    return this.files;
  }
}

const compile = async (fileName, content) => {
  const { compiler } = prepareCompiler(new InMemoryRepo([{ fileName, content }]), {
    allowNodeRequire: false,
    standalone: true,
  });
  try {
    await compiler.compile();
  } catch (err) {
    const raw = compiler.errorsReport?.getErrors?.() || [];
    const detail = raw.map((e) => e.plainMessage || e.message).join('; ');
    return { ok: false, error: detail || err.plainMessage || err.message };
  }
  return { ok: true };
};

describe('014 T102 — FILTER_PARAMS slot members compile in the standalone validator', () => {
  it('YAML form (identity arrow → python lambda) compiles', async () => {
    const yamlText = generateYaml([slotCube()]);
    assert.match(yamlText, /lambda v: v/, 'arrow transpiled to python lambda');
    const result = await compile('semantic_events.yml', yamlText);
    assert.equal(result.ok, true, `YAML slot compile failed: ${result.error}`);
  });

  it('hand-written JS slot SQL compiles (validator capability; NOT a generation lane)', async () => {
    // NOTE: generateJs() is NOT usable for slots — formatField transpiles the
    // identity arrow to a python lambda even for JS output (pre-existing
    // quirk; smart-gen never hits it because identity-arrow cubes go to
    // YAML). Slots therefore ship exclusively through the YAML lane. This
    // test only proves the standalone validator accepts the JS dialect.
    const jsText = `cube('SemanticEvents', {
  sql: \`SELECT * FROM cst.semantic_events WHERE partition = 'elko.is'\`,
  dimensions: {
    dim_key_a: { sql: \`'-'\`, type: 'string', public: false },
    dim_value_a: {
      sql: \`\${CUBE}.dimensions[\${FILTER_PARAMS.SemanticEvents.dim_key_a.filter((v) => v)}]\`,
      type: 'string',
    },
  },
  measures: { count: { type: 'count' } },
});
`;
    const result = await compile('semantic_events.js', jsText);
    assert.equal(result.ok, true, `JS slot compile failed: ${result.error}`);
  });

  it('the slot cube round-trips through the template pipeline (buildCubesFromTemplate)', async () => {
    const { buildCubesFromTemplate } = await import('../cubeBuilder.js');
    // skeleton mode (null profile): template members must pass through intact
    const { cube } = buildCubesFromTemplate(slotCube(), null, {
      partition: 'elko.is',
      internalTables: ['semantic_events'],
      templateName: 'semantic_events',
      templateChecksum: 't1',
    });
    const yamlText = generateYaml([cube]);
    const result = await compile('semantic_events.yml', yamlText);
    assert.equal(result.ok, true, `pipeline round-trip compile failed: ${result.error}`);
    assert.match(yamlText, /param_slot/, 'slot meta preserved');
  });
});
