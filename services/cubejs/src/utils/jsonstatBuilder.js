const TIME_COLUMN_RE = /^(year|date|month|quarter|period|time|day|week)/i;
const DEFAULT_VALUE_FORMAT = "auto";
const DEFAULT_SPARSE_THRESHOLD = 0.5;
const DEFAULT_MIN_SPARSE_CELLS = 256;
const DEFAULT_MAX_DENSE_CELLS = 1_000_000;
const DEFAULT_DUPLICATE_POLICY = "aggregate";
const DEFAULT_CATEGORY_INDEX_FORMAT = "object";

/**
 * Builds a JSON-Stat 2.0 dataset object from tabular query results.
 *
 * Optimizations:
 * - typed category identity to avoid value-collision bugs
 * - explicit-measure fast path to skip heuristic-only work
 * - adaptive dense/sparse value encoding
 * - dense-cell guard for pathological cubes
 * - compact metadata options for category index/labels
 *
 * @param {Array<Object>} rows - Array of row objects
 * @param {string[]} columns - Column names (may contain duplicates)
 * @param {Object} [options] - Classification and encoding hints
 * @param {string[]} [options.measures] - Columns to treat as measures
 * @param {string[]} [options.timeDimensions] - Columns to treat as time dimensions
 * @param {string[]} [options.dimensions] - Optional explicit dimension order
 * @param {"auto"|"dense"|"sparse"} [options.valueFormat]
 * @param {number} [options.sparseThreshold]
 * @param {number} [options.minSparseCells]
 * @param {number} [options.maxDenseCells]
 * @param {"aggregate"|"last"|"error"} [options.duplicatePolicy]
 * @param {"object"|"array"} [options.categoryIndexFormat]
 * @param {boolean} [options.includeCategoryLabels]
 * @param {string} [options.metricDimensionId]
 * @returns {Object} JSON-Stat 2.0 dataset or error object
 */
