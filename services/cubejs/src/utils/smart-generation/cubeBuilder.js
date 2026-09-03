/**
 * Cube builder module — converts a ProfiledTable into Cube.js cube
 * definition objects (dimensions, measures, metadata).
 *
 * Ported from Python prototype: cxs-inbox/cube/utils/cube_builder.py
 */

import { processColumn, sanitizeFieldName, buildPathCandidates } from './fieldProcessors.js';
import { ColumnType, ValueType } from './typeParser.js';

// -- Helpers ----------------------------------------------------------------

/**
 * Convert a snake_case field name to a human-readable Title.
 * E.g. "commerce_products_entry_type" → "Commerce Products Entry Type"
 *
 * @param {string} name
 * @returns {string}
 */
function titleFromName(name) {
  const UPPER = new Set(['id', 'gid', 'sku', 'upc', 'ean', 'isbn', 'gtin', 'uom', 'gs1', 'ip', 'url', 'img', 'os', 'ms', 'mgr']);
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((w) => UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Cube.js derives a member/cube title from the name on its own (words split,
 * each capitalized). An explicit title is only worth baking when our
 * acronym-aware form differs from that default — everything else is noise.
 *
 * @param {string} name
 * @returns {string|null} Title to bake, or null when Cube's default suffices
 */
function titleWhenNotDefault(name) {
  const title = titleFromName(name);
  const plain = name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return title === plain ? null : title;
}

/**
 * Sanitize a table name into a valid Cube.js cube identifier.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeCubeName(name) {
  let sanitized = name.replace(/[^a-zA-Z0-9]/g, '_');
  if (/^\d/.test(sanitized)) {
    sanitized = `cube_${sanitized}`;
  }
  sanitized = sanitized.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'cube';
}

/**
 * Pick the shortest unique name for each field from its `_nameCandidates`.
 *
 * Each field's `_nameCandidates` is ordered from leaf (most readable) to
 * fully-qualified. Initially every field is at index 0. When multiple fields
 * share a name, every claimant that has a longer candidate available advances
 * one step. Repeats until no advances. Fields with only one candidate (basic
 * scalars) hold their position; longer-candidate fields step around them.
 *
 * Residual collisions (multiple fields exhausted candidates with the same
 * final name) fall through to deduplicateFields, which appends a suffix.
 *
 * @param {object[]} fields - Each entry should have `_nameCandidates: string[]`.
 *   When absent, the existing `name` is treated as the only candidate.
 * @returns {object[]} The same array, with `name` set to the resolved choice.
 */
function resolveNames(fields) {
  for (const f of fields) {
    if (!Array.isArray(f._nameCandidates) || f._nameCandidates.length === 0) {
      f._nameCandidates = [f.name];
    }
    f._candidateIdx = 0;
    f.name = f._nameCandidates[0];
  }

  const MAX_ITER = 32;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const byName = new Map();
    for (const f of fields) {
      if (!byName.has(f.name)) byName.set(f.name, []);
      byName.get(f.name).push(f);
    }
    let advanced = false;
    for (const [, group] of byName) {
      if (group.length <= 1) continue;
      for (const f of group) {
        if (f._candidateIdx + 1 < f._nameCandidates.length) {
          f._candidateIdx++;
          f.name = f._nameCandidates[f._candidateIdx];
          advanced = true;
        }
      }
    }
    if (!advanced) break;
  }
  return fields;
}

/**
 * Resolve field name collisions within a list of fields.
 * If two fields share the same name, the second is prefixed with its
 * source column name.
 *
 * @param {object[]} fields - Array of { name, sql, type, fieldType, _sourceColumn? }
 * @returns {object[]} De-duplicated fields
 */
function deduplicateFields(fields) {
  const seen = new Map(); // name -> index of first occurrence

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (seen.has(field.name)) {
      // Rename the colliding field by prefixing with source column
      const sourceCol = field._sourceColumn || '';
      const prefix = sanitizeFieldName(sourceCol);
      if (prefix && prefix !== field.name) {
        field.name = `${prefix}_${field.name}`;
      } else {
        field.name = `${field.name}_${i}`;
      }
      // Check again after rename
      if (seen.has(field.name)) {
        field.name = `${field.name}_${i}`;
      }
    }
    seen.set(field.name, i);
  }

  return fields;
}

// -- Nested group lookup key detection --------------------------------------

/** Naming patterns that indicate a lookup/discriminator column. */
const LOOKUP_KEY_PATTERN = /(_of|_type|_kind|_category)$/i;

/**
 * Scan columns to find nested groups that have a lookup key.
 *
 * A lookup key is a GROUPED string sub-column with low-cardinality values
 * (has lcValues). When found, the other sub-columns in that group should
 * use FILTER_PARAMS to resolve values by the lookup key at query time.
 *
 * @param {Map} columns - Map of column name -> column data
 * @returns {Map<string, { lookupColumn: string, lookupChildName: string, lcValues: string[] }>}
 *   Map of parentName -> lookup info
 */
function detectNestedLookupKeys(columns) {
  // Group all GROUPED columns by parent
  const groups = new Map(); // parent -> [columnData]
  for (const [, col] of columns) {
    if (col.columnType === ColumnType.GROUPED && col.parentName) {
      if (!groups.has(col.parentName)) groups.set(col.parentName, []);
      groups.get(col.parentName).push(col);
    }
  }

  const lookups = new Map();
  for (const [parent, cols] of groups) {
    // Find the best lookup key candidate:
    // 1. Prefer columns matching the naming pattern (*_of, *_type, etc.)
    // 2. Fall back to first string column with lcValues
    let best = null;
    for (const col of cols) {
      if (col.valueType !== ValueType.STRING) continue;
      if (!col.profile?.lcValues || !Array.isArray(col.profile.lcValues)) continue;
      if (col.profile.lcValues.length === 0) continue;

      if (LOOKUP_KEY_PATTERN.test(col.childName)) {
        best = col; // naming match — prefer this
        break;
      }
      if (!best) best = col; // first viable candidate
    }

    if (best) {
      lookups.set(parent, {
        lookupColumn: best.name,
        lookupChildName: best.childName,
        lcValues: best.profile.lcValues,
      });
    }
  }

  return lookups;
}

// -- Core builder -----------------------------------------------------------

/**
 * Build a SQL WHERE clause fragment from filter descriptors.
 *
 * @param {Array<{ column: string, operator: string, value: * }>} filters
 * @returns {string} SQL conditions joined by AND (no WHERE keyword)
 */
export function filtersToSqlConditions(filters) {
  const conditions = [];
  for (const f of filters) {
    const op = String(f.operator).toUpperCase();
    if (op === 'IS NULL' || op === 'IS NOT NULL') {
      conditions.push(`${f.column} ${op}`);
    } else if (op === 'IN' || op === 'NOT IN') {
      const vals = (Array.isArray(f.value) ? f.value : [f.value])
        .map((v) => typeof v === 'number' ? v : `'${String(v).replace(/'/g, "''")}'`)
        .join(', ');
      conditions.push(`${f.column} ${op} (${vals})`);
    } else {
      const val = typeof f.value === 'number' ? f.value : `'${String(f.value).replace(/'/g, "''")}'`;
      conditions.push(`${f.column} ${op} ${val}`);
    }
  }
  return conditions.join(' AND ');
}

/** Quote a column identifier for use in generated SELECT lists (simple names unquoted). */
function quoteChIdentForSelectList(name) {
  if (!name || typeof name !== 'string') return null;
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return name;
  return `\`${name.replace(/`/g, '')}\``;
}

/**
 * `SELECT *` plus explicit ALIAS column names (comma-separated) for ClickHouse.
 *
 * @param {string} qualifiedTable - e.g. db.table
 * @param {string[]} [aliasColumnNames]
 * @returns {string}
 */
function formatSelectStarWithAliasColumns(qualifiedTable, aliasColumnNames) {
  const extras = (aliasColumnNames || [])
    .map((n) => quoteChIdentForSelectList(n))
    .filter(Boolean);
  const starSuffix = extras.length > 0 ? `, ${extras.join(', ')}` : '';
  return `SELECT *${starSuffix} FROM ${qualifiedTable}`;
}

