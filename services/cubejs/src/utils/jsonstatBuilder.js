/**
 * Builds a JSON-Stat 2.0 dataset object from tabular query results.
 *
 * Optimized single-pass encoder: classifies columns, extracts categories,
 * and merges duplicate tuples in one iteration over rows. Uses stride-based
 * offset computation for O(n*m) value placement instead of O(product(sizes)).
 *
 * @param {Array<Object>} rows - Array of row objects
 * @param {string[]} columns - Column names (may contain duplicates)
 * @param {Object} [options] - Classification hints
 * @param {string[]} [options.measures] - Columns to treat as measures
 * @param {string[]} [options.timeDimensions] - Columns to treat as time dimensions
 * @returns {Object} JSON-Stat 2.0 dataset or error object
 */

export function buildJSONStat(rows, columns, options) {
  const cols = columns ?? [];
  const opts = options ?? {};

  // --- Edge: no rows AND no columns ---
  if ((!rows || rows.length === 0) && cols.length === 0) {
    return { error: "Cannot produce JSON-Stat from empty result with no columns.", status: 400 };
  }

  // --- Disambiguate duplicate column names ---
  const dedupedCols = new Array(cols.length);
  let needsRemap = false;
  {
    const seen = Object.create(null);
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      if (seen[col] == null) {
        seen[col] = 1;
        dedupedCols[i] = col;
      } else {
        seen[col]++;
        dedupedCols[i] = `${col}_${seen[col]}`;
        needsRemap = true;
      }
    }
  }

  // Remap row data only when duplicate columns exist
  let workRows = rows;
  if (needsRemap && rows && rows.length > 0) {
    workRows = new Array(rows.length);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const out = Object.create(null);
      for (let i = 0; i < cols.length; i++) {
        const origKey = cols[i];
        const newKey = dedupedCols[i];
        if (newKey === origKey) {
          out[newKey] = row[origKey];
        } else {
          out[newKey] = row[newKey] !== undefined ? row[newKey] : row[origKey];
        }
      }
      workRows[r] = out;
    }
  }

  const numRows = workRows ? workRows.length : 0;
  const numCols = dedupedCols.length;

  // --- Resolve explicit classification hints (map original names to deduped) ---
  let explicitMeasures = null;
  let explicitTime = null;
  if (opts.measures) {
    const colToDeduped = Object.create(null);
    for (let i = 0; i < cols.length; i++) {
      if (!(cols[i] in colToDeduped)) colToDeduped[cols[i]] = dedupedCols[i];
    }
    explicitMeasures = new Set();
    for (const name of opts.measures) {
      explicitMeasures.add(colToDeduped[name] ?? name);
    }
  }
  if (opts.timeDimensions) {
    const colToDeduped = Object.create(null);
    for (let i = 0; i < cols.length; i++) {
      if (!(cols[i] in colToDeduped)) colToDeduped[cols[i]] = dedupedCols[i];
    }
    explicitTime = new Set();
    for (const name of opts.timeDimensions) {
      explicitTime.add(colToDeduped[name] ?? name);
    }
  }

  // --- Single pass: detect binary, track numeric, build category maps, merge tuples ---
  const warnings = [];
  const isBinary = new Uint8Array(numCols);   // 1 = binary detected
  const isNumeric = new Uint8Array(numCols);   // 1 = all-numeric so far
  const hasSample = new Uint8Array(numCols);   // 1 = at least one non-null value
  // Per-column category maps: Map<string, int> (only for dimension candidates)
  // We'll build these for ALL columns initially, then discard for measures.
  const catMaps = new Array(numCols);
  const catOrders = new Array(numCols); // ordered category arrays
  for (let i = 0; i < numCols; i++) {
    isNumeric[i] = 1; // assume numeric until proven otherwise
    catMaps[i] = new Map();
    catOrders[i] = [];
  }

  // For duplicate tuple merging, we use stride-based integer offsets as dedup keys.
  // But we don't know dimension columns yet during the scan (for heuristic mode).
  // So we collect rows and defer merging until after classification.
  // However, we CAN do the binary/numeric/category detection in one pass.

  if (numRows > 0) {
    for (let r = 0; r < numRows; r++) {
      const row = workRows[r];
      for (let c = 0; c < numCols; c++) {
        if (isBinary[c]) continue; // already known binary, skip
        const key = dedupedCols[c];
        const v = row[key];

        // Binary detection
        if (Buffer.isBuffer(v)) {
          isBinary[c] = 1;
          isNumeric[c] = 0;
          continue;
        }

        // Numeric tracking
        if (v != null) {
          hasSample[c] = 1;
          if (isNumeric[c] && typeof v !== "number") {
            isNumeric[c] = 0;
          }
        }

        // Category tracking (stringified value)
        const sv = String(v ?? "");
        if (!catMaps[c].has(sv)) {
          catMaps[c].set(sv, catOrders[c].length);
          catOrders[c].push(sv);
        }
      }
    }
  }

  // --- Build active columns (omit binary) ---
  const activeIndices = [];
  const binaryNames = [];
  for (let c = 0; c < numCols; c++) {
    if (isBinary[c]) {
      binaryNames.push(dedupedCols[c]);
    } else {
      activeIndices.push(c);
    }
  }
  if (binaryNames.length > 0) {
    warnings.push(`Binary columns omitted from JSON-Stat output: ${binaryNames.join(", ")}`);
  }

  const activeCols = activeIndices.map((i) => dedupedCols[i]);
  const activeSet = new Set(activeCols);

  // --- Classify columns ---
  let measureSet;
  let timeDimSet;

  if (explicitMeasures) {
    measureSet = new Set();
    for (const m of explicitMeasures) {
      if (activeSet.has(m)) measureSet.add(m);
    }
  }
  if (explicitTime) {
    timeDimSet = new Set();
    for (const t of explicitTime) {
      if (activeSet.has(t)) timeDimSet.add(t);
    }
  }

  if (!measureSet || !timeDimSet) {
    if (!measureSet) {
      measureSet = new Set();
      for (const ci of activeIndices) {
        if (isNumeric[ci] && hasSample[ci]) {
          measureSet.add(dedupedCols[ci]);
        }
      }
    }
    if (!timeDimSet) {
      const timePattern = /^(year|date|month|quarter|period|time|day|week)/i;
      timeDimSet = new Set();
      for (const col of activeCols) {
        if (!measureSet.has(col) && timePattern.test(col)) {
          timeDimSet.add(col);
        }
      }
    }
    warnings.push(
      "Column classification was inferred heuristically. Supply options.measures and options.timeDimensions for exact control."
    );
  }

  const dimCols = [];
  const measureCols = [];
  // Also track column indices for dims (for fast category lookup)
  const dimColIndices = [];
  for (const ci of activeIndices) {
    const col = dedupedCols[ci];
    if (measureSet.has(col)) {
      measureCols.push(col);
    } else {
      dimCols.push(col);
      dimColIndices.push(ci);
    }
  }

  // --- Edge: no rows but columns exist ---
  if (numRows === 0) {
    return buildEmptyDataset(dimCols, measureCols, timeDimSet, warnings);
  }

  // --- Build dimension category index maps from pre-built catMaps ---
  const numDims = dimCols.length;
  const numMeasures = measureCols.length;
  const dimCatMap = new Array(numDims);   // Map<string, int> per dimension
  const dimCatList = new Array(numDims);  // string[] per dimension
  const dimSizes = new Array(numDims);

  for (let d = 0; d < numDims; d++) {
    const ci = dimColIndices[d];
    dimCatMap[d] = catMaps[ci];
    dimCatList[d] = catOrders[ci];
    dimSizes[d] = catOrders[ci].length;
  }

  // --- Compute strides for flat offset (row-major) ---
  // id order: dim0, dim1, ..., dimN, metric
  // size order: dimSize0, dimSize1, ..., dimSizeN, numMeasures (if > 0)
  const effectiveMeasureCount = numMeasures > 0 ? numMeasures : 1;
  // stride[d] = product of sizes of all dimensions after d, times effectiveMeasureCount
  const strides = new Array(numDims);
  {
    let s = effectiveMeasureCount;
    for (let d = numDims - 1; d >= 0; d--) {
      strides[d] = s;
      s *= dimSizes[d];
    }
  }

  const totalObs = dimSizes.length > 0
    ? dimSizes.reduce((a, b) => a * b, 1) * effectiveMeasureCount
    : effectiveMeasureCount;

  // --- Merge duplicate tuples using stride-based integer offset as key ---
  // offset (without measure index) = sum(catIndex[d] * strides[d])
  // We store merged measure values keyed by this base offset.
  // Use a Map<int, Array> where the array holds measure values.
  const mergedMap = new Map(); // baseOffset -> measureValues[]
  let duplicateCount = 0;

  for (let r = 0; r < numRows; r++) {
    const row = workRows[r];

    // Compute base offset from dimension category indices
    let baseOffset = 0;
    for (let d = 0; d < numDims; d++) {
      const sv = String(row[dimCols[d]] ?? "");
      baseOffset += dimCatMap[d].get(sv) * strides[d];
    }

    if (mergedMap.has(baseOffset)) {
      duplicateCount++;
      const existing = mergedMap.get(baseOffset);
      for (let m = 0; m < numMeasures; m++) {
        const newVal = row[measureCols[m]];
        const oldVal = existing[m];
        if (typeof oldVal === "number" && typeof newVal === "number") {
          existing[m] = oldVal + newVal;
        } else if (newVal !== undefined) {
          existing[m] = newVal;
        }
      }
    } else {
      const vals = new Array(numMeasures);
      for (let m = 0; m < numMeasures; m++) {
        const v = row[measureCols[m]];
        vals[m] = v !== undefined ? v : null;
      }
      mergedMap.set(baseOffset, vals);
    }
  }

  if (duplicateCount > 0) {
    warnings.push(
      `Duplicate dimension tuples detected (${duplicateCount}). Numeric measures were summed; non-numeric used last value.`
    );
  }

  // --- Build value array via sparse placement ---
  const value = new Array(totalObs).fill(null);

  for (const [baseOffset, measureVals] of mergedMap) {
    if (numMeasures > 0) {
      for (let m = 0; m < numMeasures; m++) {
        value[baseOffset + m] = measureVals[m] ?? null;
      }
    }
    // If no measures, the single observation slot at baseOffset stays null
    // unless we want to place something — but with 0 measures there's nothing to place.
    // The slot is already null from fill.
  }

  // --- Build JSON-Stat 2.0 dataset ---
  const id = new Array(numDims + (numMeasures > 0 ? 1 : 0));
  const size = new Array(id.length);
  const dimension = Object.create(null);
  const roleTime = [];
  const roleMetric = [];

  for (let d = 0; d < numDims; d++) {
    const col = dimCols[d];
    id[d] = col;
    size[d] = dimSizes[d];
    const idx = Object.create(null);
    const lbl = Object.create(null);
    const cats = dimCatList[d];
    for (let i = 0; i < cats.length; i++) {
      idx[cats[i]] = i;
      lbl[cats[i]] = cats[i];
    }
    dimension[col] = { label: col, category: { index: idx, label: lbl } };
    if (timeDimSet.has(col)) roleTime.push(col);
  }

  if (numMeasures > 0) {
    const pos = numDims;
    id[pos] = "metric";
    size[pos] = numMeasures;
    const idx = Object.create(null);
    const lbl = Object.create(null);
    for (let i = 0; i < numMeasures; i++) {
      idx[measureCols[i]] = i;
      lbl[measureCols[i]] = measureCols[i];
    }
    dimension["metric"] = { label: "metric", category: { index: idx, label: lbl } };
    roleMetric.push("metric");
  }

  const role = {};
  if (roleTime.length > 0) role.time = roleTime;
  if (roleMetric.length > 0) role.metric = roleMetric;

  const dataset = {
    version: "2.0",
    class: "dataset",
    id,
    size,
    dimension,
    value,
  };

  if (Object.keys(role).length > 0) dataset.role = role;
  if (warnings.length > 0) dataset.extension = { warning: warnings.join(" ") };

  return dataset;
}

