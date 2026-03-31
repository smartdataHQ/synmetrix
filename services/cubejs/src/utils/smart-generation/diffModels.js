/**
 * Diff Models — computes a structured diff between existing and newly generated
 * Cube.js YAML models, reporting what would change during a merge operation.
 *
 * Used to preview changes before applying a smart model regeneration.
 */

import { createContext, runInContext } from 'node:vm';
import YAML from 'yaml';
import { hasUserContent } from './merger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAutoField(field) {
  return field?.meta?.auto_generated === true;
}

function isAIField(field) {
  return field?.meta?.ai_generated === true;
}

/**
 * Derive a source tag from a field's meta object.
 * Used by the frontend to decide default selection (e.g. map fields are opt-in).
 */
function fieldSource(field) {
  if (field?.meta?.map_key) return 'map';
  if (field?.meta?.source_group) return 'nested';
  if (field?.meta?.ai_generated) return 'ai';
  return undefined;
}

function isAutoCube(cube) {
  return cube?.meta?.auto_generated === true;
}

function fieldsByName(fields) {
  const map = new Map();
  if (!Array.isArray(fields)) return map;
  for (const f of fields) {
    if (f?.name) map.set(f.name, f);
  }
  return map;
}

/**
 * Check whether a smart-generated existing doc should be replaced or merged
 * under the "auto" strategy (mirrors merger.js autoStrategy logic).
 */
function autoWouldReplace(existingDoc) {
  const cubes = existingDoc?.cubes;
  if (!Array.isArray(cubes) || cubes.length === 0) return true;

  // If no cube has auto_generated tag, it's standard-generated -> replace
  const hasAuto = cubes.some((c) => isAutoCube(c));
  if (!hasAuto) return true;

  // If no cube has user content, safe to replace
  const hasUser = cubes.some((cube) => {
    // Check preserve-worthy blocks
    if (Array.isArray(cube.joins) && cube.joins.length > 0) return true;
    if (Array.isArray(cube.pre_aggregations) && cube.pre_aggregations.length > 0) return true;
    if (Array.isArray(cube.segments) && cube.segments.length > 0) return true;

    const allFields = [
      ...(Array.isArray(cube.dimensions) ? cube.dimensions : []),
      ...(Array.isArray(cube.measures) ? cube.measures : []),
    ];
    for (const field of allFields) {
      if (!isAutoField(field)) return true;
      if (field.description) return true;
    }
    return false;
  });

  return !hasUser;
}

// ---------------------------------------------------------------------------
// Diff computation for a single field list (dimensions or measures)
// ---------------------------------------------------------------------------

/**
 * Diff a single field list between existing and new cubes.
 *
 * @param {Array} existingFields
 * @param {Array} newFields
 * @param {string} memberType - "dimension" or "measure"
 * @param {string} cubeName
 * @param {boolean} isReplace - If true, all existing are removed, all new are added
 * @returns {{ added, updated, removed, preserved }}
 */
function diffFields(existingFields, newFields, memberType, cubeName, isReplace) {
  const existing = Array.isArray(existingFields) ? existingFields : [];
  const incoming = Array.isArray(newFields) ? newFields : [];

  const added = [];
  const updated = [];
  const removed = [];
  const preserved = [];

  // Always compute a meaningful diff — even under replace strategy.
  // The strategy affects what the merger DOES (overwrite vs preserve),
  // but the preview should show what actually CHANGES.
  const newMap = fieldsByName(incoming);
  const handledNames = new Set();

  for (const field of existing) {
    const name = field.name;
    handledNames.add(name);

    const newField = newMap.get(name);

    if (!isReplace && isAIField(field)) {
      // AI-generated field under merge — preserved as distinct category
      preserved.push({ name, member_type: memberType, cube: cubeName, reason: 'ai_generated' });
      continue;
    }

    if (!isReplace && !isAutoField(field)) {
      // User-created field under merge — always preserved
      preserved.push({ name, member_type: memberType, cube: cubeName, reason: 'user_created' });
      continue;
    }

    if (newField) {
      // Field exists in both — check if it actually changed
      if (!isReplace && field.description && field.description !== (newField.description ?? undefined)) {
        preserved.push({ name, member_type: memberType, cube: cubeName, reason: 'edited_description' });
      } else if (field.type !== newField.type) {
        updated.push({ name: newField.name, type: newField.type, member_type: memberType, cube: cubeName, old_type: field.type });
      }
      // else: same name, same type — unchanged, not shown
    } else {
      // Field no longer generated — removed
      removed.push({ name: field.name, type: field.type, member_type: memberType, cube: cubeName });
    }
  }

  // New fields not in existing
  for (const field of incoming) {
    if (!handledNames.has(field.name)) {
      const entry = { name: field.name, type: field.type, member_type: memberType, cube: cubeName };
      const src = fieldSource(field);
      if (src) entry.source = src;
      added.push(entry);
    }
  }

  return { added, updated, removed, preserved };
}