/**
 * Build the SQL expression for the cube source.
 *
 * When filters are provided, the cube uses `sql:` with a SELECT…WHERE
 * so queries always return the same subset that was profiled.
 * Cube.js composes its own security-context filters (partition, etc.)
 * on top by wrapping this as a subquery.
 *
 * @param {string} schema - Database/schema name
 * @param {string} table - Table name
 * @param {string|null} partition - Partition value
 * @param {boolean} isInternal - Whether the table is in internalTables
 * @param {Array<{ column: string, operator: string, value: * }>} [filters]
 * @param {string[]} [aliasColumnNames] - ClickHouse ALIAS columns to list after SELECT *
 * @returns {{ sql_table?: string, sql?: string }}
 */
function buildCubeSource(schema, table, partition, isInternal, filters, aliasColumnNames = []) {
  const qualifiedTable = schema ? `${schema}.${table}` : table;
  const conditions = [];

  if (isInternal && partition) {
    conditions.push(`partition = '${partition}'`);
  }

  if (filters && filters.length > 0) {
    conditions.push(filtersToSqlConditions(filters));
  }

  if (conditions.length > 0) {
    return {
      sql: `${formatSelectStarWithAliasColumns(qualifiedTable, aliasColumnNames)} WHERE ${conditions.join(' AND ')}`,
    };
  }
  if (aliasColumnNames && aliasColumnNames.length > 0) {
    return {
      sql: formatSelectStarWithAliasColumns(qualifiedTable, aliasColumnNames),
    };
  }
  return { sql_table: qualifiedTable };
}

/**
 * Process all columns from a profiled table into cube fields.
 *
 * @param {Map} columns - Map of column name -> { details, profile }
 * @param {object} options
 * @param {Array<{column: string, alias: string}>} options.arrayJoinColumns
 * @param {number} options.maxMapKeys
 * @param {string[]} options.primaryKeys
 * @param {Map} [options.columnDescriptions] - Map of column name -> description
 * @returns {{ dimensions: object[], measures: object[], mapKeysDiscovered: number, columnsProfiled: number, columnsSkipped: number }}
 */
