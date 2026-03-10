/**
 * Diff Models — computes a structured diff between existing and newly generated
 * Cube.js YAML models, reporting what would change during a merge operation.
 *
 * Used to preview changes before applying a smart model regeneration.
 */

import YAML from 'yaml';
import { hasUserContent } from './merger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAutoField(field) {
  return field?.meta?.auto_generated === true;
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

  if (isReplace) {
    // Replace strategy: everything existing is removed, everything new is added
    for (const field of existing) {
      removed.push({ name: field.name, type: field.type, member_type: memberType, cube: cubeName });
    }
    for (const field of incoming) {
      added.push({ name: field.name, type: field.type, member_type: memberType, cube: cubeName });
    }
    return { added, updated, removed, preserved };
  }

  // Merge strategy
  const newMap = fieldsByName(incoming);
  const existingMap = fieldsByName(existing);
  const handledNames = new Set();

  for (const field of existing) {
    const name = field.name;
    handledNames.add(name);

    if (!isAutoField(field)) {
      // User-created field — always preserved
      preserved.push({ name, member_type: memberType, cube: cubeName, reason: 'user_created' });
      continue;
    }

    // Auto-generated field
    const newField = newMap.get(name);

    if (newField) {
      // Check for edited description
      if (field.description && field.description !== (newField.description ?? undefined)) {
        preserved.push({ name, member_type: memberType, cube: cubeName, reason: 'edited_description' });
      } else {
        updated.push({ name: newField.name, type: newField.type, member_type: memberType, cube: cubeName });
      }
    } else {
      // Auto field no longer generated — removed
      removed.push({ name: field.name, type: field.type, member_type: memberType, cube: cubeName });
    }
  }

  // New fields not in existing
  for (const field of incoming) {
    if (!handledNames.has(field.name)) {
      added.push({ name: field.name, type: field.type, member_type: memberType, cube: cubeName });
    }
  }

  return { added, updated, removed, preserved };
}

// ---------------------------------------------------------------------------
// Preserved blocks detection
// ---------------------------------------------------------------------------

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

function buildSummary(added, updated, removed, preserved, blocksPreserved) {
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

  return summary;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a structured diff between existing YAML model and newly generated YAML.
 *
 * @param {string|null} existingYaml - Current YAML model content (null if new)
 * @param {string} newYaml - Newly generated YAML content
 * @param {string} [mergeStrategy="auto"] - "auto", "merge", or "replace"
 * @returns {{ fields_added, fields_updated, fields_removed, fields_preserved, blocks_preserved, summary }}
 */
export function diffModels(existingYaml, newYaml, mergeStrategy = 'auto') {
  const result = {
    fields_added: [],
    fields_updated: [],
    fields_removed: [],
    fields_preserved: [],
    blocks_preserved: [],
    summary: '',
  };

  // Parse new YAML
  let newDoc;
  try {
    newDoc = YAML.parse(newYaml);
  } catch {
    result.summary = 'Cannot parse new YAML.';
    return result;
  }

  const newCubes = Array.isArray(newDoc?.cubes) ? newDoc.cubes : [];

  // No existing model — everything is added
  if (!existingYaml || typeof existingYaml !== 'string' || existingYaml.trim() === '') {
    for (const cube of newCubes) {
      const cubeName = cube.name;
      for (const dim of Array.isArray(cube.dimensions) ? cube.dimensions : []) {
        result.fields_added.push({ name: dim.name, type: dim.type, member_type: 'dimension', cube: cubeName });
      }
      for (const meas of Array.isArray(cube.measures) ? cube.measures : []) {
        result.fields_added.push({ name: meas.name, type: meas.type, member_type: 'measure', cube: cubeName });
      }
    }
    result.summary = buildSummary(result.fields_added, [], [], [], []);
    return result;
  }

  // Parse existing YAML
  let existingDoc;
  try {
    existingDoc = YAML.parse(existingYaml);
  } catch {
    // Can't parse existing — treat as empty, everything is added
    for (const cube of newCubes) {
      const cubeName = cube.name;
      for (const dim of Array.isArray(cube.dimensions) ? cube.dimensions : []) {
        result.fields_added.push({ name: dim.name, type: dim.type, member_type: 'dimension', cube: cubeName });
      }
      for (const meas of Array.isArray(cube.measures) ? cube.measures : []) {
        result.fields_added.push({ name: meas.name, type: meas.type, member_type: 'measure', cube: cubeName });
      }
    }
    result.summary = buildSummary(result.fields_added, [], [], [], []);
    return result;
  }

  const existingCubes = Array.isArray(existingDoc?.cubes) ? existingDoc.cubes : [];

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
        result.fields_added.push({ name: dim.name, type: dim.type, member_type: 'dimension', cube: cubeName });
      }
      for (const meas of Array.isArray(newCube.measures) ? newCube.measures : []) {
        result.fields_added.push({ name: meas.name, type: meas.type, member_type: 'measure', cube: cubeName });
      }
    }
  }

  result.summary = buildSummary(result.fields_added, result.fields_updated, result.fields_removed, result.fields_preserved, result.blocks_preserved);
  return result;
}
