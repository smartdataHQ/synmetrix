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
 * Build a WHERE clause for partition filtering.
 */
export function buildWhereClause(schema, table, partition, internalTables) {
  if (!partition) return '';
  if (!Array.isArray(internalTables) || !internalTables.includes(table)) return '';
  return ` WHERE partition IN ('${partition}')`;
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
      parts.push(`uniq(\`${name}\`) as ${alias}__count`);
    }
    // UUID, OTHER: skip — UUID is always unique, OTHER is unprofilable
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
    } else if (col.valueType === ValueType.STRING) {
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
    parts.push(`uniq(\`${colExpr}\`) as ${alias}__distinct_count`);
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
 * @param {Object|null}  [options.emitter=null]
 * @param {number}       [options.sampleThreshold=1000000]
 * @returns {Promise<Object>} ProfiledTable
 */
export async function profileTable(driver, schema, table, options = {}) {
  const {
    partition = null,
    internalTables = [],
    emitter = null,
    sampleThreshold = DEFAULT_SAMPLE_THRESHOLD,
  } = options;

  const emit = emitter
    ? (step, msg, progress, detail) => emitter.emit(step, msg, progress, detail)
    : () => {};

  const whereClause = buildWhereClause(schema, table, partition, internalTables);

  // =========================================================================
  // Pass 0: Schema discovery (parallel)
  // =========================================================================

  emit('init', 'Schema discovery (metadata + DESCRIBE)...', 0.02);

  // When a partition filter is active, system.parts_columns metadata is
  // unreliable — it reports bytes across ALL partitions, not per-partition.
  // A column may be empty table-wide but populated in the target partition.
  const useMetadata = !whereClause;

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

  const [metaResult, describeRows, tableCommentRows, columnCommentRows] = await Promise.all([
    metaPromise,
    driver.query(`DESCRIBE TABLE ${schema}.\`${table}\``),
    tableCommentPromise,
    columnCommentsPromise,
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

  if (emptyColumns.size > 0) {
    emit('metadata', `Found ${emptyColumns.size} columns with zero bytes (will skip)`, 0.04);
  }

  // Build columns map from DESCRIBE
  const columns = new Map();
  for (const row of describeRows) {
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

  emit('schema_analysis', `Found ${columns.size} columns`, 0.06);

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

  emit('initial_profile', 'Running initial profile (ranges, cardinality, group depths)...', 0.08);

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

  emit('initial_profile', `Row count: ${rowCount}`, 0.12);

  // Log group depths
  let skippedGroupColumns = 0;
  for (const [parent, info] of parentGroupInfo) {
    if (info.maxLength === 0) {
      skippedGroupColumns += info.colNames.length;
      emit('initial_profile', `${parent}: empty (max_length=0), skipping ${info.colNames.length} columns`, 0.13);
    } else {
      emit('initial_profile', `${parent}: max_length=${info.maxLength}, ${info.colNames.length} columns`, 0.13);
    }
    // Store maxArrayLength on each column in the group
    for (const colName of info.colNames) {
      const col = columns.get(colName);
      if (col) col.profile.maxArrayLength = info.maxLength;
    }
  }

  const totalSkipped = emptyColumns.size + skippedGroupColumns;
  emit('initial_profile', `Skipped ${totalSkipped} columns (${emptyColumns.size} zero-bytes + ${skippedGroupColumns} empty groups)`, 0.15);

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
      emit('profiling', `Sampling ${sampleSize} of ${rowCount} rows via ${samplingMethod}`, 0.18);
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

      if (toProfile.length <= SINGLE_QUERY_LIMIT) {
        emit('profiling', `Deep-profiling ${toProfile.length} columns (maps + nested) in a single query...`, 0.20);

        const allByAlias = new Map();
        for (const col of toProfile) allByAlias.set(col.alias, columns.get(col.name));

        const selectParts = [];
        for (const col of toProfile) selectParts.push(...columnSqlParts(col));

        if (selectParts.length > 0) {
          const sql = `SELECT ${selectParts.join(', ')} FROM ${fromClause}`;
          try {
            const rows = await driver.query(sql);
            if (rows.length > 0) applyResultRow(rows[0], allByAlias);
            emit('profiling', 'Deep profiling complete', 0.80);
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
      } else {
        const totalBatches = Math.ceil(toProfile.length / BATCH_SIZE);
        emit('profiling', `Deep-profiling ${toProfile.length} columns in ${totalBatches} batches...`, 0.20);
        for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
          const start = batchIdx * BATCH_SIZE;
          const end = Math.min(start + BATCH_SIZE, toProfile.length);
          const batch = toProfile.slice(start, end);
          await profileBatch(batch, columns, fromClause, driver, emit, batchIdx, totalBatches);
        }
      }
    } else {
      emit('profiling', 'No columns need deep profiling', 0.80);
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

      emit('map_stats', `Collecting per-key stats for ${mapStatsCandidates.length} map keys (${numericKeys.length} numeric, ${stringKeys.length} string)...`, 0.82);

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
      }

      // String keys: per-key uniq() cardinality check — only LC-probe keys under threshold
      for (let i = 0; i < stringKeys.length; i += statsBatchSize) {
        const batch = stringKeys.slice(i, i + statsBatchSize);
        const selectParts = [];

        for (const candidate of batch) {
          const alias = candidate.name.replace(/\./g, '_');
          const keyAlias = `${alias}_k_${candidate.key.replace(/[^a-zA-Z0-9]/g, '_')}`;
          const expr = `\`${candidate.name}\`['${candidate.key}']`;
          selectParts.push(`uniq(${expr}) as ${keyAlias}__uniq`);
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
      }
    }

    // --- LC value enumeration for string/categorical columns ---
    if (lcCandidates.length > 0) {
      emit('lc_probe', `Probing ${lcCandidates.length} low-cardinality candidates...`, 0.88);

      const lcBatchSize = 5;
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
      }
    }
  }

  emit('profiling', 'Profiling complete', 0.95);

  // =========================================================================
  // Build result
  // =========================================================================

  const needsSampling = rowCount > sampleThreshold;

  return {
    database: schema,
    table,
    partition,
    row_count: rowCount,
    sampled: needsSampling,
    sample_size: needsSampling ? Math.min(Math.round(rowCount / SAMPLE_RATIO), SUBQUERY_LIMIT_MAX) : null,
    sampling_method: needsSampling ? 'subquery_limit' : 'none',
    columns,
    tableDescription,
    columnDescriptions,
  };
}