function processColumns(columns, options) {
  const {
    arrayJoinColumns = [],
    arrayJoinGroups = [],
    maxMapKeys = 500,
    primaryKeys = [],
    cubeName = 'cube',
    columnDescriptions = new Map(),
    columnOrder = [],
  } = options;
  const arrayJoinColumnNames = arrayJoinColumns.map((a) => a.column);

  const allFields = [];
  let mapKeysDiscovered = 0;
  let columnsProfiled = 0;
  let columnsSkipped = 0;

  // Detect nested groups with lookup keys for FILTER_PARAMS generation
  const nestedLookups = detectNestedLookupKeys(columns);

  for (const [columnName, columnData] of columns) {
    // The profiler stores column data flat: { name, rawType, columnType, ..., profile }
    const profile = columnData.profile;
    const details = columnData; // details fields are on the column data itself

    // Skip columns with no values.
    // Skip any column the profiler evaluated to empty for this slice. The
    // profiler DOES profile nested/GROUPED sub-columns (min/max/uniq per field),
    // so `hasValues === false` means "no usable value in the profiled slice" —
    // for a row-type model that member must NOT appear (only-used-fields; spec
    // 080). A previous exception force-kept non-AJ GROUPED columns on the
    // (now stale) assumption the profiler never profiles arrays; it does, and
    // that leaked dozens of all-empty nested members (commerce.*/screen.*/
    // traits.*/network.*/…) into slices that never populate them. GROUPED
    // columns IN an ARRAY JOIN group are re-emitted by buildArrayJoinCube on the
    // nested-filter path, so dropping the empty carry-over here is safe.
    if (profile && profile.hasValues === false) {
      columnsSkipped++;
      continue;
    }

    // Skip string/UUID columns with 0 unique non-empty values
    // (applies to basic, grouped, and array columns — not maps, which use key expansion)
    if (
      profile &&
      (details.valueType === ValueType.STRING || details.valueType === ValueType.UUID) &&
      details.columnType !== ColumnType.MAP
    ) {
      if ((profile.uniqueValues ?? 0) === 0) {
        columnsSkipped++;
        continue;
      }
    }

    // Skip fields whose only present value is empty / zero — they carry no
    // analytical signal and clutter the model. Three signals are checked:
    //   - String/UUID: uniqueValues===1 with the single LC-probed value being
    //     "", "0", or whitespace-only. (Plain empty strings are already filtered
    //     by uniqIf upstream, but "0"-as-text and whitespace can still slip in.)
    //   - Number basic: min===max===0. min/max are computed for all numeric
    //     scalars during the initial profile pass.
    //   - Number array (nested numeric sub-column): min===max===0 from the
    //     minArray/maxArray aggregates added in profiler.arrayColumnSql.
    if (profile && profile.hasValues) {
      if (
        (details.valueType === ValueType.STRING || details.valueType === ValueType.UUID) &&
        details.columnType !== ColumnType.MAP &&
        profile.uniqueValues === 1 &&
        Array.isArray(profile.lcValues) &&
        profile.lcValues.length === 1
      ) {
        const only = profile.lcValues[0];
        const isEmpty =
          only == null ||
          only === '' ||
          (typeof only === 'string' && only.trim() === '') ||
          only === '0' ||
          only === 0;
        if (isEmpty) {
          columnsSkipped++;
          continue;
        }
      }

      if (
        details.valueType === ValueType.NUMBER &&
        profile.minValue != null &&
        profile.maxValue != null &&
        Number(profile.minValue) === 0 &&
        Number(profile.maxValue) === 0
      ) {
        columnsSkipped++;
        continue;
      }

      // Boolean / Int8-as-bool: always-same value (true OR false) carries no
      // signal. Two signals — basic columns get min/max from Pass 1 but no
      // uniqueValues; array sub-columns get uniqueValues from uniqArray. Use
      // either: minValue === maxValue ⇔ a single distinct value for booleans.
      if (details.valueType === ValueType.BOOLEAN) {
        const singleByCount = profile.uniqueValues === 1;
        const singleByRange = profile.minValue != null
          && profile.maxValue != null
          && profile.minValue === profile.maxValue;
        if (singleByCount || singleByRange) {
          columnsSkipped++;
          continue;
        }
      }
    }

    columnsProfiled++;

    // ---------------------------------------------------------------
    // Nested group with lookup key → FILTER_PARAMS dimensions
    // ---------------------------------------------------------------
    if (details.columnType === ColumnType.GROUPED && details.parentName) {
      const lookup = nestedLookups.get(details.parentName);
      if (lookup) {
        const parentName = details.parentName;
        const childName = details.childName;
        const colDescription = columnDescriptions.get(columnName) || null;

        if (columnName === lookup.lookupColumn) {
          // This IS the lookup key → emit a filter dimension.
          // Candidates: prefer plain `type` when no clash, then parent_type,
          // then deeper qualifiers. After resolveNames runs we rewrite the
          // FILTER_PARAMS refs in every field's SQL to use the final resolved
          // name (see "rebind FILTER_PARAMS lookup refs" below).
          const filterDimName = `${sanitizeFieldName(parentName)}_type`;
          const filterDimRef = `${cubeName}.${filterDimName}`;
          const typeCandidates = buildPathCandidates(`${parentName}.type`);
          const field = {
            name: filterDimName,
            _nameCandidates: typeCandidates,
            sql: `toString({FILTER_PARAMS.${filterDimRef}.filter((v) => v)})`,
            type: 'string',
            fieldType: 'dimension',
            _sourceColumn: columnName,
            _lookupKeyDim: filterDimName, // marks this as the lookup-key dim
            meta: {
              auto_generated: true,
              nested_lookup_key: true,
            },
          };
          // Lean trim (spec 080 §4): the lookup key's valid values are NOT
          // baked — /meta/dynamic + live queries answer value questions
          // freshness-stamped, without rotting or leaking data into the model.
          if (colDescription) field.description = colDescription;
          allFields.push(field);
        } else {
          // Skip nested sub-columns with no non-empty values — but only for
          // ARRAY JOIN groups (they'll get fresh fields via buildArrayJoinCube).
          // Non-AJ groups (like location.*) are never profiled, so uniqueValues
          // stays 0 — let them through to produce FILTER_PARAMS dimensions.
          if (
            arrayJoinGroups.includes(details.parentName) &&
            profile &&
            (details.valueType === ValueType.STRING || details.valueType === ValueType.UUID) &&
            (profile.uniqueValues ?? 0) === 0
          ) {
            columnsSkipped++;
            continue;
          }

          // Same "single empty/zero value" skip as the basic-column path —
          // applied here so nested AJ children with constant garbage (e.g.
          // products.discount_amount that's always 0) don't pollute the cube.
          if (arrayJoinGroups.includes(details.parentName) && profile && profile.hasValues) {
            if (
              (details.valueType === ValueType.STRING || details.valueType === ValueType.UUID) &&
              profile.uniqueValues === 1 &&
              Array.isArray(profile.lcValues) &&
              profile.lcValues.length === 1
            ) {
              const only = profile.lcValues[0];
              const isEmpty =
                only == null ||
                only === '' ||
                (typeof only === 'string' && only.trim() === '') ||
                only === '0' ||
                only === 0;
              if (isEmpty) {
                columnsSkipped++;
                continue;
              }
            }
            if (
              details.valueType === ValueType.NUMBER &&
              profile.minValue != null &&
              profile.maxValue != null &&
              Number(profile.minValue) === 0 &&
              Number(profile.maxValue) === 0
            ) {
              columnsSkipped++;
              continue;
            }
            if (details.valueType === ValueType.BOOLEAN) {
              const singleByCount = profile.uniqueValues === 1;
              const singleByRange = profile.minValue != null
                && profile.maxValue != null
                && profile.minValue === profile.maxValue;
              if (singleByCount || singleByRange) {
                columnsSkipped++;
                continue;
              }
            }
          }

          // This is a data sub-column → emit FILTER_PARAMS-resolved dimension
          const fieldName = `${sanitizeFieldName(parentName)}_${sanitizeFieldName(childName)}`;
          const filterDimRef = `${cubeName}.${sanitizeFieldName(parentName)}_type`;
          // Walk parent.child path so the resolver can drop redundant prefixes
          const dataDimCandidates = buildPathCandidates(`${parentName}.${childName}`);

          // Determine type from the child column
          const isCoordinate = /^(lat|latitude|lon|lng|longitude)$/i.test(childName);
          const fieldType = details.valueType === ValueType.NUMBER ? 'number'
            : details.valueType === ValueType.DATE ? 'time'
            : details.valueType === ValueType.BOOLEAN ? 'boolean'
            : 'string';
          // Coordinates are dimensions; other numbers are measures
          const cubeFieldType = (details.valueType === ValueType.NUMBER && !isCoordinate) ? 'measure' : 'dimension';
          const cubeType = cubeFieldType === 'measure' ? 'sum' : fieldType;

          // FILTER_PARAMS-resolved field — returns the selected element as
          // a string when a filter is set; otherwise stringifies the full array.
          const arrRef = `{CUBE}.\`${parentName}.${childName}\``;
          const idxExpr = `indexOf({CUBE}.\`${parentName}.${lookup.lookupChildName}\`, toString({FILTER_PARAMS.${filterDimRef}.filter((v) => v)}))`;
          const elemExpr = `arrayElementOrNull(${arrRef}, ${idxExpr})`;
          const field = {
            name: fieldName,
            _nameCandidates: dataDimCandidates,
            sql: `if(${idxExpr} > 0, toString(${elemExpr}), toString(${arrRef}))`,
            type: 'string',
            fieldType: 'dimension',
            _sourceColumn: columnName,
            meta: {
              auto_generated: true,
            },
          };
          if (colDescription) field.description = colDescription;
          allFields.push(field);
        }
        continue; // skip normal processing for this column
      }
    }

    // ---------------------------------------------------------------
    // Normal column processing (non-lookup nested, basic, map, array)
    // ---------------------------------------------------------------

    // Enforce maxMapKeys limit for Map columns
    let effectiveProfile = profile;
    if (
      details.columnType === ColumnType.MAP &&
      profile &&
      profile.uniqueKeys
    ) {
      mapKeysDiscovered += profile.uniqueKeys.length;
      if (profile.uniqueKeys.length > maxMapKeys) {
        effectiveProfile = {
          ...profile,
          uniqueKeys: profile.uniqueKeys.slice(0, maxMapKeys),
        };
      }
    }

    const fields = processColumn(details, effectiveProfile, {
      arrayJoinColumns: arrayJoinColumnNames,
    });

    for (const field of fields) {
      // Track source column for deduplication
      field._sourceColumn = columnName;

      // Mark primary key columns
      if (primaryKeys.includes(columnName) && field.fieldType === 'dimension') {
        field.primary_key = true;
        field.public = true;
      }

      // Lean meta (spec 080 §4): `auto_generated` is the merge key (yamlGenerator
      // re-stamps it, and the mergers classify auto vs template/AI by it), so it
      // stays. `source_column`/`field_type` are dropped — the member's own `type`
      // carries the shape and the merge keys by `name`, not by source column.
      field.meta = { auto_generated: true };

      // Column description — Cube-native property, and only on the column's OWN
      // field (name === column): stamping the parent map's description onto every
      // expanded key, or onto derived aggregation measures (`timestamp_min`/
      // `timestamp_max`), repeats one sentence and describes nothing.
      const colDescription = columnDescriptions.get(columnName) || null;
      if (colDescription && !field._mapKey && field.name === columnName) {
        field.description = colDescription;
      }

      // Structural map marker stays (one line, tells consumers this is a map
      // key). Per-key value snapshots (unique_values/lc_values) are NOT baked —
      // they rot, leak data/PII, and /meta/dynamic answers value questions at
      // query time, filter-scoped and freshness-stamped (spec 080 §4).
      if (field._mapKey) {
        field.meta.map_key = field._mapKey;
      }

      // Skip map-expanded fields with no useful data (only when keyStats was populated by profiler)
      if (field._mapKey && profile?.keyStats) {
        const stats = profile.keyStats[field._mapKey];
        if (stats) {
          // Numeric keys: skip if there is no usable signal — all null (key
          // never present) OR all-zero (min===max===0, a placeholder that
          // carries no analytical value, mirroring the basic-column skip).
          if (
            field.fieldType === 'measure' &&
            ((stats.min == null && stats.max == null && stats.avg == null) ||
              (Number(stats.min) === 0 && Number(stats.max) === 0))
          ) {
            continue;
          }
          // String keys: skip if 0 unique non-empty values
          if (field.fieldType === 'dimension' && (stats.unique_values ?? 0) === 0) {
            continue;
          }
        }
      }

      allFields.push(field);
    }

    // For Map columns, also emit native accessor dimensions (the full map column)
    // This lets queries access the map directly without individual key expansion
    if (details.columnType === ColumnType.MAP && profile && profile.uniqueKeys && profile.uniqueKeys.length > 0) {
      const mapFieldName = `${sanitizeFieldName(columnName)}_map`;
      const colDescription = columnDescriptions.get(columnName) || null;
      const nativeMapField = {
        name: mapFieldName,
        // Already qualified by `_map` suffix — no shorter useful candidate
        _nameCandidates: [mapFieldName],
        sql: `toString({CUBE}.\`${columnName}\`)`,
        type: 'string',
        fieldType: 'dimension',
        _sourceColumn: columnName,
        meta: {
          auto_generated: true,
          native_map: true,
          // Key inventory intentionally NOT baked — /meta/dynamic answers it
          // at query time, filter-scoped and freshness-stamped (014).
        },
      };
      if (colDescription) nativeMapField.description = colDescription;
      allFields.push(nativeMapField);
    }
  }

  // Resolve each field to its shortest unique name (drops `parent_` /
  // `mapname_` prefixes when there's no clash), then suffix-dedupe any
  // residual collisions.
  resolveNames(allFields);

  // After resolution, lookup-key dimensions may have been renamed (e.g. from
  // `commerce_products_type` to `type`). Their FILTER_PARAMS refs were baked
  // into both their own SQL and any data-dim SQL that points at them, so we
  // rewrite those refs to use the resolved name. Without this step every
  // FILTER_PARAMS expression on a renamed lookup dim would point at a non-
  // existent dimension.
  for (const lookupField of allFields) {
    if (!lookupField._lookupKeyDim) continue;
    const oldName = lookupField._lookupKeyDim;
    const newName = lookupField.name;
    if (oldName === newName) continue;
    const oldRef = `FILTER_PARAMS.${cubeName}.${oldName}.`;
    const newRef = `FILTER_PARAMS.${cubeName}.${newName}.`;
    for (const f of allFields) {
      if (typeof f.sql === 'string' && f.sql.includes(oldRef)) {
        f.sql = f.sql.split(oldRef).join(newRef);
      }
    }
  }

  deduplicateFields(allFields);

  // Final ordering guard: keep generated fields in DDL column order.
  // This protects against accidental ordering drift in upstream payloads.
  const columnIndex = new Map();
  if (Array.isArray(columnOrder) && columnOrder.length > 0) {
    for (let i = 0; i < columnOrder.length; i++) {
      columnIndex.set(columnOrder[i], i);
    }
  } else {
    let idx = 0;
    for (const colName of columns.keys()) {
      columnIndex.set(colName, idx++);
    }
  }

  const fallbackIndex = Number.MAX_SAFE_INTEGER;
  allFields
    .map((field, idx) => ({
      field,
      idx,
      order: columnIndex.has(field._sourceColumn)
        ? columnIndex.get(field._sourceColumn)
        : fallbackIndex,
    }))
    .sort((a, b) => {
      if (a.order === b.order) return a.idx - b.idx;
      return a.order - b.order;
    })
    .forEach((entry, i) => {
      allFields[i] = entry.field;
    });

  const dimensions = [];
  const measures = [];

  for (const field of allFields) {
    const output = {
      name: field.name,
      sql: field.sql,
      type: field.type,
      meta: field.meta,
      // Transient: the ARRAY JOIN builder and the smart-generate AJ-SQL pruner
      // read the source column here now that `meta.source_column` is trimmed.
      // yamlGenerator whitelists serialized keys, so `_`-props never persist.
      _sourceColumn: field._sourceColumn,
    };

    if (field.description) output.description = field.description;

    if (field.primary_key) {
      output.primary_key = true;
      output.public = true;
    }

    if (field.fieldType === 'measure') {
      measures.push(output);
    } else {
      dimensions.push(output);
    }
  }

  return { dimensions, measures, mapKeysDiscovered, columnsProfiled, columnsSkipped };
}

