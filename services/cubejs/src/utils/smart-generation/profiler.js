/**
 * ClickHouse table profiler — introspects schema and data characteristics.
 *
 * Multi-pass analysis:
 *   0. Schema discovery  — DESCRIBE + system.parts_columns (parallel)
 *   1. Initial profile   — single unsampled query: row count, scalar ranges,
 *                          map key counts, nested group depths
 *   2. Deep profiling    — sampled, batched: map key discovery + nested sub-columns
 *   3. LC + map stats    — value enumeration for categoricals, per-key range for numerics
 *
 * The initial profile (Pass 1) uses only streaming aggregates (count, min, max,
 * avg, uniq, max(length)) — O(1) memory, safe on any table size.  Its results
 * drive all subsequent decisions: which groups to expand, which columns to LC
 * probe, whether sampling is needed.
 *
 * Ported from the Python prototype in cxs-inbox/libs/core/cxs/core/utils/profile_table.py
 */

import { parseType, ColumnType, ValueType } from './typeParser.js';
import { buildFilterWhereClause } from './filterBuilder.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 10;
const DEFAULT_SAMPLE_THRESHOLD = 1_000_000;
const SAMPLE_RATIO = 10;
const SUBQUERY_LIMIT_MAX = 200_000;
const SINGLE_QUERY_LIMIT = 50;
const LC_THRESHOLD = 60;

// ---------------------------------------------------------------------------
// WHERE clause helper
// ---------------------------------------------------------------------------

/**
 * Build a WHERE clause combining partition filtering and user-specified filters.
 *
 * @param {string}  schema          Database / schema name
 * @param {string}  table           Table name
 * @param {string|null}  partition  Partition value
 * @param {string[]}     internalTables  Tables that support partition filtering
 * @param {Array}   [filters]       Optional filter descriptors from the user
 * @param {string[]} [tableColumns] Valid column names (required when filters are provided)
 * @returns {string} SQL WHERE clause with leading ` WHERE `, or empty string
 */
