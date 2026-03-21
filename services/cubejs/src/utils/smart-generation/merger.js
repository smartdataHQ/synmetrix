/**
 * Smart Merger — field-level merge for re-profiling existing Cube.js YAML models.
 *
 * Implements four strategies: auto, merge, replace, merge_keep_stale.
 * See specs/004-dynamic-model-creation/data-model.md for full merge rules.
 */

import { createContext, runInContext } from 'node:vm';
import YAML from 'yaml';
import { generateJs } from './yamlGenerator.js';

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
 * Check whether a single field is AI-generated.
 */
function isAIField(field) {
  return field?.meta?.ai_generated === true;
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
    if (isAIField(field)) {
      // AI-generated field — not user content, but a distinct category
      // Treated as "has user content" for merge purposes to ensure preservation
      return true;
    }
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
export function hasUserContent(content) {
  if (!content || typeof content !== 'string') return false;

  const doc = parseContent(content);
  if (!doc) {
    // Cannot parse — treat as having user content (safest default)
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

    if (isAIField(field)) {
      // AI-generated field — always preserve (superset guarantee)
      // User description edits are preserved
      merged.push(field);
      handledNames.add(name);
      continue;
    }

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
      'generation_filters',
      'ai_enrichment_status',
      'ai_metrics_count',
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
function autoStrategy(existingDoc, newYaml, newDoc, outputJs = false) {
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
  return outputJs ? generateJs(merged.cubes || []) : YAML.stringify(merged);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JS cube file parser (mirrors diffModels.js parseCubesFromJs)
// ---------------------------------------------------------------------------

function createDeepProxy() {
  const handler = {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => 'PROXY';
      if (prop === Symbol.iterator) return undefined;
      if (prop === 'toString' || prop === 'valueOf') return () => 'PROXY';
      return createDeepProxy();
    },
    apply() {
      return createDeepProxy();
    },
  };
  return new Proxy(function () {}, handler);
}

function objectFieldsToArray(fields) {
  if (Array.isArray(fields)) return fields;
  if (!fields || typeof fields !== 'object') return [];
  return Object.entries(fields).map(([name, def]) => ({ name, ...def }));
}

function parseCubesFromJs(jsContent) {
  const cubes = [];
  const mockCube = (name, def) => {
    cubes.push({
      name,
      ...def,
      dimensions: objectFieldsToArray(def.dimensions),
      measures: objectFieldsToArray(def.measures),
      joins: objectFieldsToArray(def.joins),
      segments: objectFieldsToArray(def.segments),
      pre_aggregations: objectFieldsToArray(def.pre_aggregations),
    });
  };
  try {
    const context = createContext({
      cube: mockCube,
      CUBE: '{CUBE}',
      FILTER_PARAMS: createDeepProxy(),
      SQL_UTILS: createDeepProxy(),
    });
    runInContext(jsContent, context);
  } catch {
    return null;
  }
  return cubes.length > 0 ? cubes : null;
}

/**
 * Parse content as YAML or JS cubes.
 */
function parseContent(content) {
  if (!content || typeof content !== 'string') return null;

  // Try YAML first
  try {
    const doc = YAML.parse(content);
    if (doc && typeof doc === 'object') return doc;
  } catch {
    // Not YAML
  }

  // Try JS
  const jsCubes = parseCubesFromJs(content);
  if (jsCubes) return { cubes: jsCubes };

  return null;
}

// ---------------------------------------------------------------------------
// Extract AI metrics from a model
// ---------------------------------------------------------------------------

/**
 * Extract all AI-generated metrics from an existing model.
 *
 * @param {string} existingContent - YAML or JS model content
 * @returns {object[]} Array of fields with `meta.ai_generated === true`
 */
export function extractAIMetrics(existingContent) {
  const doc = parseContent(existingContent);
  if (!doc || !Array.isArray(doc.cubes)) return [];

  const aiMetrics = [];
  for (const cube of doc.cubes) {
    for (const field of [...(cube.dimensions || []), ...(cube.measures || [])]) {
      if (isAIField(field)) {
        aiMetrics.push({
          ...field,
          _cubeName: cube.name,
        });
      }
    }
  }
  return aiMetrics;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge an existing model with a newly generated one using the specified strategy.
 * Supports both YAML and JS model formats.
 *
 * @param {string} existingContent - Current YAML or JS model content
 * @param {string} newContent - Newly generated YAML or JS content
 * @param {string} [strategy="auto"] - "auto", "merge", "replace", or "merge_keep_stale"
 * @returns {string} Merged content
 */
export function mergeModels(existingContent, newContent, strategy = 'auto') {
  // --- Replace: return new content as-is ---
  if (strategy === 'replace') {
    return newContent;
  }

  // Detect output format from new content — JS if it contains cube() calls
  const outputJs = /\bcube\s*\(/.test(newContent);

  // Parse both documents (supports YAML and JS)
  const existingDoc = parseContent(existingContent);
  if (!existingDoc) {
    // Cannot parse existing — fall back to replacement
    return newContent;
  }

  const newDoc = parseContent(newContent);
  if (!newDoc) {
    // Cannot parse new content — should not happen, but return it raw
    return newContent;
  }

  // --- Auto strategy ---
  if (strategy === 'auto') {
    return autoStrategy(existingDoc, newContent, newDoc, outputJs);
  }

  // --- Merge / Merge-keep-stale ---
  const keepStale = strategy === 'merge_keep_stale';
  const merged = mergeDocuments(existingDoc, newDoc, keepStale);
  return outputJs ? generateJs(merged.cubes || []) : YAML.stringify(merged);
}