/**
 * Build the raw (main) cube from a profiled table.
 *
 * @param {object} profiledTable
 * @param {object} options
 * @returns {{ cube: object, mapKeysDiscovered: number, columnsProfiled: number, columnsSkipped: number }}
 */
function buildRawCube(profiledTable, options) {
  const {
    partition = null,
    internalTables = [],
    arrayJoinColumns = [],
    nestedFilters = [],
    maxMapKeys = 500,
    primaryKeys = [],
    cubeName: cubeNameOverride,
    filters = [],
    aliasColumnNames = [],
  } = options;
  const arrayJoinGroups = nestedFilters.map((nf) => nf.group);

  const schema = profiledTable.database;
  const table = profiledTable.table;
  const cubeName = cubeNameOverride || sanitizeCubeName(table);
  const isInternal = internalTables.includes(table);

  const source = buildCubeSource(schema, table, partition, isInternal, filters, aliasColumnNames);

  const { dimensions, measures, mapKeysDiscovered, columnsProfiled, columnsSkipped } =
    processColumns(profiledTable.columns, {
      arrayJoinColumns,
      arrayJoinGroups,
      maxMapKeys,
      primaryKeys,
      cubeName,
      columnOrder: profiledTable.columnOrder || [],
      columnDescriptions: profiledTable.columnDescriptions || new Map(),
    });

  // Add count measure (always present — fundamental for any cube)
  measures.unshift({
    name: 'count',
    sql: '*',
    type: 'count',
    meta: { auto_generated: true },
  });

  // -- Heuristics: partition-first ordering ----------------------------------
  const partitionIdx = dimensions.findIndex((d) => d.name === 'partition');
  if (partitionIdx > 0) {
    const [partitionDim] = dimensions.splice(partitionIdx, 1);
    dimensions.unshift(partitionDim);
  }

  // -- Heuristics: titles only where Cube's derived default falls short -------
  for (const dim of dimensions) { if (!dim.title) dim.title = titleWhenNotDefault(dim.name) ?? undefined; }
  for (const meas of measures) { if (!meas.title) meas.title = titleWhenNotDefault(meas.name) ?? undefined; }

  // -- Heuristics: meta block -------------------------------------------------
  const timeDim = dimensions.find((d) => d.type === 'time' && d.primary_key !== true);
  const grainParts = (primaryKeys || []).length > 0
    ? primaryKeys.map(sanitizeFieldName).join(' + ')
    : 'one row per source record';

  // Lean cube meta (spec 080 §4): `grain` (a short identifier list) stays;
  // `grain_description` (a sentence duplicating it) and the volatile
  // `generated_at` are dropped — the latter also breaks byte-identical reruns
  // (SC-002). `source_database`/`source_table`/`time_dimension`/`time_zone` stay.
  const meta = {
    auto_generated: true,
    source_database: schema,
    source_table: table,
    grain: grainParts,
    time_dimension: timeDim ? timeDim.name : null,
    time_zone: 'UTC',
  };

  if (isInternal && partition) {
    meta.source_partition = partition;
  }

  // -- Heuristics: format inference -------------------------------------------
  const CURRENCY_PATTERN = /^(revenue|tax|discount|cogs|commission|amount|fee|total|balance)$|_(price|cost|revenue|fee|amount)$/i;
  const PERCENT_PATTERN = /_(percentage|pct|ratio|rate)$/i;
  for (const meas of measures) {
    if (meas.format) continue;
    if (CURRENCY_PATTERN.test(meas.name)) meas.format = 'currency';
    else if (PERCENT_PATTERN.test(meas.name)) meas.format = 'percent';
  }

  // -- Heuristics: public:false on plumbing fields ----------------------------
  const PLUMBING_PATTERN = /^(message_id|event_gid|anonymous_gid|session_gid|user_gid|write_key|ttl_days)$|_gid$/;
  for (const dim of dimensions) {
    if (dim.public !== undefined) continue;
    if (PLUMBING_PATTERN.test(dim.name)) dim.public = false;
  }

  // -- Heuristics: drill members on count -------------------------------------
  const countMeasure = measures.find((m) => m.type === 'count');
  if (countMeasure) {
    const drillCandidates = dimensions
      .filter((d) => d.type === 'string' && !d.name.includes('_id') && !d.name.includes('_gid') && d.public !== false)
      .slice(0, 5)
      .map((d) => d.name);
    if (drillCandidates.length > 0) {
      countMeasure.drill_members = drillCandidates;
    }
  }

  // Pre-aggregations are intentionally not auto-generated. The smart-gen
  // path emits the cube without rollups; users add pre-aggregations
  // explicitly when they understand the query patterns. Auto-rollups based
  // on heuristics tend to bloat CubeStore with unused materializations and
  // surprise users with hidden refresh schedules.

  const cube = {
    name: cubeName,
    title: titleWhenNotDefault(cubeName) ?? undefined,
    description: profiledTable.tableDescription || `Analytical model for ${schema}.${table}, auto-generated from table profiling.`,
    ...source,
    meta,
    dimensions,
    measures,
  };

  return { cube, mapKeysDiscovered, columnsProfiled, columnsSkipped };
}

/**
 * Derive a cube name from flat row filters.
 * Only `=` and `IN` filters contribute — other operators (`!=`, `LIKE`, range,
 * IS NULL) produce ambiguous names and are ignored.
 *
 * E.g., [{ column: 'event', operator: '=', value: 'Stockout Ended' }]
 *   → "stockout_ended"
 *
 * @param {Array<{column: string, operator: string, value: *}>} filters
 * @param {object} [options]
 * @param {number} [options.maxLength=60] - Cap on the produced identifier length
 * @returns {string} Sanitized identifier or empty string
 */
