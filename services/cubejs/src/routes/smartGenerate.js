import {
  createDataSchema,
  findDataSchemas,
} from '../utils/dataSourceHelpers.js';
import createMd5Hex from '../utils/md5Hex.js';
import { profileTable } from '../utils/smart-generation/profiler.js';
import { detectPrimaryKeys } from '../utils/smart-generation/primaryKeyDetector.js';
import { buildCubes } from '../utils/smart-generation/cubeBuilder.js';
import { generateJs, generateFileName } from '../utils/smart-generation/yamlGenerator.js';
import { createProgressEmitter } from '../utils/smart-generation/progressEmitter.js';
import { mergeModels } from '../utils/smart-generation/merger.js';

export default async (req, res, cubejs) => {
  const { securityContext } = req;
  const {
    table,
    schema,
    branchId,
    arrayJoinColumns = [],
    maxMapKeys = 500,
    mergeStrategy = 'auto',
  } = req.body;

  if (!table || !schema || !branchId) {
    return res.status(400).json({
      code: 'smart_generate_missing_params',
      message: 'The table, schema, and branchId parameters are required.',
    });
  }

  let driver;

  try {
    const { authToken, userId } = securityContext;
    const partition = securityContext.userScope?.dataSource?.partition || null;
    const internalTables = securityContext.userScope?.dataSource?.internalTables || [];

    driver = await cubejs.options.driverFactory({ securityContext });

    const emitter = createProgressEmitter(res, req.headers.accept);

    // Step 1: Profile the table
    emitter.emit('profile', 'Profiling table...', 0.05);
    const profiledTable = await profileTable(driver, schema, table, {
      partition,
      internalTables,
      emitter,
    });

    // Step 2: Detect primary keys
    emitter.emit('primary_keys', 'Detecting primary keys...', 0.5);
    const primaryKeys = await detectPrimaryKeys(driver, schema, table);

    // Step 3: Build cubes
    emitter.emit('building', 'Building cube definitions...', 0.6);
    const cubeResult = buildCubes(profiledTable, {
      partition,
      internalTables,
      arrayJoinColumns,
      maxMapKeys,
      primaryKeys,
    });

    // Step 4: Generate JS model (JS is a superset of YAML — supports
    // FILTER_PARAMS callbacks, asyncModule, COMPILE_CONTEXT, extends)
    emitter.emit('generating', 'Generating JS model...', 0.7);
    const yamlContent = generateJs(cubeResult.cubes);
    const fileName = generateFileName(table, true);

    // Step 5: Fetch existing schemas
    emitter.emit('versioning', 'Checking existing schemas...', 0.75);
    const existingSchemas = await findDataSchemas({ branchId, authToken });

    // Step 6: Apply merge strategy
    emitter.emit('merging', 'Applying merge strategy...', 0.78);
    const existingFileIndex = existingSchemas.findIndex(
      (f) => f.name === fileName
    );

    let finalYaml = yamlContent;
    if (existingFileIndex >= 0) {
      const existingFile = existingSchemas[existingFileIndex];
      finalYaml = mergeModels(existingFile.code, yamlContent, mergeStrategy);
    }

    let files;
    if (existingFileIndex >= 0) {
      files = existingSchemas.map((f) =>
        f.name === fileName
          ? { name: fileName, code: finalYaml }
          : { name: f.name, code: f.code }
      );
    } else {
      files = [
        ...existingSchemas.map((f) => ({ name: f.name, code: f.code })),
        { name: fileName, code: finalYaml },
      ];
    }

    // Step 7: Compute checksum of ALL files
    emitter.emit('versioning', 'Computing checksum...', 0.8);
    const commitChecksum = createMd5Hex(
      files.reduce((acc, f) => acc + f.code, '')
    );

    // Step 8: Check if anything changed
    // Find the latest version checksum from existing schemas
    const existingChecksum = createMd5Hex(
      existingSchemas.reduce((acc, f) => acc + f.code, '')
    );

    if (commitChecksum === existingChecksum) {
      const payload = {
        code: 'ok',
        message: 'No changes detected',
        version_id: null,
        file_name: fileName,
        changed: false,
        profile_summary: {
          row_count: profiledTable.row_count,
          columns_profiled: cubeResult.summary.columns_profiled,
          columns_skipped: cubeResult.summary.columns_skipped,
          map_keys_discovered: cubeResult.summary.map_keys_discovered,
          array_candidates: [],
        },
        model_summary: {
          dimensions_count: cubeResult.summary.dimensions_count,
          measures_count: cubeResult.summary.measures_count,
          cubes_count: cubeResult.summary.cubes_count,
        },
      };

      emitter.complete(payload);
      return;
    }

    // Step 9: Create new version
    emitter.emit('versioning', 'Creating new version...', 0.85);

    const dataSourceId = securityContext.userScope?.dataSource?.dataSourceId;
    const preparedSchemas = files.map((file) => ({
      name: file.name,
      code: file.code,
      user_id: userId,
      datasource_id: dataSourceId,
    }));

    const result = await createDataSchema({
      authToken,
      user_id: userId,
      branch_id: branchId,
      checksum: commitChecksum,
      dataschemas: {
        data: [...preparedSchemas],
      },
    });

    // Step 10: Purge compiler cache
    if (cubejs.compilerCache) {
      cubejs.compilerCache.purgeStale();
    }

    const { summary } = cubeResult;
    const payload = {
      code: 'ok',
      message: `Smart generation complete: ${summary.dimensions_count} dimensions, ${summary.measures_count} measures, ${summary.cubes_count} cubes`,
      version_id: result?.id || null,
      file_name: fileName,
      changed: true,
      profile_summary: {
        row_count: profiledTable.row_count,
        columns_profiled: summary.columns_profiled,
        columns_skipped: summary.columns_skipped,
        map_keys_discovered: summary.map_keys_discovered,
        array_candidates: [],
      },
      model_summary: {
        dimensions_count: summary.dimensions_count,
        measures_count: summary.measures_count,
        cubes_count: summary.cubes_count,
      },
    };

    emitter.complete(payload);
  } catch (err) {
    console.error(err);

    if (driver && driver.release) {
      await driver.release();
    }

    res.status(500).json({
      code: 'smart_generate_error',
      message: err.message || err,
    });
  }
};
