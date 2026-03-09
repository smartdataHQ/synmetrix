/**
 * Smart Merger — field-level merge for re-profiling existing Cube.js YAML models.
 *
 * Implements four strategies: auto, merge, replace, merge_keep_stale.
 * See specs/004-dynamic-model-creation/data-model.md for full merge rules.
 */

import YAML from 'yaml';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a single field (dimension or measure) is auto-generated.
 */
function isAutoField(field) {
  return field?.meta?.auto_generated === true;
}

/**
 * Check whether a cube is auto-generated.
 */
function isAutoCube(cube) {
  return cube?.meta?.auto_generated === true;
}

/**
 * Build a lookup map of fields keyed by `name`.
 * Works for dimensions, measures, or any array of objects with a `name` property.
 */
function fieldsByName(fields) {
  const map = new Map();
  if (!Array.isArray(fields)) return map;
  for (const f of fields) {
    if (f?.name) map.set(f.name, f);
  }
  return map;
}

/**
 * Check whether a field's description has been edited by the user.
 * A description is "edited" when the field is auto-generated but carries a
 * description that differs from what the new generation produces for the same
 * field name.  When there is no matching new field we conservatively treat
 * any non-empty description as user-edited.
 */
function hasEditedDescription(existingField, newFieldMap) {
  if (!isAutoField(existingField)) return false;
  if (!existingField.description) return false;

  const newField = newFieldMap?.get(existingField.name);
  if (!newField) {
    // Field no longer generated — any description is treated as user-edited.
    return true;
  }
  return existingField.description !== (newField.description ?? undefined);
}

