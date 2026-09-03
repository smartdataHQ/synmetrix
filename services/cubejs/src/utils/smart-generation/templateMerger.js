import YAML from 'yaml';

/**
 * Template-provenance merge (013, research D4) — the third provenance class
 * the existing merger doesn't have:
 *
 *   - template-owned (`meta.from_template`) — converges to the template on
 *     every reconciliation; team edits to these fields are overwritten
 *     (template wins, FR-012)
 *   - probe-derived (`meta.auto_generated`) — regenerates from the fresh
 *     profile; stale fields drop, team-edited descriptions survive
 *   - team-added (no marker) and `ai_generated` — always preserved (FR-011)
 *
 * Cube-level `joins` / `pre_aggregations` are team-added blocks and are
 * always preserved; team-added meta keys survive under the candidate's
 * provenance stamps.
 */

const isTemplateField = (field) => field?.meta?.from_template === true;
const isAutoField = (field) => field?.meta?.auto_generated === true;
const isPreservedField = (field) =>
  !isTemplateField(field) && !isAutoField(field);

const mergeFieldList = (existingFields = [], candidateFields = []) => {
  const existingByName = new Map(existingFields.map((f) => [f.name, f]));

  const merged = candidateFields.map((candidate) => {
    const existing = existingByName.get(candidate.name);
    if (
      isAutoField(candidate) &&
      existing?.description &&
      existing.description !== candidate.description
    ) {
      // probe field regenerates, but a team-edited description survives
      return { ...candidate, description: existing.description };
    }
    // template-owned and probe-derived: candidate (template/profile) wins
    return candidate;
  });

  const candidateNames = new Set(candidateFields.map((f) => f.name));
  for (const existing of existingFields) {
    if (candidateNames.has(existing.name)) continue;
    if (isPreservedField(existing)) {
      merged.push(existing);
    }
    // absent auto fields = stale probe columns → dropped
    // absent template fields = removed by the template → dropped (template wins)
  }

  return merged;
};

const mergeCube = (existingCube, candidateCube) => {
  const merged = { ...candidateCube };

  merged.dimensions = mergeFieldList(
    existingCube.dimensions,
    candidateCube.dimensions
  );
  merged.measures = mergeFieldList(
    existingCube.measures,
    candidateCube.measures
  );
  if (existingCube.segments?.length || candidateCube.segments?.length) {
    merged.segments = mergeFieldList(
      existingCube.segments || [],
      candidateCube.segments || []
    );
  }

  // team-added blocks are always preserved
  if (existingCube.joins?.length) {
    merged.joins = existingCube.joins;
  }
  if (existingCube.pre_aggregations?.length) {
    merged.pre_aggregations = existingCube.pre_aggregations;
  }

  // provenance stamps from the candidate win; team-added meta keys survive.
  // Keys the generator used to write but no longer does are shed from the
  // existing side, not resurrected through the spread (legacy cleanup —
  // cube-level description is Cube-native now).
  // Keys the generator no longer writes (Cube-native description; and the
  // volatile/redundant cube meta trimmed by spec 080 §4) are shed from the
  // existing side so legacy bloated files clean up on the next reconcile,
  // instead of resurrecting through the spread as presumed team keys.
  const existingMeta = { ...(existingCube.meta || {}) };
  for (const legacyKey of [
    'refresh_cadence',
    'description',
    'grain_description',
    'generated_at',
    'generation_filters',
  ]) {
    if (!(legacyKey in (candidateCube.meta || {}))) delete existingMeta[legacyKey];
  }
  merged.meta = { ...existingMeta, ...(candidateCube.meta || {}) };
  // a re-published template resumes management
  if (
    merged.meta.default_model === true &&
    candidateCube.meta?.default_model_unmanaged !== true
  ) {
    delete merged.meta.default_model_unmanaged;
  }

  return merged;
};

/**
 * Merge a team's current derived-model file with a freshly generated
 * candidate. Returns serialized YAML. Fail-safe: unparseable input falls
 * back to the candidate (a fresh, valid generation) — never throws.
 */
export function mergeTemplateModel(existingCode, candidateCode) {
  if (!existingCode) {
    return candidateCode;
  }

  let existingDoc;
  let candidateDoc;
  try {
    existingDoc = YAML.parse(existingCode);
  } catch {
    return candidateCode;
  }
  try {
    candidateDoc = YAML.parse(candidateCode);
  } catch {
    return candidateCode;
  }
  if (!Array.isArray(existingDoc?.cubes) || !Array.isArray(candidateDoc?.cubes)) {
    return candidateCode;
  }

  const existingByName = new Map(existingDoc.cubes.map((c) => [c.name, c]));
  const candidateNames = new Set(candidateDoc.cubes.map((c) => c.name));

  const cubes = candidateDoc.cubes.map((candidate) => {
    const existing = existingByName.get(candidate.name);
    return existing ? mergeCube(existing, candidate) : candidate;
  });

  // team-added cubes living in the same file are preserved as-is
  for (const existing of existingDoc.cubes) {
    if (!candidateNames.has(existing.name)) {
      cubes.push(existing);
    }
  }

  return YAML.stringify({ cubes }, { lineWidth: 0 });
}

export default mergeTemplateModel;