// ---------------------------------------------------------------------------
// Preserved blocks detection
// ---------------------------------------------------------------------------

/**
 * Build an AI metric entry for the ai_metrics_* arrays.
 */
function aiMetricEntry(field, cubeName) {
  return {
    name: field.name,
    type: field.type,
    member_type: field.fieldType || (field.sql && /count|sum|avg|min|max/i.test(field.type) ? 'measure' : 'dimension'),
    cube: cubeName,
    ai_generation_context: field.ai_generation_context || null,
  };
}

/**
 * Categorize AI fields from a field list diff.
 * Returns { added, retained, removed } AI metric arrays.
 */
function categorizeAIFields(existingFields, newFields, cubeName) {
  const existing = Array.isArray(existingFields) ? existingFields : [];
  const incoming = Array.isArray(newFields) ? newFields : [];

  const newMap = fieldsByName(incoming);
  const existingMap = fieldsByName(existing);

  const added = [];
  const retained = [];
  const handledNames = new Set();

  // Check existing AI fields
  for (const field of existing) {
    if (!isAIField(field)) continue;
    handledNames.add(field.name);

    // AI field in existing — retained (merger always preserves AI fields)
    retained.push(aiMetricEntry(field, cubeName));
  }

  // Check new AI fields
  for (const field of incoming) {
    if (!isAIField(field)) continue;
    if (handledNames.has(field.name)) continue;

    // AI field only in new — added
    added.push(aiMetricEntry(field, cubeName));
  }

  return { added, retained, removed: [] };
}