// ---------------------------------------------------------------------------
// User-content detection
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the cube contains any user content.
 *
 * User content is defined as:
 * - Any dimension/measure without `meta.auto_generated` (user-created field)
 * - Any auto-generated field whose description differs from the default
 *   (we approximate this: if any auto field has a non-empty description we
 *    flag it, since during detection we don't have the "new" YAML to compare)
 * - A `joins` block exists
 * - A `pre_aggregations` block exists
 * - A `segments` block exists
 */
function cubeHasUserContent(cube) {
  // Joins / pre_aggregations / segments — smart generation never creates these
  if (Array.isArray(cube.joins) && cube.joins.length > 0) return true;
  if (Array.isArray(cube.pre_aggregations) && cube.pre_aggregations.length > 0) return true;
  if (Array.isArray(cube.segments) && cube.segments.length > 0) return true;

  // Check dimensions and measures for user-created fields or edited descriptions
  const allFields = [
    ...(Array.isArray(cube.dimensions) ? cube.dimensions : []),
    ...(Array.isArray(cube.measures) ? cube.measures : []),
  ];

  for (const field of allFields) {
    if (!isAutoField(field)) {
      // User-created field (no auto_generated tag)
      return true;
    }
    // Auto-generated field with a description — treated as user-edited during
    // detection (we don't have the new YAML available in hasUserContent).
    if (field.description) {
      return true;
    }
  }

  return false;
}

/**
 * Returns `true` if the YAML string contains any user content across all cubes.
 *
 * @param {string} yamlString - YAML model content to inspect
 * @returns {boolean}
 */
export function hasUserContent(yamlString) {
  if (!yamlString || typeof yamlString !== 'string') return false;

  let doc;
  try {
    doc = YAML.parse(yamlString);
  } catch {
    // Malformed YAML — treat as having user content (safest default)
    return true;
  }

  const cubes = doc?.cubes;
  if (!Array.isArray(cubes) || cubes.length === 0) return false;

  // If any cube lacks auto_generated provenance, it's a standard-generated or
  // hand-written model — which counts as "user content" in the auto strategy.
  for (const cube of cubes) {
    if (!isAutoCube(cube)) return true;
    if (cubeHasUserContent(cube)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Field-level merge for a single cube
// ---------------------------------------------------------------------------

/**
 * Merge a single field list (dimensions or measures) from existing and new cubes.
 *
 * @param {Array} existingFields - Fields from the existing cube
 * @param {Array} newFields - Fields from the newly generated cube
 * @param {boolean} keepStale - If true, retain auto fields for removed columns
 * @returns {Array} Merged field list
 */
function mergeFields(existingFields, newFields, keepStale) {
  const existing = Array.isArray(existingFields) ? existingFields : [];
  const incoming = Array.isArray(newFields) ? newFields : [];

  const newMap = fieldsByName(incoming);
  const merged = [];
  const handledNames = new Set();

  for (const field of existing) {
    const name = field.name;

    if (!isAutoField(field)) {
      // User-created field — always preserve unchanged
      merged.push(field);
      handledNames.add(name);
      continue;
    }

    // Auto-generated field
    const newField = newMap.get(name);

    if (newField) {
      // Column still exists in new profile — update auto field
      const updatedField = { ...newField };

      // Preserve user-edited description
      if (field.description && field.description !== (newField.description ?? undefined)) {
        updatedField.description = field.description;
      }

      merged.push(updatedField);
      handledNames.add(name);
    } else if (keepStale) {
      // Column removed but keepStale — retain the auto field as-is
      merged.push(field);
      handledNames.add(name);
    }
    // else: auto field for a removed column, strategy is not keep_stale → drop it
  }

  // Add new auto-generated fields not present in existing
  for (const field of incoming) {
    if (!handledNames.has(field.name)) {
      merged.push(field);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Cube-level merge
// ---------------------------------------------------------------------------

/**
 * Merge a single cube pair (existing + new).
 *
 * @param {object} existingCube - The existing cube definition
 * @param {object} newCube - The newly generated cube definition
 * @param {boolean} keepStale - Whether to keep stale auto fields
 * @returns {object} Merged cube
 */
function mergeCube(existingCube, newCube, keepStale) {
  const merged = { ...newCube };

  // --- Dimensions & Measures ---
  merged.dimensions = mergeFields(existingCube.dimensions, newCube.dimensions, keepStale);
  merged.measures = mergeFields(existingCube.measures, newCube.measures, keepStale);

  // --- Always-preserve blocks (smart generation never creates these) ---
  if (Array.isArray(existingCube.joins) && existingCube.joins.length > 0) {
    merged.joins = existingCube.joins;
  }
  if (Array.isArray(existingCube.pre_aggregations) && existingCube.pre_aggregations.length > 0) {
    merged.pre_aggregations = existingCube.pre_aggregations;
  }
  if (Array.isArray(existingCube.segments) && existingCube.segments.length > 0) {
    merged.segments = existingCube.segments;
  }

  // --- Description (cube-level) ---
  // Preserve user-edited description; only use new if existing has none.
  if (existingCube.description) {
    merged.description = existingCube.description;
  }

  // --- Public flag ---
  // Preserve if user has explicitly set it on the existing cube.
  if (existingCube.public !== undefined) {
    merged.public = existingCube.public;
  }

  // --- Meta (cube-level) ---
  // Regenerate provenance keys from new; preserve user-added meta keys.
  if (existingCube.meta && typeof existingCube.meta === 'object') {
    const existingMeta = { ...existingCube.meta };
    const newMeta = newCube.meta ? { ...newCube.meta } : {};

    // Collect user-added meta keys (anything that isn't a provenance key)
    const provenanceKeys = new Set([
      'auto_generated',
      'source_database',
      'source_table',
      'source_partition',
      'generated_at',
    ]);

    for (const [key, value] of Object.entries(existingMeta)) {
      if (!provenanceKeys.has(key)) {
        // User-added meta key — preserve it
        newMeta[key] = value;
      }
    }

    merged.meta = newMeta;
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Multi-cube merge
// ---------------------------------------------------------------------------

/**
 * Merge two parsed YAML documents (multi-cube aware).
 *
 * @param {object} existingDoc - Parsed existing YAML document
 * @param {object} newDoc - Parsed new YAML document
 * @param {boolean} keepStale - Whether to keep stale auto fields
 * @returns {object} Merged document
 */
function mergeDocuments(existingDoc, newDoc, keepStale) {
  const existingCubes = Array.isArray(existingDoc?.cubes) ? existingDoc.cubes : [];
  const newCubes = Array.isArray(newDoc?.cubes) ? newDoc.cubes : [];

  // Build lookup maps by cube name
  const existingByName = new Map();
  for (const cube of existingCubes) {
    if (cube?.name) existingByName.set(cube.name, cube);
  }

  const newByName = new Map();
  for (const cube of newCubes) {
    if (cube?.name) newByName.set(cube.name, cube);
  }

  const mergedCubes = [];
  const processedNames = new Set();

  // 1. Process existing cubes
  for (const cube of existingCubes) {
    const name = cube.name;

    if (!isAutoCube(cube)) {
      // User-created cube — always preserve as-is
      mergedCubes.push(cube);
      processedNames.add(name);

      // If a new auto cube has the same name, the user cube wins (collision).
      // The auto cube is skipped.
      continue;
    }

    // Auto-generated existing cube
    const newCube = newByName.get(name);

    if (newCube) {
      // Matching name in new generation — merge per field-level rules
      mergedCubes.push(mergeCube(cube, newCube, keepStale));
      processedNames.add(name);
    } else {
      // Auto cube with no match in new generation — remove it
      // (e.g., array deselected, cube no longer generated)
    }
  }

  // 2. Add new cubes not present in existing
  for (const cube of newCubes) {
    if (!processedNames.has(cube.name)) {
      // Check for name collision with a user-created cube (already handled above,
      // but guard against edge cases)
      const existing = existingByName.get(cube.name);
      if (existing && !isAutoCube(existing)) {
        // User cube already preserved — skip the auto cube
        continue;
      }
      mergedCubes.push(cube);
    }
  }

  // Reconstruct the document preserving any top-level keys beyond `cubes`
  const result = { ...newDoc, cubes: mergedCubes };
  return result;
}

// ---------------------------------------------------------------------------
// Auto strategy
// ---------------------------------------------------------------------------

/**
 * Determine whether the existing model is a smart-generated model
 * (has provenance metadata with `auto_generated` tags).
 */
function isSmartGenerated(doc) {
  const cubes = doc?.cubes;
  if (!Array.isArray(cubes) || cubes.length === 0) return false;
  return cubes.some((c) => isAutoCube(c));
}

/**
 * Implements the "auto" strategy decision logic.
 *
 * - Standard-generated model (no auto_generated tags) → replace
 * - Smart-generated with no user content → replace
 * - Smart-generated with user content → merge
 *
 * @param {object} existingDoc - Parsed existing YAML
 * @param {string} newYaml - New YAML string (returned as-is for replace)
 * @param {object} newDoc - Parsed new YAML
 * @returns {string} Resulting YAML string
 */
function autoStrategy(existingDoc, newYaml, newDoc) {
  if (!isSmartGenerated(existingDoc)) {
    // Standard-generated or hand-written model — replace entirely
    return newYaml;
  }

  // Smart-generated model — check for user content
  const cubes = existingDoc.cubes || [];
  const hasUser = cubes.some((c) => cubeHasUserContent(c));

  if (!hasUser) {
    // No user content — safe to replace
    return newYaml;
  }

  // Has user content — merge (preserving user work)
  const merged = mergeDocuments(existingDoc, newDoc, false);
  return YAML.stringify(merged);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge an existing YAML model with a newly generated one using the specified strategy.
 *
 * @param {string} existingYaml - Current YAML model content
 * @param {string} newYaml - Newly generated YAML content
 * @param {string} [strategy="auto"] - "auto", "merge", "replace", or "merge_keep_stale"
 * @returns {string} Merged YAML content
 */
export function mergeModels(existingYaml, newYaml, strategy = 'auto') {
  // --- Replace: return new YAML as-is ---
  if (strategy === 'replace') {
    return newYaml;
  }

  // Parse both documents
  let existingDoc;
  try {
    existingDoc = YAML.parse(existingYaml);
  } catch {
    // Cannot parse existing — fall back to replacement
    return newYaml;
  }

  let newDoc;
  try {
    newDoc = YAML.parse(newYaml);
  } catch {
    // Cannot parse new YAML — should not happen, but return it raw
    return newYaml;
  }

  // --- Auto strategy ---
  if (strategy === 'auto') {
    return autoStrategy(existingDoc, newYaml, newDoc);
  }

  // --- Merge / Merge-keep-stale ---
  const keepStale = strategy === 'merge_keep_stale';
  const merged = mergeDocuments(existingDoc, newDoc, keepStale);
  return YAML.stringify(merged);
}
