import YAML from 'yaml';

import { findDataSchemas } from '../utils/dataSourceHelpers.js';
import { profileTable } from '../utils/smart-generation/profiler.js';
import { detectPrimaryKeys } from '../utils/smart-generation/primaryKeyDetector.js';
import { createProgressEmitter } from '../utils/smart-generation/progressEmitter.js';
import { serializeProfile } from '../utils/smart-generation/profileSerializer.js';
import { ColumnType } from '../utils/smart-generation/typeParser.js';

/**
 * Analyze an existing data schema file for user content and reprofile support.
 *
 * @param {string} code - The YAML/JS source code of the schema file
 * @param {string} fileName - The file name
 * @returns {object} Analysis result
 */
function analyzeExistingModel(code, fileName) {
  const fileFormat = fileName.endsWith('.yml') || fileName.endsWith('.yaml')
    ? 'yml'
    : 'js';

  let hasUserContent = false;
  let supportsReprofile = false;

  if (fileFormat === 'yml') {
    try {
      const parsed = YAML.parse(code);
      const cubes = parsed?.cubes || [];

      for (const cube of cubes) {
        // Check cube-level auto_generated meta
        if (cube?.meta?.auto_generated) {
          supportsReprofile = true;
        }

        // Check for joins, pre_aggregations, segments — these indicate user content
        if (cube.joins || cube.pre_aggregations || cube.segments) {
          hasUserContent = true;
        }

        // Check dimensions for fields without auto_generated meta
        for (const dim of cube.dimensions || []) {
          if (!dim?.meta?.auto_generated) {
            hasUserContent = true;
            break;
          }
        }

        // Check measures for fields without auto_generated meta
        for (const measure of cube.measures || []) {
          if (!measure?.meta?.auto_generated) {
            hasUserContent = true;
            break;
          }
        }
      }
    } catch {
      // If we can't parse the YAML, treat as user content
      hasUserContent = true;
    }
  } else {
    // JS files are assumed to have user content
    hasUserContent = true;
  }

  const suggestedMergeStrategy = hasUserContent ? 'merge' : 'replace';

  return {
    file_name: fileName,
    file_format: fileFormat,
    has_user_content: hasUserContent,
    supports_reprofile: supportsReprofile,
    suggested_merge_strategy: suggestedMergeStrategy,
  };
}

export default async (req, res, cubejs) => {
  const { securityContext } = req;
  const { table, schema, branchId } = req.body;

  if (!table || !schema) {
    return res.status(400).json({
      code: 'profile_table_missing_params',
      message: 'The table and schema parameters are required.',
    });
  }

  let driver;

  try {
    const { authToken } = securityContext;
    const partition = securityContext.userScope?.dataSource?.partition || null;
    const internalTables = securityContext.userScope?.dataSource?.internalTables || [];

    driver = await cubejs.options.driverFactory({ securityContext });

    const emitter = createProgressEmitter(res, req.headers.accept);

    // Profile the table
    const profiledTable = await profileTable(driver, schema, table, {
      partition,
      internalTables,
      emitter,
    });

    // Detect primary keys
    const primaryKeys = await detectPrimaryKeys(driver, schema, table);

    // Look up existing model (non-fatal — skip if JWT expired or other auth issue)
    let existingModel = null;
    if (branchId) {
      try {
        const dataSchemas = await findDataSchemas({ branchId, authToken });
        const matchingFile = dataSchemas.find(
          (f) => f.name === `${table}.yml` || f.name === `${table}.js`
        );

        if (matchingFile) {
          existingModel = analyzeExistingModel(matchingFile.code, matchingFile.name);
        }
      } catch (schemaErr) {
        console.warn('Could not look up existing model (non-fatal):', schemaErr.message || schemaErr);
      }
    }

    // Build array_candidates from profiled columns with columnType === ARRAY
    const arrayCandidates = [];
    for (const [colName, colData] of profiledTable.columns) {
      if (colData.columnType === ColumnType.ARRAY) {
        arrayCandidates.push({
          column: colName,
          element_type: colData.valueType || 'String',
          suggested_alias: `${colName}_item`,
        });
      }
    }

    // Build columns response from profiled data — include full stats
    const columnsOutput = [];
    for (const [colName, colData] of profiledTable.columns) {
      const p = colData.profile;
      const col = {
        name: colName,
        raw_type: colData.rawType,
        column_type: colData.columnType,
        value_type: colData.valueType,
        has_values: p.hasValues,
        value_rows: p.valueRows || null,
        unique_values: p.uniqueValues || null,
        min_value: p.minValue ?? null,
        max_value: p.maxValue ?? null,
        avg_value: p.avgValue ?? null,
        max_array_length: p.maxArrayLength || null,
        unique_keys: p.uniqueKeys?.length > 0 ? p.uniqueKeys : null,
        lc_values: p.lcValues || null,
        key_stats: p.keyStats && Object.keys(p.keyStats).length > 0 ? p.keyStats : null,
      };

      // Add column description from ClickHouse metadata if available
      const desc = profiledTable.columnDescriptions?.get?.(colName);
      if (desc) col.description = desc;

      columnsOutput.push(col);
    }

    // Serialize the full profile data so the frontend can pass it back to
    // smart_gen_dataschemas — avoids re-profiling ClickHouse a second time.
    const rawProfile = serializeProfile(profiledTable, primaryKeys);

    const payload = {
      code: 'ok',
      database: schema,
      table,
      partition: partition || null,
      row_count: profiledTable.row_count,
      sampled: profiledTable.sampled,
      sample_size: profiledTable.sample_size,
      columns: columnsOutput,
      primary_keys: primaryKeys,
      existing_model: existingModel,
      array_candidates: arrayCandidates,
      raw_profile: rawProfile,
    };

    emitter.complete(payload);
  } catch (err) {
    console.error(err);

    if (driver && driver.release) {
      await driver.release();
    }

    res.status(500).json({
      code: 'profile_table_error',
      message: err.message || err,
    });
  }
};
