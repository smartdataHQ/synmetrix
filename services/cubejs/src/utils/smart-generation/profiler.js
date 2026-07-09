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

/**
 * Normalize aggregate cells from ClickHouse drivers (UInt64 as string/BigInt)
 * so fill-rate math does not silently become zero.
 *
 * @param {*} v
 * @returns {number}
 */
export function coerceAggNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'bigint') {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

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
    if (Array.isArray(internalTables) && internalTables.length > 0 && internalTables.includes(table)) {
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

  const allParts = [partitionClause, filterClause].filter(Boolean);
  if (allParts.length > 0) {
    return ` WHERE ${allParts.join(' AND ')}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Sampling strategy
// ---------------------------------------------------------------------------

async function detectSampling(driver, schema, table, whereClause, sampleRatio, rowCount, arrayJoinClause = '') {
  const sampleRows = Math.round(rowCount / sampleRatio);
  const baseTable = `${schema}.\`${table}\``;

  // SAMPLE is incompatible with ARRAY JOIN — skip native sampling when array join is active
  if (!arrayJoinClause) {
    try {
      await driver.query(`SELECT 1 FROM ${baseTable} SAMPLE 1/${sampleRatio} LIMIT 1`);
      return {
        fromExpr: `${baseTable} SAMPLE 1/${sampleRatio}${whereClause}`,
        method: 'native',
        sampleRows,
      };
    } catch (e) { /* SAMPLE not supported */ }
  }

  const limitRows = Math.min(sampleRows, SUBQUERY_LIMIT_MAX);
  return {
    fromExpr: `(SELECT * FROM ${baseTable}${arrayJoinClause}${whereClause} LIMIT ${limitRows})`,
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
 *   - uniq() / uniqIf for scalar STRING columns (enums / IPv*: uniq only — '' compare invalid)
 *   - value_rows + distinct for Array columns (same as deep profile)
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
    } else if (col.columnType === ColumnType.ARRAY) {
      parts.push(...arrayColumnSql(name, col.valueType, alias, col.arrayElementUnsafe));
    } else if (col.valueType === ValueType.DATE) {
      parts.push(`min(\`${name}\`) as ${alias}__min`);
      parts.push(`max(\`${name}\`) as ${alias}__max`);
    } else if (col.valueType === ValueType.NUMBER || col.valueType === ValueType.BOOLEAN) {
      parts.push(`min(\`${name}\`) as ${alias}__min`);
      parts.push(`max(\`${name}\`) as ${alias}__max`);
      parts.push(`avg(\`${name}\`) as ${alias}__avg`);
    } else if (col.valueType === ValueType.STRING) {
      parts.push(
        col.unsafeEmptyCompare
          ? `uniq(\`${name}\`) as ${alias}__count`
          : `uniqIf(\`${name}\`, \`${name}\` != '') as ${alias}__count`,
      );
    } else if (col.valueType === ValueType.UUID) {
      parts.push(`uniq(\`${name}\`) as ${alias}__count`);
    } else if (col.columnType === ColumnType.NESTED) {
      parts.push(`countIf(length(\`${name}\`) > 0) as ${alias}__presence`);
    } else if (col.valueType === ValueType.OTHER) {
      // Tuple, JSON, Variant… — skip heavy aggregates; presence drives fill %
      parts.push(`countIf(\`${name}\` IS NOT NULL) as ${alias}__presence`);
    }
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
 * When the full initial SELECT fails but we still have a row_count, derive
 * per-column presence (non-null / non-empty collection) alone — fixes UI fill %
 * that would otherwise stay 0.
 */
function buildPresenceOnlyParts(columns, emptyColumns) {
  const parts = [];
  for (const [name, col] of columns) {
    if (emptyColumns.has(name)) continue;
    if (col.columnType === ColumnType.GROUPED) continue;

    const alias = name.replace(/\./g, '_');

    if (col.columnType === ColumnType.MAP) {
      parts.push(`countIf(length(mapKeys(\`${name}\`)) > 0) as ${alias}__presence`);
    } else if (col.columnType === ColumnType.ARRAY) {
      parts.push(`countIf(length(\`${name}\`) > 0) as ${alias}__presence`);
    } else if (col.columnType === ColumnType.NESTED) {
      parts.push(`countIf(length(\`${name}\`) > 0) as ${alias}__presence`);
    } else {
      parts.push(`countIf(\`${name}\` IS NOT NULL) as ${alias}__presence`);
    }
  }
  return parts;
}

/** @returns {boolean} True if any column received a presence cell */
function applyPresenceOnlyRow(row, columns, emptyColumns, rowCount) {
  let any = false;
  for (const [name, col] of columns) {
    if (emptyColumns.has(name)) continue;
    if (col.columnType === ColumnType.GROUPED) continue;

    const alias = name.replace(/\./g, '_');
    const raw = row[`${alias}__presence`];
    if (raw === undefined) continue;

    any = true;
    const pres = coerceAggNum(raw);
    const capped = Math.min(pres, rowCount);
    col.profile.valueRows = capped;
    col.profile.hasValues = capped > 0;
  }
  return any;
}

/**
 * Apply initial profile results to column profiles and parent groups.
 */
function applyInitialProfile(row, columns, parentGroupInfo, emptyColumns) {
  const n = row.row_count;
  const rowCount = coerceAggNum(n);

  for (const [name, col] of columns) {
    if (emptyColumns.has(name)) continue;
    if (col.columnType === ColumnType.GROUPED) continue;

    const alias = name.replace(/\./g, '_');
    const profile = col.profile;

    if (col.columnType === ColumnType.MAP) {
      const keyCount = coerceAggNum(row[`${alias}__key_count`]);
      profile.uniqueValues = keyCount;
      profile.hasValues = keyCount > 0;
      profile.valueRows = keyCount > 0 ? rowCount : 0;
    } else if (col.columnType === ColumnType.ARRAY) {
      const valueRows = coerceAggNum(row[`${alias}__value_rows`]);
      const distinctCount = coerceAggNum(row[`${alias}__distinct_count`]);
      profile.valueRows = valueRows;
      profile.uniqueValues = distinctCount;
      profile.hasValues = valueRows > 0;
    } else if (col.valueType === ValueType.DATE) {
      profile.minValue = row[`${alias}__min`] ?? null;
      profile.maxValue = row[`${alias}__max`] ?? null;
      profile.hasValues = profile.minValue != null;
      profile.valueRows = profile.hasValues ? rowCount : 0;
    } else if (col.valueType === ValueType.NUMBER || col.valueType === ValueType.BOOLEAN) {
      profile.minValue = row[`${alias}__min`] ?? null;
      profile.maxValue = row[`${alias}__max`] ?? null;
      const avg = row[`${alias}__avg`];
      profile.avgValue = avg != null ? Math.round(coerceAggNum(avg) * 1000) / 1000 : null;
      profile.hasValues = profile.minValue != null;
      profile.valueRows = profile.hasValues ? rowCount : 0;
    } else if (col.valueType === ValueType.STRING || col.valueType === ValueType.UUID) {
      const count = coerceAggNum(row[`${alias}__count`]);
      profile.uniqueValues = count;
      profile.hasValues = count > 0;
      profile.valueRows = count > 0 ? rowCount : 0;
    } else if (col.columnType === ColumnType.NESTED || col.valueType === ValueType.OTHER) {
      if (row[`${alias}__presence`] !== undefined && row[`${alias}__presence`] !== null) {
        const pres = coerceAggNum(row[`${alias}__presence`]);
        const capped = Math.min(pres, rowCount);
        profile.valueRows = capped;
        profile.hasValues = capped > 0;
      }
    }
  }

  // Nested group max lengths
  for (const [parent, info] of parentGroupInfo) {
    const alias = parent.replace(/\./g, '_');
    const val = row[`${alias}__max_length`];
    info.maxLength = val != null ? coerceAggNum(val) : 0;
  }

  return rowCount;
}

// ---------------------------------------------------------------------------
// Pass 2: Deep profiling SQL helpers
// ---------------------------------------------------------------------------

function basicColumnSql(colExpr, valueType, alias, unsafeEmptyCompare) {
  if (valueType === ValueType.NUMBER || valueType === ValueType.DATE) {
    return [
      `min(\`${colExpr}\`) as ${alias}__min_value`,
      `max(\`${colExpr}\`) as ${alias}__max_value`,
      `countIf(\`${colExpr}\` IS NOT NULL) as ${alias}__value_rows`,
    ];
  }
  if (valueType === ValueType.STRING && !unsafeEmptyCompare) {
    return [
      `uniqIf(\`${colExpr}\`, \`${colExpr}\` != '') as ${alias}__distinct_count`,
      `countIf(\`${colExpr}\` IS NOT NULL and \`${colExpr}\` != '') as ${alias}__value_rows`,
    ];
  }
  // STRING enum/IP and all other types: '' compare invalid → use plain uniq + non-null
  return [
    `uniq(\`${colExpr}\`) as ${alias}__distinct_count`,
    `countIf(\`${colExpr}\` IS NOT NULL) as ${alias}__value_rows`,
  ];
}

function mapColumnSql(colExpr, alias) {
  return [
    `groupUniqArrayArray(200)(mapKeys(\`${colExpr}\`)) as ${alias}__map_keys`,
    `countIf(length(mapKeys(\`${colExpr}\`)) > 0) as ${alias}__value_rows`,
  ];
}

function arrayColumnSql(colExpr, valueType, alias, arrayElementUnsafe) {
  // ClickHouse Nested(...) is stored as parallel `Array(...)` siblings that
  // MUST share the same length per row. So `length(col) > 0` for any one
  // sibling is identical for every sibling — it tells you "this row has nested
  // data" but not "this sibling carries any signal". A bool sub-column where
  // every element is NULL or always `false` still reports the same value_rows
  // as the populated `id` sibling, which makes useless fields look populated.
  //
  // Counting distinct values has the same trap:
  //   uniq(arr)          counts distinct ARRAYS (one row's array as a whole)
  //   uniqArray(arr)     counts distinct ELEMENTS across all rows (Array combinator)
  // Smart-gen's downstream consumers (LC threshold gate, lcValues probing,
  // nested-lookup-key detection) all want element-level cardinality.
  //
  // Below we filter elements down to "carries signal" before counting:
  //   string:   non-null AND non-empty
  //   number:   non-null AND non-zero
  //   other:    non-null
  // value_rows then = rows where >=1 element survives the filter.
  //
  // arrayElementUnsafe: some element types (e.g. Enum8 inside Array) can't be
  // safely fed through arrayFilter / arrayElement comparisons in ClickHouse.
  // Fall back to whole-array uniq() + length() in that case — less precise but
  // type-safe.
  if (arrayElementUnsafe) {
    return [
      `countIf(length(\`${colExpr}\`) > 0) as ${alias}__value_rows`,
      `uniq(\`${colExpr}\`) as ${alias}__distinct_count`,
    ];
  }
  if (valueType === ValueType.STRING) {
    const meaningful = `arrayFilter(x -> x IS NOT NULL AND x != '', \`${colExpr}\`)`;
    return [
      `countIf(length(${meaningful}) > 0) as ${alias}__value_rows`,
      `uniqArray(${meaningful}) as ${alias}__distinct_count`,
    ];
  }
  if (valueType === ValueType.NUMBER) {
    // minArray/maxArray ignore NULL natively; pair with non-null/non-zero
    // value_rows so columns of all-zero (or all-null) get hasValues=false.
    const nonNull = `arrayFilter(x -> x IS NOT NULL, \`${colExpr}\`)`;
    const nonZero = `arrayFilter(x -> x IS NOT NULL AND x != 0, \`${colExpr}\`)`;
    return [
      `countIf(length(${nonZero}) > 0) as ${alias}__value_rows`,
      `uniqArray(${nonNull}) as ${alias}__distinct_count`,
      `minArray(\`${colExpr}\`) as ${alias}__min_value`,
      `maxArray(\`${colExpr}\`) as ${alias}__max_value`,
    ];
  }
  // BOOLEAN, DATE, UUID, OTHER — count anything that's non-null
  const nonNull = `arrayFilter(x -> x IS NOT NULL, \`${colExpr}\`)`;
  return [
    `countIf(length(${nonNull}) > 0) as ${alias}__value_rows`,
    `uniqArray(${nonNull}) as ${alias}__distinct_count`,
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
      return arrayColumnSql(colExpr, col.valueType, alias, col.arrayElementUnsafe);
    case ColumnType.GROUPED:
    case ColumnType.BASIC:
    default:
      return basicColumnSql(colExpr, col.valueType, alias, col.unsafeEmptyCompare);
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
        profile.uniqueValues = coerceAggNum(value);
        break;
      case 'min_value':
        profile.minValue = value ?? null;
        break;
      case 'max_value':
        profile.maxValue = value ?? null;
        break;
      case 'value_rows':
        profile.valueRows = coerceAggNum(value);
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
    nestedFilters = [],
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

  // Nested groups requested for ARRAY JOIN — the actual clause is built after
  // DESCRIBE, when we know which sub-columns belong to each group.
  const nestedGroups = nestedFilters.map((nf) => nf.group).filter(Boolean);
  let arrayJoinClause = '';

  // Build partition-only clause first (filters need column names from DESCRIBE).
  // The full clause (partition + filters) is computed after DESCRIBE completes.
  // Note: nestedFilters WHERE conditions use aliased names (after ARRAY JOIN),
  // so they are NOT included in the partition-only clause built here.
  const partitionOnlyClause = buildWhereClause(schema, table, partition, internalTables, [], []);

  // Normalize filters — anything non-array becomes empty
  const normalizedFilters = Array.isArray(filters) ? filters : [];

  // =========================================================================
  // Pass 0: Schema discovery (parallel)
  // =========================================================================

  tracker.emit('init', 'Querying table metadata, column types, and descriptions...');

  // system.parts_columns "zero-byte column skip" is an optimization only.
  // Drivers / CH builds differ; wrong signals skip all aggregates and the UI shows 0% fill.
  // Opt in with PROFILE_SKIP_EMPTY_COLUMNS=1 when you trust metadata.
  const useMetadataEnv =
    String(process.env.PROFILE_SKIP_EMPTY_COLUMNS ?? '').trim() === '1';
  // Keep disabled when partitioned/filtered — bytes are table-wide then.
  const useMetadata =
    useMetadataEnv && !partitionOnlyClause && normalizedFilters.length === 0;

  const metaPromise = useMetadata
    ? driver.query(
        `SELECT \`column\`, sum(column_data_uncompressed_bytes) AS bytes ` +
        `FROM system.parts_columns ` +
        `WHERE database = '${schema}' AND table = '${table}' AND active ` +
        `GROUP BY \`column\``
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

  tracker.markStepTime(); // Pass 0 complete

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
      unsafeEmptyCompare: parsed.unsafeEmptyCompare,
      arrayElementUnsafe: parsed.arrayElementUnsafe,
      mapValueUnsafe: parsed.mapValueUnsafe,
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

  // Zero-byte column skip uses system.parts_columns. Drivers often omit rename `bytes`;
  // treating missing bytes as 0 marks every column empty and skips all aggregates → 0% fill.
  const emptyColumns = new Set();
  for (const row of metaResult) {
    if (typeof row?.column !== 'string' || !columns.has(row.column)) continue;
    if (row.bytes == null || row.bytes === '') continue;
    if (coerceAggNum(row.bytes) === 0) emptyColumns.add(row.column);
  }

  if (emptyColumns.size > 0 && emptyColumns.size === columns.size) {
    tracker.emit(
      'init',
      'parts_columns reports zero bytes for every column (metadata unreliable) — profiling all columns',
      { empty_columns_cleared: columns.size },
    );
    emptyColumns.clear();
  }

  if (emptyColumns.size > 0) {
    tracker.emit('init', `Found ${emptyColumns.size} columns with zero bytes — will skip`, {
      empty_columns: emptyColumns.size,
    });
  }

  // Build ARRAY JOIN clause now that we have the column list.
  // ClickHouse Nested columns (stored as parallel arrays with dotted names)
  // require enumerating each sub-column: ARRAY JOIN `parent.child` AS child_alias
  if (nestedGroups.length > 0) {
    const ajParts = [];
    for (const group of nestedGroups) {
      for (const [colName, col] of columns) {
        if (col.parentName === group && col.childName && col.rawType?.startsWith('Array(')) {
          const alias = colName.replace(/\./g, '_');
          ajParts.push(`\`${colName}\` AS \`${alias}\``);
        }
      }
    }
    if (ajParts.length > 0) {
      arrayJoinClause = ` LEFT ARRAY JOIN ${ajParts.join(', ')}`;
    }
  }

  // Build nested filter WHERE using the aliased names (post-ARRAY JOIN).
  let nestedWhereClause = '';
  if (nestedFilters.length > 0) {
    const parts = [];
    for (const nf of nestedFilters) {
      for (const f of nf.filters || []) {
        const fullCol = f.column.includes('.') ? f.column : `${nf.group}.${f.column}`;
        const alias = fullCol.replace(/\./g, '_');
        if (f.values.length === 1) {
          parts.push(`\`${alias}\` = '${f.values[0].replace(/'/g, "''")}'`);
        } else if (f.values.length > 1) {
          const vals = f.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
          parts.push(`\`${alias}\` IN (${vals})`);
        }
      }
    }
    if (parts.length > 0) {
      nestedWhereClause = parts.join(' AND ');
    }
  }

  // Now that we have column names from DESCRIBE, build the full WHERE clause
  // combining partition filtering with any user-specified filters.
  // Nested filters are handled separately via nestedWhereClause (aliased names).
  const tableColumnNames = [...columns.keys()];
  let whereClause = normalizedFilters.length > 0
    ? buildWhereClause(schema, table, partition, internalTables, normalizedFilters, tableColumnNames)
    : partitionOnlyClause;

  // Append nested filter conditions (using aliased column names)
  if (nestedWhereClause) {
    whereClause = whereClause
      ? `${whereClause} AND ${nestedWhereClause}`
      : ` WHERE ${nestedWhereClause}`;
  }

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
  const initialSql = `SELECT ${initialParts.join(', ')} FROM ${schema}.\`${table}\`${arrayJoinClause}${whereClause}`;

  let rowCount = 0;
  try {
    const rows = await driver.query(initialSql);
    if (rows.length > 0) {
      rowCount = applyInitialProfile(rows[0], columns, parentGroupInfo, emptyColumns);
    }
  } catch (err) {
    console.warn(`[profiler] Initial profile failed, falling back to legacy flow: ${err.message}`);
    // Fallback: row count + per-column presence (non-null) so UI fill % is not stuck at 0
    try {
      const countRows = await driver.query(`SELECT count() as cnt FROM ${schema}.\`${table}\`${arrayJoinClause}${whereClause}`);
      rowCount = countRows.length > 0 ? coerceAggNum(countRows[0].cnt) : 0;
      if (rowCount > 0) {
        const presParts = buildPresenceOnlyParts(columns, emptyColumns);
        if (presParts.length > 0) {
          try {
            const presSql =
              `SELECT ${presParts.join(', ')} FROM ${schema}.\`${table}\`${arrayJoinClause}${whereClause}`;
            const prow = await driver.query(presSql);
            if (prow.length > 0 && applyPresenceOnlyRow(prow[0], columns, emptyColumns, rowCount)) {
              tracker.emit(
                'initial_profile',
                'Used presence-only aggregates after initial profile failure (distinct/ranges may be missing)',
              );
            }
          } catch (e2) {
            console.warn(`[profiler] Presence-only fallback failed: ${e2.message}`);
          }
        }
      }
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
    let profilingFrom = `${schema}.\`${table}\`${arrayJoinClause}${whereClause}`;
    let sampleSize = null;

    if (needsSampling) {
      const sampling = await detectSampling(driver, schema, table, whereClause, SAMPLE_RATIO, rowCount, arrayJoinClause);
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
            // UUID + Enum/IPv* values cannot use `expr != ''` for cardinality
            const unsafeKeyCardinality =
              col.valueDataType === ValueType.UUID || col.mapValueUnsafe;
            mapStatsCandidates.push({ name, key, isString: true, unsafeKeyCardinality });
          }
        }
      }
    }

    const lcFrom = `${schema}.\`${table}\`${arrayJoinClause}${whereClause}`;

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
                avg: avgVal != null ? Math.round(coerceAggNum(avgVal) * 1000) / 1000 : null,
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
          if (candidate.unsafeKeyCardinality) {
            selectParts.push(`uniq(${expr}) as ${keyAlias}__uniq`);
          } else {
            // Count only MEANINGFUL distinct values — a key whose values are all
            // empty / whitespace / '0' is an unused placeholder and must not
            // become a member (spec 080: only-used-fields). Excluding '0' only
            // zeroes keys that are entirely ''/'0'; a key with '0' plus real
            // values keeps its real cardinality.
            selectParts.push(`uniqIf(${expr}, trimBoth(${expr}) != '' AND ${expr} != '0') as ${keyAlias}__uniq`);
          }
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

              const uniqCount = coerceAggNum(row[`${keyAlias}__uniq`]);

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
          const colMeta = columns.get(candidate.name);
          if (candidate.type === 'basic') {
            // Enum/IPv* must be CAST to String for groupUniqArray to be comparable
            const expr = colMeta?.unsafeEmptyCompare
              ? `CAST(\`${candidate.name}\` AS String)`
              : `\`${candidate.name}\``;
            selectParts.push(
              `arraySort(groupUniqArray(${LC_THRESHOLD})(${expr})) as ${alias}__lc_values`
            );
          } else if (candidate.type === 'array_grouped') {
            const expr = colMeta?.arrayElementUnsafe
              ? `arrayMap(x -> CAST(x AS String), \`${candidate.name}\`)`
              : `\`${candidate.name}\``;
            selectParts.push(
              `arraySort(groupUniqArrayArray(${LC_THRESHOLD})(${expr})) as ${alias}__lc_values`
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