export function deriveCubeNameFromFlatFilters(filters, { maxLength = 60 } = {}) {
  if (!filters || filters.length === 0) return '';

  const parts = [];
  for (const f of filters) {
    const op = String(f?.operator || '').toUpperCase();
    if (op !== '=' && op !== 'IN') continue;

    const values = Array.isArray(f.value) ? f.value : [f.value];
    for (const v of values) {
      if (v == null) continue;
      const slug = String(v)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (slug) parts.push(slug);
    }
  }

  if (parts.length === 0) return '';

  let joined = parts.join('_');
  if (joined.length > maxLength) joined = joined.slice(0, maxLength).replace(/_+$/, '');
  return sanitizeCubeName(joined);
}

/**
 * Derive a cube name suffix from nested filter values.
 * E.g., ["Line Item", "Cart Item"] → "line_items_cart_items"
 *
 * @param {Array<{column: string, values: string[]}>} filters
 * @returns {string} Sanitized suffix or empty string
 */
function deriveCubeNameFromFilters(filters) {
  if (!filters || filters.length === 0) return '';

  const parts = [];
  for (const f of filters) {
    for (const v of f.values) {
      // "Line Item" → "line_item", then pluralize naively
      let slug = v.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (slug && !slug.endsWith('s')) slug += 's';
      if (slug) parts.push(slug);
    }
  }
  return parts.join('_');
}

/**
 * Build a flattened ARRAY JOIN cube for one or more nested array groups.
 *
 * @param {object} profiledTable
 * @param {string[]} arrayJoinGroups - Parent group names (e.g. ["commerce.products"])
 * @param {object} rawCube - The already-built raw cube (to inherit non-array fields)
 * @param {object} options
 * @returns {object} Cube definition
 */
function buildArrayJoinCube(profiledTable, arrayJoinGroups, rawCube, options) {
  const {
    partition = null,
    internalTables = [],
    nestedFilters = [],
    aliasColumnNames = [],
  } = options;

  const schema = profiledTable.database;
  const table = profiledTable.table;
  const isInternal = internalTables.includes(table);

  // Collect all Array-typed child columns for the selected groups.
  // Only Array columns can be ARRAY JOINed — scalar dotted columns
  // (e.g. commerce.details Nullable(String)) are excluded.
  const groupColumns = new Map(); // group -> [colData]
  for (const [colName, colData] of profiledTable.columns) {
    if (colData.columnType !== ColumnType.GROUPED || !colData.parentName) continue;
    if (!arrayJoinGroups.includes(colData.parentName)) continue;
    if (!colData.rawType?.startsWith('Array(')) continue;
    if (!groupColumns.has(colData.parentName)) groupColumns.set(colData.parentName, []);
    groupColumns.get(colData.parentName).push(colData);
  }

  // Warn if no child columns were found for any of the requested groups
  if (groupColumns.size === 0 && arrayJoinGroups.length > 0) {
    console.warn(
      `[cubeBuilder] buildArrayJoinCube: no child columns found for array join groups: ${arrayJoinGroups.join(', ')}. ` +
      `The resulting cube will have no group-specific dimensions/measures.`
    );
  }

  // Derive cube name from table + filter values (or group names if no filters)
  const allFilters = nestedFilters.flatMap((nf) => nf.filters || []);
  const filterSuffix = deriveCubeNameFromFilters(allFilters);
  const groupSuffix = filterSuffix || arrayJoinGroups.map((g) => sanitizeCubeName(g)).join('_');
  const cubeName = sanitizeCubeName(`${table}_${groupSuffix}`);

  // Ensure nested filter columns are always in the ARRAY JOIN even if
  // the user deselected them — the WHERE clause depends on them.
  const filterColumns = new Set();
  for (const nf of nestedFilters) {
    for (const f of nf.filters || []) {
      const fullCol = f.column.includes('.') ? f.column : `${nf.group}.${f.column}`;
      filterColumns.add(fullCol);
    }
  }

  // Build the ARRAY JOIN SQL — enumerate each sub-column with an alias.
  // ClickHouse Nested columns (parallel arrays with dotted names) require:
  //   ARRAY JOIN `parent.child1` AS child1_alias, `parent.child2` AS child2_alias
  // Format with newlines for readability in the model editor.
  const ajParts = [];
  const ajColumnNames = new Set();
  for (const [group, cols] of groupColumns) {
    for (const col of cols) {
      const alias = col.name.replace(/\./g, '_');
      ajParts.push(`  \`${col.name}\` AS \`${alias}\``);
      ajColumnNames.add(col.name);
    }
  }
  // Add any filter columns that weren't in the selected columns
  for (const filterCol of filterColumns) {
    if (!ajColumnNames.has(filterCol)) {
      const alias = filterCol.replace(/\./g, '_');
      ajParts.push(`  \`${filterCol}\` AS \`${alias}\``);
    }
  }
  let sql;
  if (ajParts.length > 0) {
    // Build explicit SELECT of non-nested columns only.
    // DO NOT use SELECT * — it exposes original Array columns (e.g.
    // `commerce.products.entry_type` Array(String)) alongside the
    // ARRAY JOIN aliases (`commerce_products_entry_type` scalar).
    // When Cube.js wraps this in a subquery, both exist and ClickHouse
    // may resolve references to the Array version, causing type errors.
    //
    // The ARRAY JOIN aliases must also be in the SELECT so they're visible
    // when Cube.js wraps this in a subquery.
    const selectParts = [];
    const basePhysicalNames = new Set();
    for (const [colName, colData] of profiledTable.columns) {
      // Skip ALL nested/grouped columns — they're Array types and can't be
      // used directly in SQL. ARRAY JOIN group children are added below as
      // scalar alias names. Other groups (e.g. location.*) are excluded since
      // they don't have ARRAY JOIN expansion in this cube.
      if (colData.columnType === ColumnType.GROUPED) continue;
      if (colData.columnType === ColumnType.NESTED) continue;
      basePhysicalNames.add(colName);
      // Only backtick-quote names with dots or special chars; simple names stay unquoted
      const needsQuote = /[^a-zA-Z0-9_]/.test(colName);
      selectParts.push(needsQuote ? `  \`${colName}\`` : `  ${colName}`);
    }
    // ALIAS columns may be omitted from the profiler map but must appear in SELECT
    for (const aliasName of aliasColumnNames) {
      if (basePhysicalNames.has(aliasName)) continue;
      const needsQuote = /[^a-zA-Z0-9_]/.test(aliasName);
      selectParts.push(needsQuote ? `  \`${aliasName}\`` : `  ${aliasName}`);
    }
    // Add ARRAY JOIN alias names (scalar after JOIN) so they project into
    // Cube.js subquery scope. Use the alias name only (not "x AS y" again).
    for (const [, cols] of groupColumns) {
      for (const col of cols) {
        selectParts.push(`  ${col.name.replace(/\./g, '_')}`);
      }
    }
    for (const filterCol of filterColumns) {
      if (!ajColumnNames.has(filterCol)) {
        selectParts.push(`  ${filterCol.replace(/\./g, '_')}`);
      }
    }
    sql = `SELECT\n${selectParts.join(',\n')}\nFROM ${schema}.${table}\nLEFT ARRAY JOIN\n${ajParts.join(',\n')}`;
  } else {
    sql = formatSelectStarWithAliasColumns(`${schema}.${table}`, aliasColumnNames);
  }

  // Collect WHERE conditions — use aliased names (dots → underscores)
  const whereParts = [];
  if (isInternal && partition) {
    whereParts.push(`partition = '${partition}'`);
  }
  for (const nf of nestedFilters) {
    for (const f of nf.filters || []) {
      const fullCol = f.column.includes('.') ? f.column : `${nf.group}.${f.column}`;
      const alias = fullCol.replace(/\./g, '_');
      if (f.values.length === 1) {
        whereParts.push(`\`${alias}\` = '${f.values[0].replace(/'/g, "''")}'`);
      } else if (f.values.length > 1) {
        const vals = f.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
        whereParts.push(`\`${alias}\` IN (${vals})`);
      }
    }
  }
  if (whereParts.length > 0) {
    sql += `\nWHERE ${whereParts.join('\n  AND ')}`;
  }

  // Start with non-array dimensions/measures from the raw cube.
  // Exclude dimensions/measures whose source column belongs to an ARRAY JOIN
  // group — the raw cube references Array columns directly, but the AJ cube
  // replaces them with exploded scalar aliases.
  // FILTER_PARAMS dimensions for AJ groups also break (indexOf on scalar = error).
  // However, FILTER_PARAMS dimensions for NON-AJ groups (e.g. location.*) are
  // valid — those arrays are not exploded by ARRAY JOIN and indexOf still works.
  const ajGroupColumnNames = new Set();
  for (const [, cols] of groupColumns) {
    for (const col of cols) ajGroupColumnNames.add(col.name);
  }
  const isAjGroupColumn = (sourceCol) => {
    if (!sourceCol) return false;
    // Check if source column is directly in the AJ group
    if (ajGroupColumnNames.has(sourceCol)) return true;
    // Check if the parent group of this column is an AJ group
    const dotIdx = sourceCol.indexOf('.');
    if (dotIdx > 0) {
      const parent = sourceCol.substring(0, dotIdx);
      return arrayJoinGroups.includes(parent);
    }
    return false;
  };
  const dimensions = rawCube.dimensions
    .filter((d) => {
      // AJ-group source columns are re-emitted as flattened members below, so
      // drop the raw-cube carry-overs. The source column now lives on the
      // transient `_sourceColumn` (meta.source_column is trimmed — §4); this
      // also covers the FILTER_PARAMS dims that read the same key.
      if (isAjGroupColumn(d._sourceColumn)) return false;
      return true;
    })
    .map((d) => ({ ...d }));
  const survivingDimNames = new Set(dimensions.map((d) => d.name));
  const measures = rawCube.measures
    .filter((m) => {
      if (isAjGroupColumn(m._sourceColumn)) return false;
      // Paired counts reference a dimension — check it survived
      if (m.meta?.filtered_count_for && !survivingDimNames.has(m.meta.filtered_count_for)) return false;
      // Drill members that reference removed dimensions
      if (m.drill_members) {
        m.drill_members = m.drill_members.filter((d) => survivingDimNames.has(d));
      }
      return true;
    })
    .map((m) => ({ ...m }));

  // Add dimensions/measures for each child column in the selected groups
  const existingNames = new Set([
    ...dimensions.map((d) => d.name),
    ...measures.map((m) => m.name),
  ]);

  // Collect new fields with shortest-unique candidate lists, then run a
  // local resolver that respects the names already taken by carried-over
  // dimensions/measures. This drops `parent_` prefixes when the leaf is
  // unique, e.g. `commerce_products_id` → `id` when nothing else owns `id`.
  const newAjFields = [];
  for (const [group, cols] of groupColumns) {
    for (const col of cols) {
      const colAlias = col.name.replace(/\./g, '_');
      const candidates = buildPathCandidates(col.name);
      // Always include the dotted-underscore alias as a final fallback so
      // existing collision behavior still has somewhere to land.
      if (!candidates.includes(colAlias)) candidates.push(colAlias);

      let cubeType = 'string';
      if (col.valueType === ValueType.NUMBER) cubeType = 'number';
      else if (col.valueType === ValueType.DATE) cubeType = 'time';
      else if (col.valueType === ValueType.BOOLEAN) cubeType = 'boolean';

      const sql = `{CUBE}.${colAlias}`;
      // `source_group` is a structural AJ marker (kept); `source_column` is
      // trimmed from meta (§4) and carried on the transient `_sourceColumn` so
      // the smart-generate AJ-SQL pruner still knows this member's source col.
      const meta = { auto_generated: true, source_group: group };
      if (col.valueType === ValueType.NUMBER) {
        newAjFields.push({
          name: candidates[0], _nameCandidates: candidates,
          sql, type: 'sum', meta, _bucket: 'measure', _sourceColumn: col.name,
        });
      } else {
        newAjFields.push({
          name: candidates[0], _nameCandidates: candidates,
          sql, type: cubeType, meta, _bucket: 'dimension', _sourceColumn: col.name,
        });
      }
    }
  }

  // Pin already-taken names by giving them single-candidate placeholders;
  // resolveNames will then route the new AJ fields around them.
  const resolveSet = [
    ...[...existingNames].map((name) => ({ name, _nameCandidates: [name] })),
    ...newAjFields,
  ];
  resolveNames(resolveSet);
  for (const f of newAjFields) {
    if (f._bucket === 'measure') {
      measures.push({ name: f.name, sql: f.sql, type: f.type, meta: f.meta, _sourceColumn: f._sourceColumn });
    } else {
      dimensions.push({ name: f.name, sql: f.sql, type: f.type, meta: f.meta, _sourceColumn: f._sourceColumn });
    }
    existingNames.add(f.name);
  }

  // Titles only where Cube's derived default falls short
  for (const dim of dimensions) { if (!dim.title) dim.title = titleWhenNotDefault(dim.name) ?? undefined; }
  for (const meas of measures) { if (!meas.title) meas.title = titleWhenNotDefault(meas.name) ?? undefined; }

  const meta = {
    auto_generated: true,
    source_database: schema,
    source_table: table,
    array_join_groups: arrayJoinGroups,
    nested_filters: nestedFilters.length > 0 ? nestedFilters : undefined,
  };

  if (isInternal && partition) {
    meta.source_partition = partition;
  }

  return {
    name: cubeName,
    title: titleWhenNotDefault(cubeName) ?? undefined,
    description: profiledTable.tableDescription || `Analytical model for ${schema}.${table}, auto-generated from table profiling.`,
    sql,
    meta,
    dimensions,
    measures,
  };
}