export function buildJSONStat(rows, columns, options) {
  const opts = options ?? {};
  const cols = columns ?? [];
  const workSourceRows = rows ?? [];

  if (workSourceRows.length === 0 && cols.length === 0) {
    return { error: "Cannot produce JSON-Stat from empty result with no columns.", status: 400 };
  }

  const valueFormat = opts.valueFormat ?? DEFAULT_VALUE_FORMAT;
  const sparseThreshold = normalizeFiniteNumber(opts.sparseThreshold, DEFAULT_SPARSE_THRESHOLD);
  const minSparseCells = Math.max(0, normalizeFiniteInteger(opts.minSparseCells, DEFAULT_MIN_SPARSE_CELLS));
  const maxDenseCells = Math.max(1, normalizeFiniteInteger(opts.maxDenseCells, DEFAULT_MAX_DENSE_CELLS));
  const duplicatePolicy = opts.duplicatePolicy ?? DEFAULT_DUPLICATE_POLICY;
  const categoryIndexFormat = opts.categoryIndexFormat ?? DEFAULT_CATEGORY_INDEX_FORMAT;
  const includeCategoryLabels = opts.includeCategoryLabels !== false;

  const {
    dedupedCols,
    needsRemap,
    originalToDeduped,
  } = dedupeColumns(cols);

  let workRows = workSourceRows;
  if (needsRemap && workSourceRows.length > 0) {
    workRows = remapRows(workSourceRows, cols, dedupedCols);
  }

  const numRows = workRows.length;
  const numCols = dedupedCols.length;
  const warnings = [];

  const explicitMeasures = resolveExplicitNames(opts.measures, originalToDeduped);
  const explicitTime = resolveExplicitNames(opts.timeDimensions, originalToDeduped);

  let activeIndices;
  let measureSet;
  let timeDimSet;
  let dimCols;
  let measureCols;
  let dimColIndices;
  let binaryNames;
  let categoryMapsByColumn = null;
  let categoryValuesByColumn = null;

  if (explicitMeasures) {
    const scan = scanRowsWithExplicitMeasures(workRows, dedupedCols, explicitMeasures);
    activeIndices = scan.activeIndices;
    binaryNames = scan.binaryNames;
    categoryMapsByColumn = scan.categoryMapsByColumn;
    categoryValuesByColumn = scan.categoryValuesByColumn;
    measureSet = filterToActive(explicitMeasures, activeIndices, dedupedCols);
    timeDimSet = explicitTime
      ? filterToActive(explicitTime, activeIndices, dedupedCols)
      : inferTimeDimensions(activeIndices, dedupedCols, measureSet);

    if (!explicitTime) {
      warnings.push(
        "Column classification was inferred heuristically for time dimensions. Supply options.timeDimensions for exact control."
      );
    }

    ({
      dimCols,
      measureCols,
      dimColIndices,
    } = splitColumns(activeIndices, dedupedCols, measureSet));
  } else {
    const scan = scanRowsForTypeInference(workRows, dedupedCols);
    activeIndices = scan.activeIndices;
    binaryNames = scan.binaryNames;
    measureSet = inferMeasureColumns(activeIndices, dedupedCols, scan.isNumeric, scan.hasSample);
    timeDimSet = explicitTime
      ? filterToActive(explicitTime, activeIndices, dedupedCols)
      : inferTimeDimensions(activeIndices, dedupedCols, measureSet);

    warnings.push(
      "Column classification was inferred heuristically. Supply options.measures and options.timeDimensions for exact control."
    );

    ({
      dimCols,
      measureCols,
      dimColIndices,
    } = splitColumns(activeIndices, dedupedCols, measureSet));
  }

  if (binaryNames.length > 0) {
    warnings.push(`Binary columns omitted from JSON-Stat output: ${binaryNames.join(", ")}`);
  }

  const dimOrderOverride = resolveExplicitNames(opts.dimensions, originalToDeduped);
  if (dimOrderOverride && dimCols.length > 0) {
    ({ dimCols, dimColIndices } = applyDimensionOrderOverride(dimCols, dimColIndices, dimOrderOverride));
  }

  const metricDimensionId = measureCols.length > 0
    ? makeUniqueMetricDimensionId(dimCols, opts.metricDimensionId)
    : null;

  if (numRows === 0) {
    return buildEmptyDataset(
      dimCols,
      measureCols,
      timeDimSet,
      warnings,
      metricDimensionId,
      categoryIndexFormat,
      includeCategoryLabels
    );
  }

  let dimensionCategories;
  if (categoryMapsByColumn) {
    dimensionCategories = extractCollectedCategories(dimColIndices, categoryMapsByColumn, categoryValuesByColumn);
  } else {
    dimensionCategories = collectDimensionCategories(workRows, dimCols);
  }

  const numDims = dimCols.length;
  const numMeasures = measureCols.length;
  const effectiveMeasureCount = numMeasures > 0 ? numMeasures : 1;
  const dimSizes = new Array(numDims);
  const strides = new Array(numDims);
  let tupleCount = 1;

  for (let d = 0; d < numDims; d++) {
    dimSizes[d] = dimensionCategories.values[d].length;
    tupleCount *= dimSizes[d];
  }

  let stride = effectiveMeasureCount;
  for (let d = numDims - 1; d >= 0; d--) {
    strides[d] = stride;
    stride *= dimSizes[d];
  }

  const totalCells = tupleCount * effectiveMeasureCount;
  const mergeResult = mergeRowsToOffsets(
    workRows,
    dimCols,
    measureCols,
    dimensionCategories.maps,
    strides,
    duplicatePolicy
  );
  if (mergeResult.error) {
    return mergeResult.error;
  }
  if (mergeResult.duplicateCount > 0) {
    warnings.push(duplicatePolicyWarning(duplicatePolicy, mergeResult.duplicateCount));
  }

  const populatedCellCount = numMeasures > 0
    ? mergeResult.offsetMap.size * numMeasures
    : mergeResult.offsetMap.size;
  const density = totalCells > 0 ? populatedCellCount / totalCells : 0;
  const sparseDecision = resolveValueEncoding(
    valueFormat,
    totalCells,
    density,
    sparseThreshold,
    minSparseCells,
    maxDenseCells
  );
  if (sparseDecision.error) {
    return sparseDecision.error;
  }
  if (sparseDecision.warning) {
    warnings.push(sparseDecision.warning);
  }

  const value = sparseDecision.useSparse
    ? buildSparseValueObject(mergeResult.offsetMap, numMeasures)
    : buildDenseValueArray(totalCells, mergeResult.offsetMap, numMeasures);

  const id = new Array(numDims + (numMeasures > 0 ? 1 : 0));
  const size = new Array(id.length);
  const dimension = Object.create(null);
  const role = Object.create(null);
  const roleTime = [];

  for (let d = 0; d < numDims; d++) {
    const dimId = dimCols[d];
    id[d] = dimId;
    size[d] = dimSizes[d];
    dimension[dimId] = {
      label: dimId,
      category: buildCategoryMetadata(
        dimensionCategories.values[d],
        categoryIndexFormat,
        includeCategoryLabels
      ),
    };
    if (timeDimSet.has(dimId)) {
      roleTime.push(dimId);
    }
  }

  if (numMeasures > 0) {
    const pos = numDims;
    id[pos] = metricDimensionId;
    size[pos] = numMeasures;
    dimension[metricDimensionId] = {
      label: metricDimensionId,
      category: buildCategoryMetadata(measureCols, categoryIndexFormat, includeCategoryLabels),
    };
    role.metric = [metricDimensionId];
  }

  if (roleTime.length > 0) {
    role.time = roleTime;
  }

  const dataset = {
    version: "2.0",
    class: "dataset",
    id,
    size,
    dimension,
    value,
  };

  if (Object.keys(role).length > 0) {
    dataset.role = role;
  }
  if (warnings.length > 0) {
    dataset.extension = { warning: warnings.join(" ") };
  }

  return dataset;
}

