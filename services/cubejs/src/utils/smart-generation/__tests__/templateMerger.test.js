import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { mergeTemplateModel } from '../templateMerger.js';

// The team's current derived model: template fields (one EDITED by the team),
// probe fields (one stale, one with a team-edited description), team-added
// fields and a team-added pre_aggregation + join.
const EXISTING = `cubes:
  - name: SemanticEvents
    sql: SELECT * FROM cst.semantic_events WHERE partition = 'elko.is'
    meta:
      default_model: true
      template: semantic_events
      template_checksum: old111
      team_note: keep me
    joins:
      - name: Users
        sql: "{CUBE}.user_id = {Users}.id"
        relationship: many_to_one
    pre_aggregations:
      - name: daily_rollup
        measures: [count]
        time_dimension: created_at
        granularity: day
    dimensions:
      - name: partition
        sql: overridden_by_team
        type: number
        meta:
          from_template: true
      - name: stale_probe_col
        sql: stale_probe_col
        type: string
        meta:
          auto_generated: true
      - name: user_name
        sql: user_name
        type: string
        description: Team's own notes about user_name
        meta:
          auto_generated: true
      - name: my_custom_field
        sql: custom_sql_expr
        type: string
    measures:
      - name: count
        sql: '*'
        type: count
        meta:
          from_template: true
`;

// Fresh candidate from template vNEW + reprofile: partition converged back,
// stale_probe_col gone, user_name regenerated (no description), new probe
// field arrived.
const CANDIDATE = `cubes:
  - name: SemanticEvents
    sql: SELECT * FROM cst.semantic_events WHERE partition = 'elko.is'
    meta:
      default_model: true
      template: semantic_events
      template_checksum: new222
    dimensions:
      - name: partition
        sql: partition
        type: string
        meta:
          from_template: true
      - name: user_name
        sql: user_name
        type: string
        meta:
          auto_generated: true
      - name: fresh_probe_col
        sql: fresh_probe_col
        type: string
        meta:
          auto_generated: true
    measures:
      - name: count
        sql: '*'
        type: count
        meta:
          from_template: true
`;

const parse = (code) => YAML.parse(code).cubes[0];
const dim = (cube, name) => cube.dimensions.find((d) => d.name === name);

describe('templateMerger — three-class merge (D4)', () => {
  const merged = parse(mergeTemplateModel(EXISTING, CANDIDATE));

  it('template-owned fields converge to the template — team edits overwritten (FR-012)', () => {
    const partition = dim(merged, 'partition');
    assert.equal(partition.sql, 'partition', 'template definition wins');
    assert.equal(partition.type, 'string');
    assert.equal(partition.meta.from_template, true);
  });

  it('probe-derived fields regenerate: stale dropped, fresh added', () => {
    assert.equal(dim(merged, 'stale_probe_col'), undefined, 'stale auto field dropped');
    assert.ok(dim(merged, 'fresh_probe_col'), 'new probe field present');
    assert.equal(dim(merged, 'fresh_probe_col').meta.auto_generated, true);
  });

  it('team-added fields are preserved (FR-011)', () => {
    const custom = dim(merged, 'my_custom_field');
    assert.ok(custom, 'team-added field survived');
    assert.equal(custom.sql, 'custom_sql_expr');
    assert.notEqual(custom.meta?.from_template, true);
    assert.notEqual(custom.meta?.auto_generated, true);
  });

  it('team-edited description on a probe field is preserved', () => {
    assert.equal(
      dim(merged, 'user_name').description,
      "Team's own notes about user_name"
    );
  });

  it('team-added blocks (joins, pre_aggregations) are preserved', () => {
    assert.equal(merged.joins?.[0]?.name, 'Users');
    assert.equal(merged.pre_aggregations?.[0]?.name, 'daily_rollup');
  });

  it('cube meta: provenance from candidate, team-added meta keys preserved', () => {
    assert.equal(merged.meta.template_checksum, 'new222', 'provenance converges');
    assert.equal(merged.meta.team_note, 'keep me', 'team meta key preserved');
  });

  it('is stable: merging the merged output with the same candidate is a no-op', () => {
    const once = mergeTemplateModel(EXISTING, CANDIDATE);
    const twice = mergeTemplateModel(once, CANDIDATE);
    assert.equal(twice, once);
  });

  it('team-added cubes in the same file are preserved as-is', () => {
    const existingTwoCubes = `${EXISTING}  - name: MyOwnCube
    sql_table: cst.other
    dimensions:
      - name: x
        sql: x
        type: string
`;
    const out = YAML.parse(mergeTemplateModel(existingTwoCubes, CANDIDATE));
    const names = out.cubes.map((c) => c.name).sort();
    assert.deepEqual(names, ['MyOwnCube', 'SemanticEvents']);
  });

  it('unparseable existing content falls back to the candidate (never crashes)', () => {
    const out = mergeTemplateModel('not: [valid yaml', CANDIDATE);
    assert.equal(out, CANDIDATE);
  });

  it('missing existing content returns the candidate', () => {
    assert.equal(mergeTemplateModel(null, CANDIDATE), CANDIDATE);
  });
});