// -- Main entry point -------------------------------------------------------

/**
 * Build Cube.js cube definitions from a profiled ClickHouse table.
 *
 * @param {object} profiledTable
 *   @param {string} profiledTable.database - Database/schema name
 *   @param {string} profiledTable.table - Table name
 *   @param {string|null} profiledTable.partition - Partition value
 *   @param {Map} profiledTable.columns - Map of columnName -> { details, profile }
 * @param {object} [options]
 *   @param {string|null} [options.partition] - Partition value
 *   @param {string[]} [options.internalTables] - Tables subject to partition filtering
 *   @param {Array<{column: string, alias: string}>} [options.arrayJoinColumns] - Columns for ARRAY JOIN
 *   @param {number} [options.maxMapKeys] - Max Map keys per column (default 500)
 *   @param {string[]} [options.primaryKeys] - Primary key column names
 *   @param {string[]} [options.aliasColumnNames] - ClickHouse ALIAS columns to append after SELECT *
 * @returns {{
 *   cubes: object[],
 *   summary: {
 *     dimensions_count: number,
 *     measures_count: number,
 *     cubes_count: number,
 *     map_keys_discovered: number,
 *     columns_profiled: number,
 *     columns_skipped: number,
 *   }
 * }}
 */
export { mergeAIMetrics };