function dedupeColumns(cols) {
  const dedupedCols = new Array(cols.length);
  const originalToDeduped = Object.create(null);
  let needsRemap = false;
  const seen = Object.create(null);

  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const count = (seen[col] ?? 0) + 1;
    seen[col] = count;
    const deduped = count === 1 ? col : `${col}_${count}`;
    dedupedCols[i] = deduped;
    if (count > 1) needsRemap = true;
    if (!originalToDeduped[col]) {
      originalToDeduped[col] = [];
    }
    originalToDeduped[col].push(deduped);
  }

  return { dedupedCols, needsRemap, originalToDeduped };
}

function remapRows(rows, cols, dedupedCols) {
  const outRows = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const out = Object.create(null);
    for (let i = 0; i < cols.length; i++) {
      const originalKey = cols[i];
      const dedupedKey = dedupedCols[i];
      out[dedupedKey] = dedupedKey === originalKey
        ? row[originalKey]
        : row[dedupedKey] !== undefined ? row[dedupedKey] : row[originalKey];
    }
    outRows[r] = out;
  }
  return outRows;
}

function resolveExplicitNames(names, originalToDeduped) {
  if (!Array.isArray(names) || names.length === 0) return null;

  const resolved = new Set();
  for (const name of names) {
    const mapped = originalToDeduped[name];
    if (mapped && mapped.length > 0) {
      for (const deduped of mapped) {
        resolved.add(deduped);
      }
    } else {
      resolved.add(name);
    }
  }
  return resolved;
}

function scanRowsWithExplicitMeasures(rows, dedupedCols, explicitMeasures) {
  const numCols = dedupedCols.length;
  const categoryMapsByColumn = new Array(numCols);
  const categoryValuesByColumn = new Array(numCols);
  const isBinary = new Uint8Array(numCols);
  const binaryNames = [];
  const activeIndices = [];

  for (let c = 0; c < numCols; c++) {
    if (!explicitMeasures.has(dedupedCols[c])) {
      categoryMapsByColumn[c] = new Map();
      categoryValuesByColumn[c] = [];
    }
  }

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < numCols; c++) {
      if (isBinary[c]) continue;
      const value = row[dedupedCols[c]];
      if (Buffer.isBuffer(value)) {
        isBinary[c] = 1;
        continue;
      }
      if (categoryMapsByColumn[c]) {
        addCategoryValue(categoryMapsByColumn[c], categoryValuesByColumn[c], value);
      }
    }
  }

  for (let c = 0; c < numCols; c++) {
    if (isBinary[c]) {
      binaryNames.push(dedupedCols[c]);
    } else {
      activeIndices.push(c);
    }
  }

  return {
    activeIndices,
    binaryNames,
    categoryMapsByColumn,
    categoryValuesByColumn,
  };
}