function getPreservedBlocks(cube, cubeName) {
  const blocks = [];
  if (Array.isArray(cube.joins) && cube.joins.length > 0) {
    blocks.push({ block: 'joins', cube: cubeName });
  }
  if (Array.isArray(cube.pre_aggregations) && cube.pre_aggregations.length > 0) {
    blocks.push({ block: 'pre_aggregations', cube: cubeName });
  }
  if (Array.isArray(cube.segments) && cube.segments.length > 0) {
    blocks.push({ block: 'segments', cube: cubeName });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(added, updated, removed, preserved, blocksPreserved, aiAdded = [], aiRetained = [], aiRemoved = []) {
  const parts = [];

  if (added.length > 0) {
    parts.push(`Adding ${added.length} field${added.length !== 1 ? 's' : ''}`);
  }
  if (updated.length > 0) {
    parts.push(`updating ${updated.length}`);
  }
  if (removed.length > 0) {
    parts.push(`removing ${removed.length}`);
  }

  let summary = parts.length > 0 ? parts.join(', ') + '.' : 'No field changes.';

  const preservedParts = [];
  if (preserved.length > 0) {
    preservedParts.push(`${preserved.length} user field${preserved.length !== 1 ? 's' : ''}`);
  }
  if (blocksPreserved.length > 0) {
    const blockNames = [...new Set(blocksPreserved.map((b) => b.block))];
    preservedParts.push(blockNames.join(', '));
  }

  if (preservedParts.length > 0) {
    summary += ` Preserving ${preservedParts.join(' and ')}.`;
  }

  // AI metrics summary
  const aiParts = [];
  if (aiAdded.length > 0) {
    aiParts.push(`${aiAdded.length} added`);
  }
  if (aiRetained.length > 0) {
    aiParts.push(`${aiRetained.length} retained`);
  }
  if (aiRemoved.length > 0) {
    aiParts.push(`${aiRemoved.length} removed`);
  }
  if (aiParts.length > 0) {
    summary += ` AI metrics: ${aiParts.join(', ')}.`;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JS cube file parser — evaluates cube(`name`, { ... }) in a sandbox
// ---------------------------------------------------------------------------

/**
 * Create a deeply-nested proxy that returns itself for any property access
 * or function call. Used to mock FILTER_PARAMS and other template globals
 * so that template literals like `${FILTER_PARAMS.cube.field.filter(...)}`
 * resolve to a string instead of throwing.
 */
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

/**
 * Convert JS cube object-format fields to array format for diffing.
 * JS: dimensions: { field_name: { sql, type, meta } }
 * Array: [{ name: 'field_name', sql, type, meta }]
 */
function objectFieldsToArray(fields) {
  if (Array.isArray(fields)) return fields;
  if (!fields || typeof fields !== 'object') return [];
  return Object.entries(fields).map(([name, def]) => ({ name, ...def }));
}

/**
 * Parse cube definitions from a JS cube file string.
 * Evaluates in a VM sandbox with mock cube() function.
 */
export function parseCubesFromJs(jsContent) {
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

// ---------------------------------------------------------------------------
// Content parser — YAML, JS, or pre-parsed arrays
// ---------------------------------------------------------------------------

/**
 * Parse cube definitions from content — supports YAML strings, JS cube files,
 * or pre-parsed cube arrays.
 *
 * @param {string|Array|null} content
 * @returns {{ cubes: Array|null, doc: object|null }} cubes array or null if unparseable
 */
function parseCubeContent(content) {
  if (!content) return { cubes: null, doc: null };

  // Already structured cube array (from cubeBuilder output)
  if (Array.isArray(content)) {
    return { cubes: content, doc: { cubes: content } };
  }

  if (typeof content !== 'string' || content.trim() === '') {
    return { cubes: null, doc: null };
  }

  // Try YAML first
  try {
    const doc = YAML.parse(content);
    if (doc && Array.isArray(doc.cubes)) {
      return { cubes: doc.cubes, doc };
    }
  } catch {
    // Not YAML — continue
  }

  // Try JS cube format
  const jsCubes = parseCubesFromJs(content);
  if (jsCubes) {
    return { cubes: jsCubes, doc: { cubes: jsCubes } };
  }

  return { cubes: null, doc: null };
}

/**
 * Compute a structured diff between existing and newly generated cube models.
 *
 * Accepts YAML strings, JS strings, or pre-parsed cube definition arrays.
 * When content can't be parsed (e.g. JS format), treats it as empty.
 *
 * @param {string|Array|null} existingContent - Current model content or cube array (null if new)
 * @param {string|Array} newContent - Newly generated content or cube array
 * @param {string} [mergeStrategy="auto"] - "auto", "merge", or "replace"
 * @returns {{ fields_added, fields_updated, fields_removed, fields_preserved, blocks_preserved, summary }}
 */
export function diffModels(existingContent, newContent, mergeStrategy = 'auto') {
  const result = {
    fields_added: [],
    fields_updated: [],
    fields_removed: [],
    fields_preserved: [],
    blocks_preserved: [],
    ai_metrics_added: [],
    ai_metrics_retained: [],
    ai_metrics_removed: [],
    summary: '',
  };

  // Parse new content
  const { cubes: newCubes } = parseCubeContent(newContent);
  if (!newCubes) {
    result.summary = 'Cannot parse new model content.';
    return result;
  }

  // Parse existing content
  const { cubes: existingCubes, doc: existingDoc } = parseCubeContent(existingContent);

  // No existing model (null, empty, or unparseable JS) — everything is added
  if (!existingCubes) {
    for (const cube of newCubes) {
      const cubeName = cube.name;
      for (const dim of Array.isArray(cube.dimensions) ? cube.dimensions : []) {
        const entry = { name: dim.name, type: dim.type, member_type: 'dimension', cube: cubeName };
        const src = fieldSource(dim);
        if (src) entry.source = src;
        result.fields_added.push(entry);
        if (isAIField(dim)) {
          result.ai_metrics_added.push(aiMetricEntry(dim, cubeName));
        }
      }
      for (const meas of Array.isArray(cube.measures) ? cube.measures : []) {
        const entry = { name: meas.name, type: meas.type, member_type: 'measure', cube: cubeName };
        const src = fieldSource(meas);
        if (src) entry.source = src;
        result.fields_added.push(entry);
        if (isAIField(meas)) {
          result.ai_metrics_added.push(aiMetricEntry(meas, cubeName));
        }
      }
    }
    result.summary = buildSummary(
      result.fields_added, [], [], [], [],
      result.ai_metrics_added, [], [],
    );
    return result;
  }

  // Determine effective strategy
  let isReplace = mergeStrategy === 'replace';

  if (mergeStrategy === 'auto') {
    isReplace = autoWouldReplace(existingDoc);
  }

  // Build cube lookup maps
  const existingByName = new Map();
  for (const cube of existingCubes) {
    if (cube?.name) existingByName.set(cube.name, cube);
  }

  const newByName = new Map();
  for (const cube of newCubes) {
    if (cube?.name) newByName.set(cube.name, cube);
  }

  const processedCubes = new Set();

  // Walk existing cubes
  for (const existingCube of existingCubes) {
    const cubeName = existingCube.name;
    processedCubes.add(cubeName);

    const newCube = newByName.get(cubeName);

    if (!newCube) {
      if (isReplace) {
        // Entire cube removed under replace
        for (const dim of Array.isArray(existingCube.dimensions) ? existingCube.dimensions : []) {
          result.fields_removed.push({ name: dim.name, type: dim.type, member_type: 'dimension', cube: cubeName });
        }
        for (const meas of Array.isArray(existingCube.measures) ? existingCube.measures : []) {
          result.fields_removed.push({ name: meas.name, type: meas.type, member_type: 'measure', cube: cubeName });
        }
      } else {
        // Merge: auto cubes without match are removed; user cubes preserved
        if (!isAutoCube(existingCube)) {
          // User cube with no match — preserved entirely (not in new generation scope)
          // We don't list its fields since it's untouched
        } else {
          for (const dim of Array.isArray(existingCube.dimensions) ? existingCube.dimensions : []) {
            result.fields_removed.push({ name: dim.name, type: dim.type, member_type: 'dimension', cube: cubeName });
          }
          for (const meas of Array.isArray(existingCube.measures) ? existingCube.measures : []) {
            result.fields_removed.push({ name: meas.name, type: meas.type, member_type: 'measure', cube: cubeName });
          }
        }
      }
      continue;
    }

    // Cube exists in both — diff fields
    const dimDiff = diffFields(existingCube.dimensions, newCube.dimensions, 'dimension', cubeName, isReplace);
    const measDiff = diffFields(existingCube.measures, newCube.measures, 'measure', cubeName, isReplace);

    result.fields_added.push(...dimDiff.added, ...measDiff.added);
    result.fields_updated.push(...dimDiff.updated, ...measDiff.updated);
    result.fields_removed.push(...dimDiff.removed, ...measDiff.removed);
    result.fields_preserved.push(...dimDiff.preserved, ...measDiff.preserved);

    // AI metric categorization
    if (!isReplace) {
      const dimAI = categorizeAIFields(existingCube.dimensions, newCube.dimensions, cubeName);
      const measAI = categorizeAIFields(existingCube.measures, newCube.measures, cubeName);
      result.ai_metrics_added.push(...dimAI.added, ...measAI.added);
      result.ai_metrics_retained.push(...dimAI.retained, ...measAI.retained);
      result.ai_metrics_removed.push(...dimAI.removed, ...measAI.removed);
    }

    // Preserved blocks (only relevant for merge)
    if (!isReplace) {
      result.blocks_preserved.push(...getPreservedBlocks(existingCube, cubeName));
    }
  }

  // New cubes not in existing — all fields are added
  for (const newCube of newCubes) {
    if (!processedCubes.has(newCube.name)) {
      const cubeName = newCube.name;
      for (const dim of Array.isArray(newCube.dimensions) ? newCube.dimensions : []) {
        const entry = { name: dim.name, type: dim.type, member_type: 'dimension', cube: cubeName };
        const src = fieldSource(dim);
        if (src) entry.source = src;
        result.fields_added.push(entry);
        if (isAIField(dim)) {
          result.ai_metrics_added.push(aiMetricEntry(dim, cubeName));
        }
      }
      for (const meas of Array.isArray(newCube.measures) ? newCube.measures : []) {
        const entry = { name: meas.name, type: meas.type, member_type: 'measure', cube: cubeName };
        const src = fieldSource(meas);
        if (src) entry.source = src;
        result.fields_added.push(entry);
        if (isAIField(meas)) {
          result.ai_metrics_added.push(aiMetricEntry(meas, cubeName));
        }
      }
    }
  }

  result.summary = buildSummary(
    result.fields_added, result.fields_updated, result.fields_removed,
    result.fields_preserved, result.blocks_preserved,
    result.ai_metrics_added, result.ai_metrics_retained, result.ai_metrics_removed,
  );
  return result;
}