export function buildCubes(profiledTable, options = {}) {
  const {
    arrayJoinColumns = [],
    nestedFilters = [],
  } = options;

  const cubes = [];

  // Always build the raw cube — needed for field processing and heuristics.
  // When nested filters are active, the raw cube is used as a base but NOT emitted.
  const { cube: rawCube, mapKeysDiscovered, columnsProfiled, columnsSkipped } =
    buildRawCube(profiledTable, options);

  if (nestedFilters.length > 0) {
    // Nested-filter path: emit ONLY the array-joined cube.
    // The raw cube is used internally for base field processing but discarded.
    const groups = nestedFilters.map((nf) => nf.group);
    const ajCube = buildArrayJoinCube(profiledTable, groups, rawCube, options);

    // Apply heuristics that buildRawCube applies but buildArrayJoinCube doesn't:
    // - Partition-first ordering
    const partitionIdx = ajCube.dimensions.findIndex((d) => d.name === 'partition');
    if (partitionIdx > 0) {
      const [partitionDim] = ajCube.dimensions.splice(partitionIdx, 1);
      ajCube.dimensions.unshift(partitionDim);
    }

    // - Grain + meta enrichment
    const timeDim = ajCube.dimensions.find((d) => d.type === 'time' && d.primary_key !== true);
    const primaryKeys = options.primaryKeys || [];
    const grainParts = primaryKeys.length > 0
      ? primaryKeys.map(sanitizeFieldName).join(' + ')
      : 'one row per source record';
    ajCube.meta.grain = grainParts;
    // grain_description trimmed (§4) — `grain` already carries the identifier.
    ajCube.meta.time_dimension = timeDim ? timeDim.name : null;
    ajCube.meta.time_zone = 'UTC';

    // - Drill members on count
    const countMeasure = ajCube.measures.find((m) => m.type === 'count');
    if (countMeasure && !countMeasure.drill_members) {
      const drillCandidates = ajCube.dimensions
        .filter((d) => d.type === 'string' && !d.name.includes('_id') && !d.name.includes('_gid') && d.public !== false)
        .slice(0, 5)
        .map((d) => d.name);
      if (drillCandidates.length > 0) countMeasure.drill_members = drillCandidates;
    }

    // - Format inference
    const CURRENCY_PATTERN = /^(revenue|tax|discount|cogs|commission|amount|fee|total|balance)$|_(price|cost|revenue|fee|amount)$/i;
    const PERCENT_PATTERN = /_(percentage|pct|ratio|rate)$/i;
    for (const meas of ajCube.measures) {
      if (meas.format) continue;
      if (CURRENCY_PATTERN.test(meas.name)) meas.format = 'currency';
      else if (PERCENT_PATTERN.test(meas.name)) meas.format = 'percent';
    }

    // - Public:false on plumbing
    const PLUMBING_PATTERN = /^(message_id|event_gid|anonymous_gid|session_gid|user_gid|write_key|ttl_days)$|_gid$/;
    for (const dim of ajCube.dimensions) {
      if (dim.public !== undefined) continue;
      if (PLUMBING_PATTERN.test(dim.name)) dim.public = false;
    }

    // Pre-aggregations intentionally omitted — see buildRawCube comment.
    cubes.push(ajCube);
  } else if (arrayJoinColumns.length > 0) {
    // Legacy ARRAY JOIN path: raw cube + separate flattened cubes
    cubes.push(rawCube);
    for (const ajDef of arrayJoinColumns) {
      const legacyCube = buildArrayJoinCube(profiledTable, [ajDef.column], rawCube, {
        ...options,
        nestedFilters: [],
      });
      legacyCube.name = sanitizeCubeName(`${profiledTable.table}_${ajDef.alias}`);
      const qualifiedTable = `${profiledTable.database}.${profiledTable.table}`;
      const isInternal = (options.internalTables || []).includes(profiledTable.table);
      const aliasExtra = (options.aliasColumnNames || [])
        .map((n) => quoteChIdentForSelectList(n))
        .filter(Boolean);
      const aliasPrefix = aliasExtra.length > 0 ? `, ${aliasExtra.join(', ')}` : '';
      let legacySql = `SELECT *${aliasPrefix}, ${ajDef.column} AS ${ajDef.alias} FROM ${qualifiedTable} LEFT ARRAY JOIN ${ajDef.column} AS ${ajDef.alias}`;
      if (isInternal && options.partition) {
        legacySql += ` WHERE partition = '${options.partition}'`;
      }
      legacyCube.sql = legacySql;
      legacyCube.meta.array_join_column = ajDef.column;
      legacyCube.meta.array_join_alias = ajDef.alias;

      // Surface the user-supplied AJ alias as a dimension. Without this the
      // exploded array element has no addressable name in the cube — the SQL
      // exposes `<alias>` as a column but no Cube.js dimension maps to it.
      // Skip if a dimension with that name already exists (collision-safe).
      const aliasName = sanitizeFieldName(ajDef.alias);
      if (aliasName && !legacyCube.dimensions.some((d) => d.name === aliasName)) {
        legacyCube.dimensions.push({
          name: aliasName,
          sql: `{CUBE}.${aliasName}`,
          type: 'string',
          meta: {
            auto_generated: true,
            array_join_alias: ajDef.alias,
          },
          // source_column trimmed from meta (§4); kept transiently for the pruner.
          _sourceColumn: ajDef.column,
        });
      }

      cubes.push(legacyCube);
    }
  } else {
    // No array join: just the raw cube
    cubes.push(rawCube);
  }

  // 3. Compute summary
  let totalDimensions = 0;
  let totalMeasures = 0;
  for (const cube of cubes) {
    totalDimensions += cube.dimensions.length;
    totalMeasures += cube.measures.length;
  }

  return {
    cubes,
    summary: {
      dimensions_count: totalDimensions,
      measures_count: totalMeasures,
      cubes_count: cubes.length,
      map_keys_discovered: mapKeysDiscovered,
      columns_profiled: columnsProfiled,
      columns_skipped: columnsSkipped,
    },
  };
}

// -- Template mode (013 default models) -------------------------------------

/**
 * Probe fields safe for derived default models (013): FILTER_PARAMS lookup
 * dimensions and jinja-templated SQL require runtime features the per-team
 * validation gate (standalone prepareCompiler) cannot compile — and default
 * models must stay plainly queryable for every team. Such fields are simply
 * not carried into derived models.
 */
export const isTemplateSafeProbeField = (field) => {
  const sql = String(field?.sql || '');
  return !sql.includes('FILTER_PARAMS') && !sql.includes('{%');
};

/**
 * Cube's YAML compiler expression-evaluates `{...}` in EVERY string scalar of
 * the document — descriptions, meta values, even sampled data values the
 * profiler embeds (lc_values, unique_keys). Those strings are prose/data, not
 * expressions, and in the wild they contain literal braces (column comments
 * documenting `{FILTER_PARAMS...}`, stored LLM chat text, ...). Deep-walk the
 * assembled cube and replace braces with parentheses in every string EXCEPT
 * `sql` values, which legitimately use `{CUBE}` references — so derived
 * models always compile.
 */
export const sanitizeCubeProse = (node, key = null) => {
  if (typeof node === 'string') {
    if (key === 'sql' || !/[{}]/.test(node)) return node;
    return node.replace(/\{/g, '(').replace(/\}/g, ')');
  }
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeCubeProse(item, key));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = sanitizeCubeProse(v, k);
    }
    return out;
  }
  return node;
};

/**
 * Build one derived-model cube from a global template plus a team's profile.
 *
 * Template-owned fields are stamped `meta.from_template: true` (a provenance
 * class distinct from `auto_generated` — the template merger converges these
 * on every reconciliation). Probe-derived fields come from the ordinary
 * buildCubes() output and keep `meta.auto_generated`. Cube-level provenance
 * (`default_model`, `template`, `template_checksum`) drives reconciliation
 * matching, collision detection and the query pre-processor.
 *
 * Skeleton mode (empty/missing profile): template structure only — still
 * provenance-stamped and partition-scoped, so the model stays valid and
 * queryable for data-less teams (spec US1 #4).
 *
 * @param {object} templateCube - Parsed template cube definition
 * @param {object|null} profiledTable - profileTable() output for the team's
 *   partition slice, or null when probing was impossible
 * @param {object} options - { partition, internalTables, templateName,
 *   templateChecksum }
 * @returns {{ cube: object, skeleton: boolean }}
 */