function scanRowsForTypeInference(rows, dedupedCols) {
  const numCols = dedupedCols.length;
  const isBinary = new Uint8Array(numCols);
  const isNumeric = new Uint8Array(numCols);
  const hasSample = new Uint8Array(numCols);
  const binaryNames = [];
  const activeIndices = [];

  for (let c = 0; c < numCols; c++) {
    isNumeric[c] = 1;
  }

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < numCols; c++) {
      if (isBinary[c]) continue;
      const value = row[dedupedCols[c]];
      if (Buffer.isBuffer(value)) {
        isBinary[c] = 1;
        isNumeric[c] = 0;
        continue;
      }
      if (value != null) {
        hasSample[c] = 1;
        if (isNumeric[c] && typeof value !== "number") {
          isNumeric[c] = 0;
        }
      }
    }
  }

  for (let c = 0; c < numCols; c++) {
    if (isBinary[c]) {
      binaryNames.push(dedupedCols[c]);
    } else {
      activeIndices.push(c);
    }
  }

  return {
    activeIndices,
    binaryNames,
    isNumeric,
    hasSample,
  };
}

function filterToActive(values, activeIndices, dedupedCols) {
  const activeSet = new Set();
  for (let i = 0; i < activeIndices.length; i++) {
    activeSet.add(dedupedCols[activeIndices[i]]);
  }

  const filtered = new Set();
  for (const value of values) {
    if (activeSet.has(value)) {
      filtered.add(value);
    }
  }
  return filtered;
}

function inferMeasureColumns(activeIndices, dedupedCols, isNumeric, hasSample) {
  const measureSet = new Set();
  for (let i = 0; i < activeIndices.length; i++) {
    const colIndex = activeIndices[i];
    if (isNumeric[colIndex] && hasSample[colIndex]) {
      measureSet.add(dedupedCols[colIndex]);
    }
  }
  return measureSet;
}

function inferTimeDimensions(activeIndices, dedupedCols, measureSet) {
  const timeDimSet = new Set();
  for (let i = 0; i < activeIndices.length; i++) {
    const name = dedupedCols[activeIndices[i]];
    if (!measureSet.has(name) && TIME_COLUMN_RE.test(name)) {
      timeDimSet.add(name);
    }
  }
  return timeDimSet;
}

function splitColumns(activeIndices, dedupedCols, measureSet) {
  const dimCols = [];
  const measureCols = [];
  const dimColIndices = [];

  for (let i = 0; i < activeIndices.length; i++) {
    const colIndex = activeIndices[i];
    const colName = dedupedCols[colIndex];
    if (measureSet.has(colName)) {
      measureCols.push(colName);
    } else {
      dimCols.push(colName);
      dimColIndices.push(colIndex);
    }
  }

  return { dimCols, measureCols, dimColIndices };
}

function applyDimensionOrderOverride(dimCols, dimColIndices, requestedDims) {
  const requested = Array.from(requestedDims);
  const currentIndexByName = Object.create(null);
  for (let i = 0; i < dimCols.length; i++) {
    currentIndexByName[dimCols[i]] = i;
  }

  const orderedNames = [];
  const orderedIndices = [];
  const seen = new Set();

  for (let i = 0; i < requested.length; i++) {
    const name = requested[i];
    const existingIndex = currentIndexByName[name];
    if (existingIndex == null || seen.has(name)) continue;
    orderedNames.push(dimCols[existingIndex]);
    orderedIndices.push(dimColIndices[existingIndex]);
    seen.add(name);
  }

  for (let i = 0; i < dimCols.length; i++) {
    const name = dimCols[i];
    if (seen.has(name)) continue;
    orderedNames.push(name);
    orderedIndices.push(dimColIndices[i]);
  }

  return {
    dimCols: orderedNames,
    dimColIndices: orderedIndices,
  };
}

function collectDimensionCategories(rows, dimCols) {
  const maps = new Array(dimCols.length);
  const values = new Array(dimCols.length);

  for (let d = 0; d < dimCols.length; d++) {
    maps[d] = new Map();
    values[d] = [];
  }

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let d = 0; d < dimCols.length; d++) {
      addCategoryValue(maps[d], values[d], row[dimCols[d]]);
    }
  }

  return { maps, values };
}

function extractCollectedCategories(dimColIndices, categoryMapsByColumn, categoryValuesByColumn) {
  const maps = new Array(dimColIndices.length);
  const values = new Array(dimColIndices.length);

  for (let d = 0; d < dimColIndices.length; d++) {
    const colIndex = dimColIndices[d];
    maps[d] = categoryMapsByColumn[colIndex] ?? new Map();
    values[d] = categoryValuesByColumn[colIndex] ?? [];
  }

  return { maps, values };
}

