/**
 * ClickHouse table profiler — introspects schema and data characteristics.
 *
 * Performs a two-pass analysis:
 *   1. Schema analysis  — DESCRIBE TABLE to discover columns and types
 *   2. Data profiling   — batched aggregate queries for cardinality, ranges, map keys
 *
 * Ported from the Python prototype in cxs-inbox/libs/core/cxs/core/utils/profile_table.py
 */

import { parseType, ColumnType, ValueType } from './typeParser.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 10;
const DEFAULT_SAMPLE_THRESHOLD = 1_000_000;

// ---------------------------------------------------------------------------
// WHERE clause helper
// ---------------------------------------------------------------------------

/**
 * Build a WHERE clause for partition filtering.
 *
 * @param {string}   schema         Database name
 * @param {string}   table          Table name
 * @param {string|null} partition   Partition value (null = no filter)
 * @param {string[]} internalTables Tables subject to partition filtering
 * @returns {string} A full " WHERE ..." string, or empty string
 */
export function buildWhereClause(schema, table, partition, internalTables) {
  if (!partition) return '';
  if (!Array.isArray(internalTables) || !internalTables.includes(table)) return '';
  return ` WHERE partition IN ('${partition}')`;
}

// ---------------------------------------------------------------------------
// SQL generation helpers
// ---------------------------------------------------------------------------

/**
 * Generate SELECT parts for a BASIC / GROUPED column.
 */
function basicColumnSql(colExpr, valueType, alias) {
  const parts = [];

  if (valueType === ValueType.NUMBER || valueType === ValueType.DATE) {
    parts.push(`min(\`${colExpr}\`) as ${alias}__min_value`);
    parts.push(`max(\`${colExpr}\`) as ${alias}__max_value`);
    parts.push(`countIf(\`${colExpr}\` IS NOT NULL) as ${alias}__value_rows`);
  } else if (valueType === ValueType.STRING) {
    parts.push(`uniqExact(\`${colExpr}\`) as ${alias}__distinct_count`);
    parts.push(`countIf(\`${colExpr}\` IS NOT NULL and \`${colExpr}\` != '') as ${alias}__value_rows`);
  } else {
    parts.push(`uniqExact(\`${colExpr}\`) as ${alias}__distinct_count`);
    parts.push(`countIf(\`${colExpr}\` IS NOT NULL) as ${alias}__value_rows`);
  }

  return parts;
}

/**
 * Generate SELECT parts for a MAP column.
 */
function mapColumnSql(colExpr, alias) {
  return [
    `groupUniqArrayArray(mapKeys(\`${colExpr}\`)) as ${alias}__map_keys`,
    `arrayUniq(flatten(groupArrayArray(mapKeys(\`${colExpr}\`)))) as ${alias}__distinct_count`,
    `countIf(length(mapKeys(\`${colExpr}\`)) > 0) as ${alias}__value_rows`,
  ];
}

/**
 * Generate SELECT parts for an ARRAY column.
 */
function arrayColumnSql(colExpr, valueType, alias) {
  if (valueType === ValueType.STRING) {
    return [
      `countIf(arrayExists(x -> x != '', \`${colExpr}\`)) as ${alias}__value_rows`,
      `arrayUniq(arrayFilter(x -> x != '', arrayFlatten(groupArray(\`${colExpr}\`)))) as ${alias}__distinct_count`,
    ];
  }
  return [
    `countIf(\`${colExpr}\` IS NOT NULL and length(\`${colExpr}\`) > 0) as ${alias}__value_rows`,
    `uniq(\`${colExpr}\`) as ${alias}__distinct_count`,
  ];
}

/**
 * Choose the right SQL generator for a column.
 *
 * @returns {string[]} SQL select parts
 */