export function buildCubesFromTemplate(templateCube, profiledTable, options = {}) {
  const {
    partition = null,
    internalTables = [],
    templateName,
    templateChecksum = null,
    // 080 (row-type pipeline, additive): scope the cube source to one row
    // type's slice, override the cube name (e.g. `rt_<slug>`), and stamp
    // caller-supplied provenance meta (marker family #2) INSTEAD of the 013
    // default-model trio. All default to the pre-080 behavior.
    filters = [],
    cubeName = null,
    cubeMeta = null,
  } = options;

  const finalCubeName = cubeName || templateCube.name;

  // Family #2 replaces `default_model`/`template_checksum`; the template's own
  // meta (field_policy, slots, …) still carries through underneath, and
  // `template` records the seed either way (080 FR-011).
  const stampCubeMeta = (templateMeta) => {
    if (!cubeMeta) {
      return {
        ...(templateMeta || {}),
        default_model: true,
        template: templateName,
        template_checksum: templateChecksum,
      };
    }
    const base = { ...(templateMeta || {}) };
    delete base.default_model;
    delete base.template_checksum;
    return { ...base, template: templateName, ...cubeMeta };
  };

  const stampTemplateField = (field) => {
    const meta = { ...(field.meta || {}) };
    // template-owned supersedes any stray generation marker
    delete meta.auto_generated;
    meta.from_template = true;
    return { ...field, meta };
  };

  const templateDims = (templateCube.dimensions || []).map(stampTemplateField);
  const templateMeasures = (templateCube.measures || []).map(stampTemplateField);
  const templateSegments = (templateCube.segments || []).map(stampTemplateField);

  const skeleton = !profiledTable || (profiledTable.row_count || 0) === 0;

  // Derive schema/table from the template's source for partition scoping
  const qualifiedTable = templateCube.sql_table || null;
  let schema = null;
  let table = null;
  if (qualifiedTable) {
    const parts = qualifiedTable.split('.');
    table = parts.pop();
    schema = parts.join('.') || null;
  }
  const isInternal = table ? internalTables.includes(table) : false;

  let source;
  if (qualifiedTable) {
    source = buildCubeSource(schema, table, partition, isInternal, filters, []);
  } else if (templateCube.sql) {
    // custom-SQL template: wrap so the scope literal (and any row-type
    // filters) still applies
    const wrapConditions = [];
    if (partition) wrapConditions.push(`partition = '${partition}'`);
    if (filters.length > 0) wrapConditions.push(filtersToSqlConditions(filters));
    source =
      wrapConditions.length > 0
        ? { sql: `SELECT * FROM (${templateCube.sql}) WHERE ${wrapConditions.join(' AND ')}` }
        : { sql: templateCube.sql };
  } else {
    source = {};
  }

  const templateFieldNames = new Set(
    [...templateDims, ...templateMeasures, ...templateSegments].map((f) => f.name)
  );

  let dimensions = [...templateDims];
  let measures = [...templateMeasures];

  // field_policy: explicit (014 FR-008/FR-010) — the template's declared
  // registry IS the member set: the probe only PRUNES registry members whose
  // key/path is absent from the team's data, and adds NOTHING. Skeletons keep
  // the full registry (013 skeleton semantics); unknown presence (column or
  // paths not probed) keeps the member — pruning requires positive evidence
  // of absence.
  if (templateCube.meta?.field_policy === 'explicit') {
    const presentMapKeys = new Map(); // column -> Set(observed keys)
    if (!skeleton && profiledTable?.columns) {
      for (const [columnName, details] of profiledTable.columns) {
        const keys = details?.profile?.uniqueKeys;
        if (Array.isArray(keys) && keys.length > 0) {
          presentMapKeys.set(columnName, new Set(keys));
        }
      }
    }
    const presentJsonPaths =
      !skeleton && profiledTable?.jsonPaths instanceof Set
        ? profiledTable.jsonPaths
        : null;

    const keepRegistryMember = (field) => {
      const registryKey = field?.meta?.registry_key;
      if (registryKey) {
        if (skeleton) return true;
        const dot = registryKey.indexOf('.');
        const column = registryKey.slice(0, dot);
        const key = registryKey.slice(dot + 1);
        const observed = presentMapKeys.get(column);
        return observed ? observed.has(key) : true;
      }
      const registryPath = field?.meta?.registry_path;
      if (registryPath) {
        if (skeleton || !presentJsonPaths) return true;
        const match = /^[A-Za-z_][A-Za-z0-9_]*\.(.+?)\s*(?:\(|$)/.exec(registryPath);
        const path = match ? match[1].trim() : registryPath;
        return presentJsonPaths.has(path);
      }
      return true; // non-registry template members (slots, partition, count…)
    };

    const cube = sanitizeCubeProse({
      name: finalCubeName,
      ...(templateCube.title ? { title: templateCube.title } : {}),
      ...(templateCube.description
        ? { description: templateCube.description }
        : {}),
      ...source,
      meta: stampCubeMeta(templateCube.meta),
      dimensions: templateDims.filter(keepRegistryMember),
      measures: templateMeasures.filter(keepRegistryMember),
      ...(templateSegments.length > 0
        ? { segments: templateSegments.filter(keepRegistryMember) }
        : {}),
    });

    return { cube, skeleton };
  }

  if (!skeleton) {
    const { cubes: probeCubes } = buildCubes(profiledTable, {
      partition,
      internalTables,
      cubeName: finalCubeName,
      filters,
    });
    const probeCube = probeCubes[0];
    if (probeCube) {
      // probe source already carries the baked partition scoping
      if (probeCube.sql || probeCube.sql_table) {
        source = probeCube.sql
          ? { sql: probeCube.sql }
          : { sql_table: probeCube.sql_table };
      }
      dimensions = dimensions.concat(
        (probeCube.dimensions || []).filter(
          (f) => !templateFieldNames.has(f.name) && isTemplateSafeProbeField(f)
        )
      );
      measures = measures.concat(
        (probeCube.measures || []).filter(
          (f) => !templateFieldNames.has(f.name) && isTemplateSafeProbeField(f)
        )
      );
    }
  }

  const cube = sanitizeCubeProse({
    name: finalCubeName,
    ...(templateCube.title ? { title: templateCube.title } : {}),
    ...(templateCube.description ? { description: templateCube.description } : {}),
    ...source,
    meta: stampCubeMeta(templateCube.meta),
    dimensions,
    measures,
    ...(templateSegments.length > 0 ? { segments: templateSegments } : {}),
  });

  return { cube, skeleton };
}

// -- AI metric merging ------------------------------------------------------

/** Default model identifier used for AI metric attribution. */
const AI_MODEL = 'gpt-5.4';

/**
 * Merge validated AI-generated metrics into the first cube's
 * dimensions / measures arrays.
 *
 * Each AI metric receives full provenance metadata so consumers
 * can distinguish AI-generated fields from profiler-generated ones.
 *
 * Metrics whose names already exist in the target cube (across both
 * dimensions and measures) are silently skipped to preserve uniqueness.
 *
 * @param {object[]} cubes - Cube definition array from buildCubes()
 * @param {object[]} aiMetrics - Validated AI metrics, each with:
 *   { name, sql, type, fieldType, description, ai_generation_context, source_columns }
 * @returns {object[]} The same cubes array (mutated in-place)
 */
function mergeAIMetrics(cubes, aiMetrics) {
  if (!cubes || cubes.length === 0 || !aiMetrics || aiMetrics.length === 0) {
    return cubes;
  }

  const targetCube = cubes[0];

  // Build a set of all existing field names in the target cube
  const existingNames = new Set();
  for (const dim of targetCube.dimensions || []) {
    existingNames.add(dim.name);
  }
  for (const measure of targetCube.measures || []) {
    existingNames.add(measure.name);
  }

  for (const metric of aiMetrics) {
    // Skip if name already exists (across both dimensions and measures)
    if (existingNames.has(metric.name)) {
      continue;
    }

    const field = {
      name: metric.name,
      sql: metric.sql,
      type: metric.type,
      description: metric.description,
      meta: {
        ai_generated: true,
        ai_model: AI_MODEL,
        ai_generation_context: metric.ai_generation_context,
        ai_generated_at: new Date().toISOString(),
        source_columns: metric.source_columns || [],
      },
    };

    // Pass through advanced Cube.js properties
    if (metric.rollingWindow) field.rollingWindow = metric.rollingWindow;
    if (metric.multiStage) field.multiStage = true;
    if (metric.timeShift) field.timeShift = metric.timeShift;

    if (metric.fieldType === 'dimension') {
      if (!targetCube.dimensions) targetCube.dimensions = [];
      targetCube.dimensions.push(field);
    } else {
      if (!targetCube.measures) targetCube.measures = [];
      targetCube.measures.push(field);
    }

    existingNames.add(metric.name);
  }

  return cubes;
}