function addCategoryValue(categoryMap, categoryValues, rawValue) {
  const identity = encodeCategoryIdentity(rawValue);
  if (categoryMap.has(identity)) return;
  categoryMap.set(identity, categoryValues.length);
  categoryValues.push(rawValue);
}

function encodeCategoryIdentity(value) {
  if (value === null) return "null:";
  if (value === undefined) return "undefined:";

  const type = typeof value;
  if (type === "string") return `string:${value}`;
  if (type === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${value}`;
  }
  if (type === "boolean") return `boolean:${value}`;
  if (type === "bigint") return `bigint:${value.toString()}`;
  if (type === "symbol") return `symbol:${String(value.description ?? "")}`;
  if (type === "function") return `function:${value.name || "<anonymous>"}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  try {
    return `object:${JSON.stringify(value)}`;
  } catch {
    return `object:${String(value)}`;
  }
}

function mergeRowsToOffsets(rows, dimCols, measureCols, dimCatMaps, strides, duplicatePolicy) {
  const offsetMap = new Map();
  let duplicateCount = 0;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let baseOffset = 0;

    for (let d = 0; d < dimCols.length; d++) {
      const categoryIndex = dimCatMaps[d].get(encodeCategoryIdentity(row[dimCols[d]]));
      baseOffset += categoryIndex * strides[d];
    }

    if (offsetMap.has(baseOffset)) {
      duplicateCount++;
      if (duplicatePolicy === "error") {
        return {
          error: {
            error: "Duplicate dimension tuples detected. Supply pre-aggregated rows or set options.duplicatePolicy.",
            status: 400,
          },
        };
      }
      const existing = offsetMap.get(baseOffset);
      if (measureCols.length > 0) {
        if (duplicatePolicy === "last") {
          for (let m = 0; m < measureCols.length; m++) {
            const nextValue = row[measureCols[m]];
            if (nextValue !== undefined) {
              existing[m] = nextValue;
            }
          }
        } else {
          for (let m = 0; m < measureCols.length; m++) {
            const nextValue = row[measureCols[m]];
            const currentValue = existing[m];
            if (typeof currentValue === "number" && typeof nextValue === "number") {
              existing[m] = currentValue + nextValue;
            } else if (nextValue !== undefined) {
              existing[m] = nextValue;
            }
          }
        }
      }
      continue;
    }

    if (measureCols.length > 0) {
      const values = new Array(measureCols.length);
      for (let m = 0; m < measureCols.length; m++) {
        const value = row[measureCols[m]];
        values[m] = value !== undefined ? value : null;
      }
      offsetMap.set(baseOffset, values);
    } else {
      offsetMap.set(baseOffset, null);
    }
  }

  return { offsetMap, duplicateCount };
}

function duplicatePolicyWarning(policy, duplicateCount) {
  if (policy === "last") {
    return `Duplicate dimension tuples detected (${duplicateCount}). Last non-undefined values were kept.`;
  }
  return `Duplicate dimension tuples detected (${duplicateCount}). Numeric measures were summed; other values used the last non-undefined value.`;
}

function resolveValueEncoding(
  valueFormat,
  totalCells,
  density,
  sparseThreshold,
  minSparseCells,
  maxDenseCells
) {
  if (valueFormat === "sparse") {
    return { useSparse: true };
  }

  if (valueFormat === "dense") {
    if (totalCells > maxDenseCells) {
      return {
        error: {
          error: `Dense JSON-Stat output would require ${totalCells} cells, exceeding the configured maximum of ${maxDenseCells}.`,
          status: 413,
        },
      };
    }
    return { useSparse: false };
  }

  if (totalCells > maxDenseCells && density > sparseThreshold) {
    return {
      error: {
        error: `JSON-Stat output would require ${totalCells} dense cells at ${(density * 100).toFixed(1)}% density, exceeding the configured maximum of ${maxDenseCells}.`,
        status: 413,
      },
    };
  }

  if (totalCells >= minSparseCells && density <= sparseThreshold) {
    return {
      useSparse: true,
      warning: `Sparse JSON-Stat value encoding was used for a low-density cube (${(density * 100).toFixed(1)}% populated).`,
    };
  }

  if (totalCells > maxDenseCells) {
    return {
      useSparse: true,
      warning: `Sparse JSON-Stat value encoding was used because dense output would require ${totalCells} cells.`,
    };
  }

  return { useSparse: false };
}