export function buildWhereClause(schema, table, partition, internalTables, filters, tableColumns) {
  // Partition clause — apply when partition is set and either:
  //  (a) internalTables explicitly lists this table, OR
  //  (b) internalTables is not configured (empty/missing) — all tables are internal
  let partitionClause = '';
  if (partition) {
    const hasExplicitList = Array.isArray(internalTables) && internalTables.length > 0;
    if (!hasExplicitList || internalTables.includes(table)) {
      partitionClause = `partition IN ('${partition}')`;
    }
  }

  // Filter clause — normalize missing/invalid to empty
  let filterClause = '';
  if (Array.isArray(filters) && filters.length > 0) {
    const filterWhere = buildFilterWhereClause(filters, tableColumns);
    // Strip leading " WHERE " to get bare conditions
    filterClause = filterWhere.replace(/^\s*WHERE\s+/, '');
  }

  if (partitionClause && filterClause) {
    return ` WHERE ${partitionClause} AND ${filterClause}`;
  }
  if (partitionClause) {
    return ` WHERE ${partitionClause}`;
  }
  if (filterClause) {
    return ` WHERE ${filterClause}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Sampling strategy
// ---------------------------------------------------------------------------

async function detectSampling(driver, schema, table, whereClause, sampleRatio, rowCount) {
  const sampleRows = Math.round(rowCount / sampleRatio);
  const baseTable = `${schema}.\`${table}\``;

  try {
    await driver.query(`SELECT 1 FROM ${baseTable} SAMPLE 1/${sampleRatio} LIMIT 1`);
    return {
      fromExpr: `${baseTable} SAMPLE 1/${sampleRatio}${whereClause}`,
      method: 'native',
      sampleRows,
    };
  } catch (e) { /* SAMPLE not supported */ }

  const limitRows = Math.min(sampleRows, SUBQUERY_LIMIT_MAX);
  return {
    fromExpr: `(SELECT * FROM ${baseTable}${whereClause} LIMIT ${limitRows})`,
    method: 'subquery_limit',
    sampleRows: limitRows,
  };
}

// ---------------------------------------------------------------------------
// Pass 1: Initial profile query
// ---------------------------------------------------------------------------

/**
 * Build the initial profile SQL — one query that gathers:
 *   - count()
 *   - min/max/avg for scalar NUMBER and BOOLEAN (Int8) columns
 *   - min/max for scalar DATE columns
 *   - uniq() for scalar STRING columns
 *   - uniq(mapKeys()) for Map columns
 *   - max(length(sentinel)) for each nested parent group
 *
 * All aggregates are streaming (O(1) memory).  Runs unsampled.
 */
function buildInitialProfileParts(columns, parentGroupInfo, emptyColumns) {
  const parts = ['count() as row_count'];

  for (const [name, col] of columns) {
    if (emptyColumns.has(name)) continue;
    if (col.columnType === ColumnType.GROUPED) continue; // handled via parent groups

    const alias = name.replace(/\./g, '_');

    if (col.columnType === ColumnType.MAP) {
      parts.push(`uniq(mapKeys(\`${name}\`)) as ${alias}__key_count`);
    } else if (col.valueType === ValueType.DATE) {
      parts.push(`min(\`${name}\`) as ${alias}__min`);
      parts.push(`max(\`${name}\`) as ${alias}__max`);
    } else if (col.valueType === ValueType.NUMBER || col.valueType === ValueType.BOOLEAN) {
      parts.push(`min(\`${name}\`) as ${alias}__min`);
      parts.push(`max(\`${name}\`) as ${alias}__max`);
      parts.push(`avg(\`${name}\`) as ${alias}__avg`);
    } else if (col.valueType === ValueType.STRING) {
      // Exclude empty strings from unique count — they add no analytical value
      parts.push(`uniqIf(\`${name}\`, \`${name}\` != '') as ${alias}__count`);
    } else if (col.valueType === ValueType.UUID) {
      parts.push(`uniq(\`${name}\`) as ${alias}__count`);
    }
    // OTHER: skip — unprofilable
  }

  // One sentinel per nested parent group
  for (const [parent, info] of parentGroupInfo) {
    const alias = parent.replace(/\./g, '_');
    // Use length() only for Array-typed sentinels; for others use countIf(IS NOT NULL)
    if (info.sentinelIsArray) {
      parts.push(`max(length(\`${info.sentinel}\`)) as ${alias}__max_length`);
    } else {
      parts.push(`countIf(\`${info.sentinel}\` IS NOT NULL) as ${alias}__max_length`);
    }
  }

  return parts;
}

/**
 * Apply initial profile results to column profiles and parent groups.
 */
function applyInitialProfile(row, columns, parentGroupInfo, emptyColumns) {
  const rowCount = typeof row.row_count === 'number'
    ? row.row_count : Number(row.row_count) || 0;

  for (const [name, col] of columns) {
    if (emptyColumns.has(name)) continue;
    if (col.columnType === ColumnType.GROUPED) continue;

    const alias = name.replace(/\./g, '_');
    const profile = col.profile;

    if (col.columnType === ColumnType.MAP) {
      const keyCount = Number(row[`${alias}__key_count`]) || 0;
      profile.uniqueValues = keyCount;
      profile.hasValues = keyCount > 0;
      profile.valueRows = keyCount > 0 ? rowCount : 0;
    } else if (col.valueType === ValueType.DATE) {
      profile.minValue = row[`${alias}__min`] ?? null;
      profile.maxValue = row[`${alias}__max`] ?? null;
      profile.hasValues = profile.minValue != null;
      profile.valueRows = profile.hasValues ? rowCount : 0;
    } else if (col.valueType === ValueType.NUMBER || col.valueType === ValueType.BOOLEAN) {
      profile.minValue = row[`${alias}__min`] ?? null;
      profile.maxValue = row[`${alias}__max`] ?? null;
      const avg = row[`${alias}__avg`];
      profile.avgValue = avg != null ? Math.round(Number(avg) * 1000) / 1000 : null;
      profile.hasValues = profile.minValue != null;
      profile.valueRows = profile.hasValues ? rowCount : 0;
    } else if (col.valueType === ValueType.STRING || col.valueType === ValueType.UUID) {
      const count = Number(row[`${alias}__count`]) || 0;
      profile.uniqueValues = count;
      profile.hasValues = count > 0;
      profile.valueRows = count > 0 ? rowCount : 0;
    }
  }

  // Nested group max lengths
  for (const [parent, info] of parentGroupInfo) {
    const alias = parent.replace(/\./g, '_');
    const val = row[`${alias}__max_length`];
    info.maxLength = val != null ? Number(val) || 0 : 0;
  }

  return rowCount;
}

// ---------------------------------------------------------------------------
// Pass 2: Deep profiling SQL helpers
// ---------------------------------------------------------------------------

function basicColumnSql(colExpr, valueType, alias) {
  const parts = [];
  if (valueType === ValueType.NUMBER || valueType === ValueType.DATE) {
    parts.push(`min(\`${colExpr}\`) as ${alias}__min_value`);
    parts.push(`max(\`${colExpr}\`) as ${alias}__max_value`);
    parts.push(`countIf(\`${colExpr}\` IS NOT NULL) as ${alias}__value_rows`);
  } else if (valueType === ValueType.STRING) {
    parts.push(`uniqIf(\`${colExpr}\`, \`${colExpr}\` != '') as ${alias}__distinct_count`);
    parts.push(`countIf(\`${colExpr}\` IS NOT NULL and \`${colExpr}\` != '') as ${alias}__value_rows`);
  } else {
    parts.push(`uniq(\`${colExpr}\`) as ${alias}__distinct_count`);
    parts.push(`countIf(\`${colExpr}\` IS NOT NULL) as ${alias}__value_rows`);
  }
  return parts;
}

function mapColumnSql(colExpr, alias) {
  return [
    `groupUniqArrayArray(200)(mapKeys(\`${colExpr}\`)) as ${alias}__map_keys`,
    `countIf(length(mapKeys(\`${colExpr}\`)) > 0) as ${alias}__value_rows`,
  ];
}

function arrayColumnSql(colExpr, valueType, alias) {
  if (valueType === ValueType.STRING) {
    // For string arrays: exclude arrays that only contain empty strings
    // arrayFilter removes empty elements; length check ensures at least one non-empty
    return [
      `countIf(length(arrayFilter(x -> x != '', \`${colExpr}\`)) > 0) as ${alias}__value_rows`,
      `uniq(arrayFilter(x -> x != '', \`${colExpr}\`)) as ${alias}__distinct_count`,
    ];
  }
  return [
    `countIf(length(\`${colExpr}\`) > 0) as ${alias}__value_rows`,
    `uniq(\`${colExpr}\`) as ${alias}__distinct_count`,
  ];
}

function columnSqlParts(col) {
  const alias = col.alias;
  const colExpr = col.name;

  const effectiveType =
    col.columnType === ColumnType.GROUPED && col.rawType
      ? col.rawType.startsWith('Array(')
        ? ColumnType.ARRAY
        : col.rawType.startsWith('Map(')
          ? ColumnType.MAP
          : col.columnType
      : col.columnType;

  switch (effectiveType) {
    case ColumnType.MAP:
      return mapColumnSql(colExpr, alias);
    case ColumnType.ARRAY:
      return arrayColumnSql(colExpr, col.valueType, alias);
    case ColumnType.GROUPED:
    case ColumnType.BASIC:
    default:
      return basicColumnSql(colExpr, col.valueType, alias);
  }
}

// ---------------------------------------------------------------------------
// Result row processing
// ---------------------------------------------------------------------------

function applyResultRow(row, columnsByAlias) {
  for (const [key, value] of Object.entries(row)) {
    const sepIdx = key.lastIndexOf('__');
    if (sepIdx === -1) continue;

    const alias = key.slice(0, sepIdx);
    const metric = key.slice(sepIdx + 2);
    const col = columnsByAlias.get(alias);
    if (!col) continue;

    const profile = col.profile;
    switch (metric) {
      case 'map_keys':
        profile.uniqueKeys = Array.isArray(value) ? value : [];
        profile.uniqueValues = profile.uniqueKeys.length;
        break;
      case 'distinct_count':
        profile.uniqueValues = typeof value === 'number' ? value : Number(value) || 0;
        break;
      case 'min_value':
        profile.minValue = value ?? null;
        break;
      case 'max_value':
        profile.maxValue = value ?? null;
        break;
      case 'value_rows':
        profile.valueRows = typeof value === 'number' ? value : Number(value) || 0;
        profile.hasValues = profile.valueRows > 0;
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Batch profiling helper
// ---------------------------------------------------------------------------

async function profileBatch(batch, columns, fromClause, driver, emit, batchIdx, totalBatches) {
  const start = batchIdx * BATCH_SIZE;
  const end = start + batch.length;

  const batchByAlias = new Map();
  for (const col of batch) {
    batchByAlias.set(col.alias, columns.get(col.name));
  }

  const selectParts = [];
  for (const col of batch) {
    selectParts.push(...columnSqlParts(col));
  }
  if (selectParts.length === 0) return;

  const batchSql = `SELECT ${selectParts.join(', ')} FROM ${fromClause}`;

  try {
    const rows = await driver.query(batchSql);
    if (rows.length > 0) applyResultRow(rows[0], batchByAlias);
  } catch (batchErr) {
    console.warn(`[profiler] Batch ${batchIdx + 1} failed (columns ${start + 1}-${end}), falling back: ${batchErr.message}`);
    for (const col of batch) {
      const parts = columnSqlParts(col);
      if (parts.length === 0) continue;
      const individualSql = `SELECT ${parts.join(', ')} FROM ${fromClause}`;
      const singleAlias = new Map([[col.alias, columns.get(col.name)]]);
      try {
        const rows = await driver.query(individualSql);
        if (rows.length > 0) applyResultRow(rows[0], singleAlias);
      } catch (colErr) {
        console.warn(`[profiler] Skipping column "${col.name}": ${colErr.message}`);
      }
    }
  }

  emit('profiling', `Profiled columns ${start + 1}-${end} of ${totalBatches * BATCH_SIZE}`, 0.30 + (0.50 * (batchIdx + 1)) / totalBatches, {
    batch: batchIdx + 1,
    total_batches: totalBatches,
  });
}

// ---------------------------------------------------------------------------
// Main profiler
// ---------------------------------------------------------------------------

/**
 * Profile a ClickHouse table — introspect schema and data characteristics.
 *
 * @param {Object}  driver          CubeJS ClickHouse driver (driver.query(sql) => rows[])
 * @param {string}  schema          Database / schema name
 * @param {string}  table           Table name
 * @param {Object}  [options]
 * @param {string|null}  [options.partition=null]
 * @param {string[]}     [options.internalTables=[]]
 * @param {Array}        [options.filters=[]]       User-specified column filters
 * @param {Object|null}  [options.emitter=null]
 * @param {number}       [options.sampleThreshold=1000000]
 * @returns {Promise<Object>} ProfiledTable
 */
export async function profileTable(driver, schema, table, options = {}) {
  const {
    partition = null,
    internalTables = [],
    filters = [],
    emitter = null,
    sampleThreshold = DEFAULT_SAMPLE_THRESHOLD,
  } = options;

  // Step-counted progress tracker — emits accurate progress based on
  // completed steps rather than hardcoded percentages.
  const tracker = {
    completedSteps: 0,
    totalSteps: 2, // init + initial_profile; recalculated as work becomes known
    startTime: Date.now(),
    stepTimes: [],       // durations of real work steps only (for ETA)
    _lastStepEnd: null,  // timestamp of last markStepTime call

    /**
     * Emit a progress message WITHOUT counting as a completed step.
     * Use for headers, info messages, phase announcements.
     */
    emit: emitter
      ? (phase, msg, detail) => {
          const elapsed = Date.now() - tracker.startTime;
          const progress = tracker.totalSteps > 0
            ? Math.min(tracker.completedSteps / tracker.totalSteps, 0.99)
            : 0;
          const avgStepMs = tracker.stepTimes.length > 0
            ? tracker.stepTimes.reduce((a, b) => a + b, 0) / tracker.stepTimes.length
            : 0;
          const remainingSteps = Math.max(0, tracker.totalSteps - tracker.completedSteps);
          const etaMs = avgStepMs > 0 ? Math.round(remainingSteps * avgStepMs) : null;
          emitter.emit(phase, msg, progress, {
            ...detail,
            step: tracker.completedSteps,
            total_steps: tracker.totalSteps,
            elapsed_ms: elapsed,
            eta_ms: etaMs,
          });
        }
      : () => {},

    /**
     * Mark that a real work step completed. Increments counter and records
     * duration for ETA calculation. Call AFTER the query/batch finishes.
     */
    markStepTime() {
      this.completedSteps++;
      const now = Date.now();
      if (this._lastStepEnd) {
        this.stepTimes.push(now - this._lastStepEnd);
        if (this.stepTimes.length > 10) this.stepTimes.shift();
      }
      this._lastStepEnd = now;
    },

    /** Recalculate total steps once we know the work ahead. */
    setTotalSteps(n) { this.totalSteps = n; },
  };

  // Build partition-only clause first (filters need column names from DESCRIBE).
  // The full clause (partition + filters) is computed after DESCRIBE completes.
  const partitionOnlyClause = buildWhereClause(schema, table, partition, internalTables);

  // Normalize filters — anything non-array becomes empty
  const normalizedFilters = Array.isArray(filters) ? filters : [];

  // =========================================================================
  // Pass 0: Schema discovery (parallel)
  // =========================================================================

  tracker.emit('init', 'Querying table metadata, column types, and descriptions...');

  // When a partition filter or user filter is active, system.parts_columns
  // metadata is unreliable — it reports bytes across ALL partitions, not
  // per-partition. A column may be empty table-wide but populated in the
  // target partition/filtered subset.
  const useMetadata = !partitionOnlyClause && normalizedFilters.length === 0;

  const metaPromise = useMetadata
    ? driver.query(
        `SELECT column, sum(column_data_uncompressed_bytes) as bytes ` +
        `FROM system.parts_columns ` +
        `WHERE database = '${schema}' AND table = '${table}' AND active ` +
        `GROUP BY column`
      ).catch(metaErr => {
        console.warn(`[profiler] Metadata check failed (non-fatal): ${metaErr.message}`);
        return [];
      })
    : Promise.resolve([]);

  // Fetch table comment (description) from system.tables
  const tableCommentPromise = driver.query(
    `SELECT comment FROM system.tables WHERE database = '${schema}' AND name = '${table}'`
  ).catch(err => {
    console.warn(`[profiler] Table comment fetch failed (non-fatal): ${err.message}`);
    return [];
  });

  // Fetch column comments (descriptions) from system.columns
  const columnCommentsPromise = driver.query(
    `SELECT name, comment FROM system.columns WHERE database = '${schema}' AND table = '${table}' AND comment != ''`
  ).catch(err => {
    console.warn(`[profiler] Column comments fetch failed (non-fatal): ${err.message}`);
    return [];
  });

  // Fetch DDL column positions from system.columns to preserve true table order
  const columnOrderPromise = driver.query(
    `SELECT name, position FROM system.columns WHERE database = '${schema}' AND table = '${table}' ORDER BY position`
  ).catch(err => {
    console.warn(`[profiler] Column order fetch failed (non-fatal): ${err.message}`);
    return [];
  });

  const [metaResult, describeRows, tableCommentRows, columnCommentRows, columnOrderRows] = await Promise.all([
    metaPromise,
    driver.query(`DESCRIBE TABLE ${schema}.\`${table}\``),
    tableCommentPromise,
    columnCommentsPromise,
    columnOrderPromise,
  ]);

  // Build column descriptions map
  const columnDescriptions = new Map();
  for (const row of columnCommentRows) {
    if (row.name && row.comment) {
      columnDescriptions.set(row.name, row.comment);
    }
  }

  // Extract table description
  const tableDescription = tableCommentRows.length > 0 ? (tableCommentRows[0].comment || null) : null;

  // Empty columns from system metadata (only when not partition-filtered)
  const emptyColumns = new Set();
  for (const row of metaResult) {
    const bytes = typeof row.bytes === 'number' ? row.bytes : Number(row.bytes) || 0;
    if (bytes === 0) emptyColumns.add(row.column);
  }

  tracker.markStepTime(); // Pass 0 complete

  if (emptyColumns.size > 0) {
    tracker.emit('init', `Found ${emptyColumns.size} columns with zero bytes — will skip`, { empty_columns: emptyColumns.size });
  }

  // Build a stable DDL order map from system.columns.position
  const ddlPositionByName = new Map();
  for (const row of columnOrderRows) {
    if (row?.name != null && row?.position != null) {
      ddlPositionByName.set(row.name, Number(row.position));
    }
  }

  // Order DESCRIBE rows by DDL position when available (fallback: original order)
  const describeRowsWithIndex = describeRows.map((row, index) => ({ row, index }));
  describeRowsWithIndex.sort((a, b) => {
    const aPos = ddlPositionByName.get(a.row.name);
    const bPos = ddlPositionByName.get(b.row.name);
    const aOrder = Number.isFinite(aPos) ? aPos : Number.MAX_SAFE_INTEGER;
    const bOrder = Number.isFinite(bPos) ? bPos : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.index - b.index;
  });
  const columnOrder = describeRowsWithIndex.map(({ row }) => row.name);

  // Build columns map from ordered DESCRIBE rows
  const columns = new Map();
  for (const { row } of describeRowsWithIndex) {
    const colName = row.name;
    const parsed = parseType(row.type, colName);
    columns.set(colName, {
      name: colName,
      rawType: row.type,
      columnType: parsed.columnType,
      valueType: parsed.valueType,
      keyDataType: parsed.keyDataType ?? null,
      valueDataType: parsed.valueDataType ?? null,
      isNullable: parsed.isNullable,
      parentName: parsed.parentName,
      childName: parsed.childName,
      profile: {
        hasValues: false,
        valueRows: 0,
        uniqueValues: 0,
        minValue: null,
        maxValue: null,
        avgValue: null,
        uniqueKeys: [],
        lcValues: null,
        keyStats: null,
        maxArrayLength: null,
      },
    });
  }

  tracker.emit('init', `Discovered ${columns.size} columns`, { column_count: columns.size });

  // Now that we have column names from DESCRIBE, build the full WHERE clause
  // combining partition filtering with any user-specified filters.
  const tableColumnNames = [...columns.keys()];
  const whereClause = normalizedFilters.length > 0
    ? buildWhereClause(schema, table, partition, internalTables, normalizedFilters, tableColumnNames)
    : partitionOnlyClause;

  // =========================================================================
  // Build parent group info (one sentinel per nested group)
  // =========================================================================

  const parentGroupInfo = new Map(); // parent -> { sentinel, colNames, maxLength }

  for (const [name, col] of columns) {
    if (emptyColumns.has(name)) continue;
    if (col.columnType === ColumnType.GROUPED && col.parentName) {
      if (!parentGroupInfo.has(col.parentName)) {
        parentGroupInfo.set(col.parentName, { sentinel: null, sentinelIsArray: false, colNames: [], maxLength: 0 });
      }
      const info = parentGroupInfo.get(col.parentName);
      info.colNames.push(name);

      const isArray = col.rawType?.startsWith('Array(');

      // Pick sentinel: prefer Array-typed columns (length = array depth).
      // For non-Array grouped columns, we use countIf(IS NOT NULL) instead.
      if (!info.sentinel) {
        info.sentinel = name;
        info.sentinelIsArray = !!isArray;
      } else if (isArray && !info.sentinelIsArray) {
        info.sentinel = name;
        info.sentinelIsArray = true;
      }
    }
  }

  // =========================================================================
  // Pass 1: Initial profile (unsampled — streaming aggregates only)
  // =========================================================================

  tracker.emit('initial_profile', 'Running initial profile — row count, ranges, cardinality, group depths...');

  const initialParts = buildInitialProfileParts(columns, parentGroupInfo, emptyColumns);
  const initialSql = `SELECT ${initialParts.join(', ')} FROM ${schema}.\`${table}\`${whereClause}`;

  let rowCount = 0;
  try {
    const rows = await driver.query(initialSql);
    if (rows.length > 0) {
      rowCount = applyInitialProfile(rows[0], columns, parentGroupInfo, emptyColumns);
    }
  } catch (err) {
    console.warn(`[profiler] Initial profile failed, falling back to legacy flow: ${err.message}`);
    // Fallback: at least get row count
    try {
      const countRows = await driver.query(`SELECT count() as cnt FROM ${schema}.\`${table}\`${whereClause}`);
      rowCount = countRows.length > 0 ? (Number(countRows[0].cnt) || 0) : 0;
    } catch (e) { /* give up */ }
  }

  tracker.markStepTime(); // Pass 1 complete
  tracker.emit('initial_profile', `Row count: ${rowCount.toLocaleString()}`, { row_count: rowCount });

  // If user-specified filters produced zero rows, return early with a
  // descriptive error so the caller can surface it to the user.
  if (rowCount === 0 && normalizedFilters.length > 0) {
    const filterDesc = normalizedFilters
      .map(f => `${f.column} ${f.operator} ${JSON.stringify(f.value)}`)
      .join(', ');
    tracker.emit('error', `No rows match the applied filters: ${filterDesc}`);
    return {
      database: schema,
      table,
      partition,
      row_count: 0,
      sampled: false,
      sample_size: null,
      sampling_method: 'none',
      columns,
      columnOrder,
      tableDescription: null,
      columnDescriptions: new Map(),
      filters: normalizedFilters,
      error: `No rows match the applied filters: ${filterDesc}`,
    };
  }

  // Log group depths
  let skippedGroupColumns = 0;
  for (const [parent, info] of parentGroupInfo) {
    if (info.maxLength === 0) {
      skippedGroupColumns += info.colNames.length;
    }
    // Store maxArrayLength on each column in the group
    for (const colName of info.colNames) {
      const col = columns.get(colName);
      if (col) col.profile.maxArrayLength = info.maxLength;
    }
  }

  const totalSkipped = emptyColumns.size + skippedGroupColumns;
  if (totalSkipped > 0) {
    tracker.emit('initial_profile', `Skipping ${totalSkipped} columns (${emptyColumns.size} zero-bytes, ${skippedGroupColumns} empty groups)`, {
      skipped: totalSkipped,
      zero_bytes: emptyColumns.size,
      empty_groups: skippedGroupColumns,
    });
  }

  // =========================================================================
  // Pass 2: Deep profiling (sampled) — Map keys + nested sub-columns
  // =========================================================================

  if (rowCount > 0) {
    // Sampling decision
    const needsSampling = rowCount > sampleThreshold;
    let samplingMethod = 'none';
    let profilingFrom = `${schema}.\`${table}\`${whereClause}`;
    let sampleSize = null;

    if (needsSampling) {
      const sampling = await detectSampling(driver, schema, table, whereClause, SAMPLE_RATIO, rowCount);
      samplingMethod = sampling.method;
      profilingFrom = sampling.fromExpr;
      sampleSize = sampling.sampleRows;
      tracker.emit('profiling', `Sampling ${sampleSize.toLocaleString()} of ${rowCount.toLocaleString()} rows (${samplingMethod})`, {
        sample_size: sampleSize,
        method: samplingMethod,
      });
    }

    // Build list of columns that need deep profiling:
    //   - Map columns with data (need key discovery)
    //   - Nested sub-columns in active groups (need per-column stats)
    //   - Skip scalars (fully covered by initial profile)
    const toProfile = [];
    for (const [name, col] of columns) {
      if (emptyColumns.has(name)) continue;

      if (col.columnType === ColumnType.MAP) {
        if (col.profile.hasValues) {
          toProfile.push({ ...col, alias: name.replace(/\./g, '_') });
        }
      } else if (col.columnType === ColumnType.GROUPED) {
        const groupInfo = parentGroupInfo.get(col.parentName);
        if (groupInfo && groupInfo.maxLength > 0) {
          toProfile.push({ ...col, alias: name.replace(/\./g, '_') });
        }
      }
      // Scalars already profiled in Pass 1 — skip
    }

    if (toProfile.length > 0) {
      const fromClause = profilingFrom;
      const deepBatches = toProfile.length <= SINGLE_QUERY_LIMIT
        ? 1
        : Math.ceil(toProfile.length / BATCH_SIZE);

      // Recalculate total: completed + deep batches (map/LC counts refined later)
      tracker.setTotalSteps(tracker.completedSteps + deepBatches);

      if (toProfile.length <= SINGLE_QUERY_LIMIT) {
        tracker.emit('profiling', `Deep-profiling ${toProfile.length} columns in single query`);

        const allByAlias = new Map();
        for (const col of toProfile) allByAlias.set(col.alias, columns.get(col.name));

        const selectParts = [];
        for (const col of toProfile) selectParts.push(...columnSqlParts(col));

        if (selectParts.length > 0) {
          const sql = `SELECT ${selectParts.join(', ')} FROM ${fromClause}`;
          try {
            const rows = await driver.query(sql);
            if (rows.length > 0) applyResultRow(rows[0], allByAlias);
          } catch (singleErr) {
            console.warn(`[profiler] Single-query deep profile failed, falling back: ${singleErr.message}`);
            for (const col of toProfile) {
              const parts = columnSqlParts(col);
              if (parts.length === 0) continue;
              const individualSql = `SELECT ${parts.join(', ')} FROM ${fromClause}`;
              const singleAlias = new Map([[col.alias, columns.get(col.name)]]);
              try {
                const rows = await driver.query(individualSql);
                if (rows.length > 0) applyResultRow(rows[0], singleAlias);
              } catch (colErr) {
                console.warn(`[profiler] Skipping column "${col.name}": ${colErr.message}`);
              }
            }
          }
        }
        tracker.markStepTime();
        tracker.emit('profiling', `Deep-profiled ${toProfile.length} columns`, {
          columns: toProfile.map(c => c.name),
        });
      } else {
        const totalBatches = Math.ceil(toProfile.length / BATCH_SIZE);
        for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
          const start = batchIdx * BATCH_SIZE;
          const end = Math.min(start + BATCH_SIZE, toProfile.length);
          const batch = toProfile.slice(start, end);
          const batchNames = batch.map(c => c.name).join(', ');
          await profileBatch(batch, columns, fromClause, driver, () => {}, batchIdx, totalBatches);
          tracker.markStepTime();
          tracker.emit('profiling', `Batch ${batchIdx + 1}/${totalBatches}: ${batchNames}`, {
            batch: batchIdx + 1,
            total_batches: totalBatches,
            columns: batch.map(c => c.name),
          });
        }
      }
    } else {
      tracker.emit('profiling', 'All columns profiled in initial pass — no deep profiling needed');
    }

    // =====================================================================
    // Pass 3: LC probe (categoricals) + per-key range stats (numeric maps)
    // =====================================================================

    const lcCandidates = [];
    const mapStatsCandidates = [];

    for (const [name, col] of columns) {
      if (!col.profile.hasValues) continue;

      if (col.columnType === ColumnType.BASIC || col.columnType === ColumnType.GROUPED) {
        // Only LC-probe string/categorical columns with low cardinality
        if (col.valueType === ValueType.STRING || col.valueType === ValueType.OTHER) {
          if (col.profile.uniqueValues > 0 && col.profile.uniqueValues < LC_THRESHOLD) {
            const isArrayGrouped = col.columnType === ColumnType.GROUPED && col.rawType?.startsWith('Array(');
            lcCandidates.push({ name, type: isArrayGrouped ? 'array_grouped' : 'basic' });
          }
        }
        // NUMBER/DATE/BOOLEAN scalars: already have min/max/avg from initial profile — no LC
      } else if (col.columnType === ColumnType.MAP && col.profile.uniqueKeys.length > 0) {
        const isNumericMap = col.valueDataType === ValueType.NUMBER;
        const isBooleanMap = col.valueDataType === ValueType.BOOLEAN;

        for (const key of col.profile.uniqueKeys) {
          if (isNumericMap) {
            mapStatsCandidates.push({ name, key });
          } else if (!isBooleanMap) {
            // String map keys need cardinality check before LC probing
            mapStatsCandidates.push({ name, key, isString: true });
          }
        }
      }
    }

    const lcFrom = `${schema}.\`${table}\`${whereClause}`;

    // --- Per-key stats for Map columns (range for numeric, cardinality for string) ---
    if (mapStatsCandidates.length > 0) {
      const numericKeys = mapStatsCandidates.filter(c => !c.isString);
      const stringKeys = mapStatsCandidates.filter(c => c.isString);

      const mapNumericBatches = Math.ceil(numericKeys.length / 10);
      const mapStringBatches = Math.ceil(stringKeys.length / 10);
      // LC count not yet known — will refine after map stats
      tracker.setTotalSteps(tracker.completedSteps + mapNumericBatches + mapStringBatches);

      tracker.emit('map_stats', `Analyzing ${mapStatsCandidates.length} map keys (${numericKeys.length} numeric, ${stringKeys.length} string)`, {
        numeric_keys: numericKeys.length,
        string_keys: stringKeys.length,
      });

      const statsBatchSize = 10;

      // Numeric keys: min/max/avg
      for (let i = 0; i < numericKeys.length; i += statsBatchSize) {
        const batch = numericKeys.slice(i, i + statsBatchSize);
        const selectParts = [];

        for (const candidate of batch) {
          const alias = candidate.name.replace(/\./g, '_');
          const keyAlias = `${alias}_k_${candidate.key.replace(/[^a-zA-Z0-9]/g, '_')}`;
          const expr = `\`${candidate.name}\`['${candidate.key}']`;
          const hasKey = `mapContains(\`${candidate.name}\`, '${candidate.key}')`;
          selectParts.push(`minIf(${expr}, ${hasKey}) as ${keyAlias}__min_value`);
          selectParts.push(`maxIf(${expr}, ${hasKey}) as ${keyAlias}__max_value`);
          selectParts.push(`avgIf(${expr}, ${hasKey}) as ${keyAlias}__avg_value`);
        }

        const sql = `SELECT ${selectParts.join(', ')} FROM ${lcFrom}`;
        try {
          const rows = await driver.query(sql);
          if (rows.length > 0) {
            const row = rows[0];
            for (const candidate of batch) {
              const alias = candidate.name.replace(/\./g, '_');
              const keyAlias = `${alias}_k_${candidate.key.replace(/[^a-zA-Z0-9]/g, '_')}`;
              const col = columns.get(candidate.name);
              if (!col) continue;

              if (!col.profile.keyStats) col.profile.keyStats = {};
              const minVal = row[`${keyAlias}__min_value`];
              const maxVal = row[`${keyAlias}__max_value`];
              const avgVal = row[`${keyAlias}__avg_value`];
              col.profile.keyStats[candidate.key] = {
                min: minVal ?? null,
                max: maxVal ?? null,
                avg: avgVal != null ? Math.round(Number(avgVal) * 1000) / 1000 : null,
              };
            }
          }
        } catch (err) {
          console.warn(`[profiler] Map numeric range stats failed: ${err.message}`);
        }
        const batchNum = Math.floor(i / statsBatchSize) + 1;
        const keyNames = batch.map(c => `${c.name}[${c.key}]`).join(', ');
        tracker.markStepTime();
        tracker.emit('map_stats', `Numeric keys batch ${batchNum}/${mapNumericBatches}: ${keyNames}`, {
          batch: batchNum,
          total_batches: mapNumericBatches,
          keys: batch.map(c => `${c.name}[${c.key}]`),
        });
      }

      // String keys: per-key uniq() cardinality check — only LC-probe keys under threshold
      for (let i = 0; i < stringKeys.length; i += statsBatchSize) {
        const batch = stringKeys.slice(i, i + statsBatchSize);
        const selectParts = [];

        for (const candidate of batch) {
          const alias = candidate.name.replace(/\./g, '_');
          const keyAlias = `${alias}_k_${candidate.key.replace(/[^a-zA-Z0-9]/g, '_')}`;
          const expr = `\`${candidate.name}\`['${candidate.key}']`;
          selectParts.push(`uniqIf(${expr}, ${expr} != '') as ${keyAlias}__uniq`);
        }

        const sql = `SELECT ${selectParts.join(', ')} FROM ${lcFrom}`;
        try {
          const rows = await driver.query(sql);
          if (rows.length > 0) {
            const row = rows[0];
            for (const candidate of batch) {
              const alias = candidate.name.replace(/\./g, '_');
              const keyAlias = `${alias}_k_${candidate.key.replace(/[^a-zA-Z0-9]/g, '_')}`;
              const col = columns.get(candidate.name);
              if (!col) continue;

              const uniqCount = Number(row[`${keyAlias}__uniq`]) || 0;

              // Store per-key cardinality in keyStats
              if (!col.profile.keyStats) col.profile.keyStats = {};
              col.profile.keyStats[candidate.key] = { unique_values: uniqCount };

              // Only LC-probe keys with low cardinality
              if (uniqCount > 0 && uniqCount < LC_THRESHOLD) {
                lcCandidates.push({ name: candidate.name, type: 'map_key', key: candidate.key });
              }
            }
          }
        } catch (err) {
          console.warn(`[profiler] Map string cardinality check failed: ${err.message}`);
        }
        const batchNum = Math.floor(i / statsBatchSize) + 1;
        const keyNames = batch.map(c => `${c.name}[${c.key}]`).join(', ');
        tracker.markStepTime();
        tracker.emit('map_stats', `String keys batch ${batchNum}/${mapStringBatches}: ${keyNames}`, {
          batch: batchNum,
          total_batches: mapStringBatches,
          keys: batch.map(c => `${c.name}[${c.key}]`),
        });
      }
    }

    // --- LC value enumeration for string/categorical columns ---
    if (lcCandidates.length > 0) {
      const lcBatchSize = 5;
      const lcTotalBatches = Math.ceil(lcCandidates.length / lcBatchSize);
      // Refine total steps with exact LC batch count
      tracker.setTotalSteps(tracker.completedSteps + lcTotalBatches);

      tracker.emit('lc_probe', `Enumerating values for ${lcCandidates.length} low-cardinality columns (${lcTotalBatches} batches)`, {
        candidates: lcCandidates.length,
        batches: lcTotalBatches,
      });

      for (let i = 0; i < lcCandidates.length; i += lcBatchSize) {
        const batch = lcCandidates.slice(i, i + lcBatchSize);
        const selectParts = [];

        for (const candidate of batch) {
          const alias = candidate.name.replace(/\./g, '_');
          if (candidate.type === 'basic') {
            selectParts.push(
              `arraySort(groupUniqArray(${LC_THRESHOLD})(\`${candidate.name}\`)) as ${alias}__lc_values`
            );
          } else if (candidate.type === 'array_grouped') {
            selectParts.push(
              `arraySort(groupUniqArrayArray(${LC_THRESHOLD})(\`${candidate.name}\`)) as ${alias}__lc_values`
            );
          } else if (candidate.type === 'map_key') {
            const keyAlias = `${alias}_k_${candidate.key.replace(/[^a-zA-Z0-9]/g, '_')}`;
            selectParts.push(
              `arraySort(groupUniqArray(${LC_THRESHOLD})(CAST(\`${candidate.name}\`['${candidate.key}'] AS String))) as ${keyAlias}__lc_values`
            );
          }
        }

        if (selectParts.length === 0) continue;

        const lcSql = `SELECT ${selectParts.join(', ')} FROM ${lcFrom}`;
        try {
          const rows = await driver.query(lcSql);
          if (rows.length > 0) {
            const row = rows[0];
            for (const [key, value] of Object.entries(row)) {
              const sepIdx = key.lastIndexOf('__lc_values');
              if (sepIdx === -1) continue;

              const rawAlias = key.slice(0, sepIdx);
              const values = Array.isArray(value)
                ? [...new Set(value.filter(v => v !== '' && v != null && typeof v !== 'object'))]
                : [];

              if (values.length === 0 || values.length >= LC_THRESHOLD) continue;

              for (const candidate of batch) {
                const alias = candidate.name.replace(/\./g, '_');
                if ((candidate.type === 'basic' || candidate.type === 'array_grouped') && rawAlias === alias) {
                  const col = columns.get(candidate.name);
                  if (col) col.profile.lcValues = values;
                } else if (candidate.type === 'map_key') {
                  const keyAlias = `${alias}_k_${candidate.key.replace(/[^a-zA-Z0-9]/g, '_')}`;
                  if (rawAlias === keyAlias) {
                    const col = columns.get(candidate.name);
                    if (col) {
                      if (!col.profile.lcValues) col.profile.lcValues = {};
                      col.profile.lcValues[candidate.key] = values;
                    }
                  }
                }
              }
            }
          }
        } catch (lcErr) {
          console.warn(`[profiler] LC probe failed: ${lcErr.message}`);
        }
        const lcBatchNum = Math.floor(i / lcBatchSize) + 1;
        const colNames = batch.map(c => c.type === 'map_key' ? `${c.name}[${c.key}]` : c.name).join(', ');
        tracker.markStepTime();
        tracker.emit('lc_probe', `LC batch ${lcBatchNum}/${lcTotalBatches}: ${colNames}`, {
          batch: lcBatchNum,
          total_batches: lcTotalBatches,
          columns: batch.map(c => c.type === 'map_key' ? `${c.name}[${c.key}]` : c.name),
        });
      }
    }
  }

  tracker.emit('profiling', 'Profiling complete');

  // =========================================================================
  // Build result
  // =========================================================================

  const needsSampling = rowCount > sampleThreshold;

  // Warn when filters produced a very small dataset — AI metrics may be less reliable
  const warnings = [];
  if (normalizedFilters.length > 0 && rowCount > 0 && rowCount < 100) {
    warnings.push(
      `The profiled data subset has only ${rowCount} rows after filtering. ` +
      'AI-generated metrics may be less reliable with fewer than 100 rows.'
    );
  }

  return {
    database: schema,
    table,
    partition,
    row_count: rowCount,
    sampled: needsSampling,
    sample_size: needsSampling ? Math.min(Math.round(rowCount / SAMPLE_RATIO), SUBQUERY_LIMIT_MAX) : null,
    sampling_method: needsSampling ? 'subquery_limit' : 'none',
    columns,
    columnOrder,
    tableDescription,
    columnDescriptions,
    filters: normalizedFilters.length > 0 ? normalizedFilters : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