function columnSqlParts(col) {
  const alias = col.alias;
  const colExpr = col.name;

  switch (col.columnType) {
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

/**
 * Parse profiling query result rows and populate column profile objects.
 *
 * Result keys follow the pattern `{alias}__{metric}`.
 *
 * @param {Object}   row          Single result row (key-value object)
 * @param {Map}      columnsByAlias  Map of alias -> column entry
 */
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
// Main profiler
// ---------------------------------------------------------------------------

/**
 * Profile a ClickHouse table — introspect schema and data characteristics.
 *
 * @param {Object}  driver          CubeJS ClickHouse driver (driver.query(sql) => rows[])
 * @param {string}  schema          Database / schema name
 * @param {string}  table           Table name
 * @param {Object}  [options]
 * @param {string|null}  [options.partition=null]       Partition value for WHERE filtering
 * @param {string[]}     [options.internalTables=[]]    Tables subject to partition filtering
 * @param {Object|null}  [options.emitter=null]         Progress emitter (emit(step, msg, progress, detail))
 * @param {number}       [options.sampleThreshold=1000000]  Row count above which SAMPLE 0.1 is used
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

  // -------------------------------------------------------------------------
  // Pass 1: Schema analysis
  // -------------------------------------------------------------------------

  emit('schema_analysis', 'Analyzing table schema...', 0.05);

  const describeRows = await driver.query(`DESCRIBE TABLE ${schema}.\`${table}\``);

  /** @type {Map<string, Object>} column name -> ProfiledColumn */
  const columns = new Map();

  for (const row of describeRows) {
    const colName = row.name;
    const rawType = row.type;
    const parsed = parseType(rawType, colName);

    columns.set(colName, {
      name: colName,
      rawType,
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
        uniqueKeys: [],
        lcValues: null,
      },
    });
  }

  emit('schema_analysis', `Found ${columns.size} columns`, 0.1);

  // -------------------------------------------------------------------------
  // Pass 2: Data profiling
  // -------------------------------------------------------------------------

  const whereClause = buildWhereClause(schema, table, partition, internalTables);

  // Row count
  const countRows = await driver.query(
    `SELECT count() as cnt FROM ${schema}.\`${table}\`${whereClause}`
  );
  const rowCount = countRows.length > 0
    ? (typeof countRows[0].cnt === 'number' ? countRows[0].cnt : Number(countRows[0].cnt) || 0)
    : 0;

  const sampled = rowCount > sampleThreshold;
  const sampleClause = sampled ? ' SAMPLE 0.1' : '';
  const sampleSize = sampled ? Math.round(rowCount * 0.1) : null;

  emit('profiling', `Table has ${rowCount} rows${sampled ? ' (will sample)' : ''}`, 0.15);

  if (rowCount > 0) {
    // Build list of columns to profile with their aliases
    const toProfile = [];
    for (const [name, col] of columns) {
      const alias = name.replace(/\./g, '_');
      toProfile.push({ ...col, alias });
    }

    // Batch
    const totalBatches = Math.ceil(toProfile.length / BATCH_SIZE);

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const start = batchIdx * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, toProfile.length);
      const batch = toProfile.slice(start, end);

      const progress = 0.15 + (0.75 * (batchIdx + 1)) / totalBatches;
      emit('profiling', `Profiling columns ${start + 1}-${end} of ${toProfile.length}...`, progress, {
        batch: batchIdx + 1,
        total_batches: totalBatches,
      });

      // Build alias lookup for this batch
      const batchByAlias = new Map();
      for (const col of batch) {
        batchByAlias.set(col.alias, columns.get(col.name));
      }

      // Aggregate SQL
      const selectParts = [];
      for (const col of batch) {
        selectParts.push(...columnSqlParts(col));
      }

      if (selectParts.length === 0) continue;

      const batchSql =
        `SELECT ${selectParts.join(', ')} FROM ${schema}.\`${table}\`${sampleClause}${whereClause}`;

      try {
        const rows = await driver.query(batchSql);
        if (rows.length > 0) {
          applyResultRow(rows[0], batchByAlias);
        }
      } catch (batchErr) {
        // Fallback: try each column individually
        console.warn(
          `[profiler] Batch query failed for columns ${start + 1}-${end}, falling back to individual queries: ${batchErr.message}`
        );

        for (const col of batch) {
          const parts = columnSqlParts(col);
          if (parts.length === 0) continue;

          const individualSql =
            `SELECT ${parts.join(', ')} FROM ${schema}.\`${table}\`${sampleClause}${whereClause}`;

          const singleAlias = new Map([[col.alias, columns.get(col.name)]]);

          try {
            const rows = await driver.query(individualSql);
            if (rows.length > 0) {
              applyResultRow(rows[0], singleAlias);
            }
          } catch (colErr) {
            console.warn(
              `[profiler] Skipping column "${col.name}": ${colErr.message}`
            );
            // Leave profile at defaults (hasValues: false, valueRows: 0)
          }
        }
      }
    }
  }

  emit('profiling', 'Profiling complete', 0.95);

  // -------------------------------------------------------------------------
  // Build result
  // -------------------------------------------------------------------------

  return {
    database: schema,
    table,
    partition,
    row_count: rowCount,
    sampled,
    sample_size: sampleSize,
    columns,
  };
}