function buildDenseValueArray(totalCells, offsetMap, numMeasures) {
  const value = new Array(totalCells).fill(null);
  for (const [baseOffset, measureValues] of offsetMap) {
    if (numMeasures > 0) {
      for (let m = 0; m < numMeasures; m++) {
        value[baseOffset + m] = measureValues[m] ?? null;
      }
    } else {
      value[baseOffset] = null;
    }
  }
  return value;
}

function buildSparseValueObject(offsetMap, numMeasures) {
  const value = Object.create(null);
  for (const [baseOffset, measureValues] of offsetMap) {
    if (numMeasures > 0) {
      for (let m = 0; m < numMeasures; m++) {
        value[baseOffset + m] = measureValues[m] ?? null;
      }
    } else {
      value[baseOffset] = null;
    }
  }
  return value;
}

function buildCategoryMetadata(rawValues, categoryIndexFormat, includeCategoryLabels) {
  const categoryIds = buildUniqueCategoryIds(rawValues);
  const category = {
    index: categoryIndexFormat === "array"
      ? categoryIds.slice()
      : buildCategoryIndexObject(categoryIds),
  };

  if (includeCategoryLabels) {
    const labels = Object.create(null);
    for (let i = 0; i < categoryIds.length; i++) {
      labels[categoryIds[i]] = renderCategoryLabel(rawValues[i]);
    }
    category.label = labels;
  }

  return category;
}

function buildCategoryIndexObject(categoryIds) {
  const index = Object.create(null);
  for (let i = 0; i < categoryIds.length; i++) {
    index[categoryIds[i]] = i;
  }
  return index;
}

function buildUniqueCategoryIds(rawValues) {
  const categoryIds = new Array(rawValues.length);
  const usedIds = new Set();

  for (let i = 0; i < rawValues.length; i++) {
    const value = rawValues[i];
    let candidate = defaultCategoryId(value);
    if (usedIds.has(candidate)) {
      const typeSuffix = categoryTypeLabel(value);
      const base = candidate === ""
        ? `[${typeSuffix}]`
        : `${candidate} [${typeSuffix}]`;
      let suffix = 1;
      let uniqueCandidate = base;
      while (usedIds.has(uniqueCandidate)) {
        suffix++;
        uniqueCandidate = `${base} ${suffix}`;
      }
      candidate = uniqueCandidate;
    }
    usedIds.add(candidate);
    categoryIds[i] = candidate;
  }

  return categoryIds;
}

function defaultCategoryId(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : String(value);
}

function renderCategoryLabel(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : String(value);
}

function categoryTypeLabel(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Date) return "date";
  return typeof value;
}

function makeUniqueMetricDimensionId(dimCols, preferredId) {
  const baseId = preferredId || "metric";
  if (!dimCols.includes(baseId)) return baseId;

  let suffix = 2;
  let candidate = `${baseId}_${suffix}`;
  while (dimCols.includes(candidate)) {
    suffix++;
    candidate = `${baseId}_${suffix}`;
  }
  return candidate;
}

function buildEmptyDataset(
  dimCols,
  measureCols,
  timeDimSet,
  warnings,
  metricDimensionId,
  categoryIndexFormat,
  includeCategoryLabels
) {
  const id = [];
  const size = [];
  const dimension = Object.create(null);
  const role = Object.create(null);
  const roleTime = [];

  for (let i = 0; i < dimCols.length; i++) {
    const dimId = dimCols[i];
    id.push(dimId);
    size.push(0);
    dimension[dimId] = {
      label: dimId,
      category: buildCategoryMetadata([], categoryIndexFormat, includeCategoryLabels),
    };
    if (timeDimSet.has(dimId)) {
      roleTime.push(dimId);
    }
  }

  if (measureCols.length > 0) {
    id.push(metricDimensionId);
    size.push(measureCols.length);
    dimension[metricDimensionId] = {
      label: metricDimensionId,
      category: buildCategoryMetadata(measureCols, categoryIndexFormat, includeCategoryLabels),
    };
    role.metric = [metricDimensionId];
  }

  if (roleTime.length > 0) {
    role.time = roleTime;
  }

  const dataset = {
    version: "2.0",
    class: "dataset",
    id,
    size,
    dimension,
    value: [],
  };

  if (Object.keys(role).length > 0) {
    dataset.role = role;
  }
  if (warnings.length > 0) {
    dataset.extension = { warning: warnings.join(" ") };
  }

  return dataset;
}

function normalizeFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeFiniteInteger(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}