/**
 * Build a valid but empty JSON-Stat dataset (no rows, but columns known).
 */
function buildEmptyDataset(dimCols, measureCols, timeDimSet, warnings) {
  const id = [];
  const size = [];
  const dimension = {};
  const roleTime = [];
  const roleMetric = [];

  for (const col of dimCols) {
    id.push(col);
    size.push(0);
    dimension[col] = {
      label: col,
      category: { index: {}, label: {} },
    };
    if (timeDimSet.has(col)) {
      roleTime.push(col);
    }
  }

  if (measureCols.length > 0) {
    const metricId = "metric";
    id.push(metricId);
    size.push(measureCols.length);
    const idx = {};
    measureCols.forEach((m, i) => { idx[m] = i; });
    dimension[metricId] = {
      label: "metric",
      category: {
        index: idx,
        label: Object.fromEntries(measureCols.map((m) => [m, m])),
      },
    };
    roleMetric.push(metricId);
  }

  const role = {};
  if (roleTime.length > 0) role.time = roleTime;
  if (roleMetric.length > 0) role.metric = roleMetric;

  const dataset = {
    version: "2.0",
    class: "dataset",
    id,
    size,
    dimension,
    value: [],
  };

  if (Object.keys(role).length > 0) dataset.role = role;
  if (warnings.length > 0) {
    dataset.extension = { warning: warnings.join(" ") };
  }

  return dataset;
}
