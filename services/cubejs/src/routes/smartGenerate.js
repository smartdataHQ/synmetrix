import {
  createDataSchema,
  findDataSchemas,
} from '../utils/dataSourceHelpers.js';
import createMd5Hex from '../utils/md5Hex.js';
import { profileTable } from '../utils/smart-generation/profiler.js';
import { detectPrimaryKeys } from '../utils/smart-generation/primaryKeyDetector.js';
import { buildCubes, mergeAIMetrics } from '../utils/smart-generation/cubeBuilder.js';
import { generateJs, generateFileName } from '../utils/smart-generation/yamlGenerator.js';
import { enrichWithAIMetrics } from '../utils/smart-generation/llmEnricher.js';
import { createProgressEmitter } from '../utils/smart-generation/progressEmitter.js';
import { mergeModels, extractAIMetrics } from '../utils/smart-generation/merger.js';
import { deserializeProfile } from '../utils/smart-generation/profileSerializer.js';
import { diffModels, parseCubesFromJs } from '../utils/smart-generation/diffModels.js';
import { validateModelSyntax, smokeTestQuery } from '../utils/smart-generation/modelValidator.js';

export default async (req, res, cubejs) => {
  const { securityContext } = req;
  const {
    table,
    schema,
    branchId,
    arrayJoinColumns: rawArrayJoinColumns,
    maxMapKeys: rawMaxMapKeys,
    mergeStrategy = 'auto',
    profileData: rawProfileData,
    dryRun: rawDryRun,
    filters: rawFilters,
    file_name: rawFileName,
    cube_name: rawCubeName,
    selected_ai_metrics: rawSelectedAIMetrics,
    selected_columns: rawSelectedColumns,
  } = req.body;

  // Hasura sends {} instead of null for optional fields — normalize
  const arrayJoinColumns = Array.isArray(rawArrayJoinColumns) ? rawArrayJoinColumns : [];
  const maxMapKeys = typeof rawMaxMapKeys === 'number' ? rawMaxMapKeys : 500;
  const profileData = (rawProfileData && typeof rawProfileData === 'object' && rawProfileData.profiledTable)
    ? rawProfileData
    : null;
  const dryRun = rawDryRun === true;
  const filters = Array.isArray(rawFilters) ? rawFilters : [];
  const fileNameOverride = typeof rawFileName === 'string' && rawFileName.trim() ? rawFileName.trim() : null;
  // Derive cube name from file name if not explicitly set (strip extension)
  const explicitCubeName = typeof rawCubeName === 'string' && rawCubeName.trim() ? rawCubeName.trim() : null;
  const cubeNameOverride = explicitCubeName
    || (fileNameOverride ? fileNameOverride.replace(/\.(js|yml|yaml)$/, '') : null);
  // When provided, only these AI metric names are merged into the model (user selection from preview)
  const selectedAIMetrics = Array.isArray(rawSelectedAIMetrics) ? new Set(rawSelectedAIMetrics) : null;
  // When provided, only these column names become dimensions/measures (user field selection)
  const selectedColumns = Array.isArray(rawSelectedColumns) ? new Set(rawSelectedColumns) : null;

  if (!table || !schema || !branchId) {
    return res.status(400).json({
      code: 'smart_generate_missing_params',
      message: 'The table, schema, and branchId parameters are required.',
    });
  }

  let driver;

  try {
    const { userId } = securityContext;
    const partition = securityContext.userScope?.dataSource?.partition || null;
    const internalTables = securityContext.userScope?.dataSource?.internalTables || [];

    const emitter = createProgressEmitter(res, req.headers.accept);

    let profiledTable;
    let primaryKeys;

    if (profileData) {
      // Use cached profile data from the profile_table step — no ClickHouse queries
      emitter.emit('building', 'Using cached profile...', 0.5);
      const deserialized = deserializeProfile(profileData);
      profiledTable = deserialized.profiledTable;
      primaryKeys = deserialized.primaryKeys;
    } else {
      // Legacy path: profile from scratch (two ClickHouse round-trips)
      driver = await cubejs.options.driverFactory({ securityContext });

      emitter.emit('profile', 'Profiling table...', 0.05);
      profiledTable = await profileTable(driver, schema, table, {
        partition,
        internalTables,
        filters,
        emitter,
      });

      emitter.emit('primary_keys', 'Detecting primary keys...', 0.5);
      primaryKeys = await detectPrimaryKeys(driver, schema, table);
    }

    // Filter columns if user selected a subset
    if (selectedColumns) {
      const fullColumns = profiledTable.columns;
      const filtered = new Map();
      for (const [name, data] of fullColumns) {
        if (selectedColumns.has(name)) {
          filtered.set(name, data);
        }
      }
      profiledTable = { ...profiledTable, columns: filtered };
    }

    // Build cubes
    emitter.emit('building', 'Building cube definitions...', 0.6);
    const cubeResult = buildCubes(profiledTable, {
      partition,
      internalTables,
      arrayJoinColumns,
      maxMapKeys,
      primaryKeys,
      cubeName: cubeNameOverride,
      filters,
    });

    // Store filters in cube-level meta for provenance tracking
    if (filters.length > 0) {
      for (const cube of cubeResult.cubes) {
        if (!cube.meta) cube.meta = {};
        cube.meta.generation_filters = filters;
      }
    }

    // Fetch existing schemas early (needed for AI superset regeneration and merge)
    const fileName = fileNameOverride
      ? (fileNameOverride.endsWith('.js') || fileNameOverride.endsWith('.yml') ? fileNameOverride : `${fileNameOverride}.js`)
      : generateFileName(table, true);
    emitter.emit('versioning', 'Checking existing schemas...', 0.62);
    // Use admin secret (no authToken) for internal Hasura calls — the user's
    // JWT may expire during the long-running profiling + LLM enrichment flow.
    const existingSchemas = await findDataSchemas({ branchId });
    const existingFileIndex = existingSchemas.findIndex((f) => f.name === fileName);
    const existingCode = existingFileIndex >= 0
      ? existingSchemas[existingFileIndex].code
      : null;

    // Collect profiler field names and measure names for validation
    const profilerFieldNames = [];
    const existingMeasureNames = [];
    for (const cube of cubeResult.cubes) {
      for (const dim of cube.dimensions || []) profilerFieldNames.push(dim.name);
      for (const m of cube.measures || []) {
        profilerFieldNames.push(m.name);
        existingMeasureNames.push(m.name);
      }
    }
    const tableColumnNames = Array.from(profiledTable.columns.keys());

    // AI metric enrichment — runs on BOTH dry-run and apply so the preview
    // shows the full picture including AI suggestions before the user commits.
    let aiEnrichment = { status: 'skipped', model: null, metrics_count: 0, error: null };

    {
      emitter.emit('ai_enrich', 'Generating AI metrics...', 0.63);

      // Extract existing AI metrics from the previous model for superset regeneration
      const existingAIMetrics = existingCode
        ? extractAIMetrics(existingCode)
        : [];

      const enrichResult = await enrichWithAIMetrics(
        profiledTable,
        cubeResult.cubes,
        existingAIMetrics,
        {
          timeout: 30000,
          existingMeasureNames,
          profilerFields: profilerFieldNames,
          profiledTableColumns: tableColumnNames,
        },
      );

      if ((enrichResult.status === 'success' || enrichResult.status === 'partial') && enrichResult.metrics.length > 0) {
        const validMetrics = enrichResult.metrics;

        // Filter by user selection if provided (apply step with selected metrics)
        const metricsToMerge = selectedAIMetrics
          ? validMetrics.filter((m) => selectedAIMetrics.has(m.name))
          : validMetrics;

        if (metricsToMerge.length > 0) {
          mergeAIMetrics(cubeResult.cubes, metricsToMerge);
        }

        // Superset check: force-retain prior AI metrics dropped by the LLM
        // if their source_columns all still exist in the table
        if (existingAIMetrics.length > 0) {
          const columnSet = new Set(tableColumnNames);
          const mergedNames = new Set();
          for (const cube of cubeResult.cubes) {
            for (const f of [...(cube.dimensions || []), ...(cube.measures || [])]) {
              mergedNames.add(f.name);
            }
          }

          const retainedMetrics = [];
          for (const prior of existingAIMetrics) {
            if (mergedNames.has(prior.name)) continue; // already present
            const srcCols = prior.source_columns || [];
            const allExist = srcCols.length > 0 && srcCols.every((c) => columnSet.has(c));
            if (allExist) {
              retainedMetrics.push({
                name: prior.name,
                sql: prior.sql,
                type: prior.type,
                fieldType: prior.fieldType || 'measure',
                description: prior.description,
                ai_generation_context: prior.ai_generation_context,
                source_columns: prior.source_columns,
              });
            }
          }

          if (retainedMetrics.length > 0) {
            mergeAIMetrics(cubeResult.cubes, retainedMetrics);
          }
        }

        aiEnrichment = {
          status: enrichResult.status,
          model: enrichResult.model,
          metrics_count: validMetrics.length,
          rejected_count: enrichResult.rejected ? enrichResult.rejected.length : 0,
          error: null,
          // Full metric objects for the frontend to render as selectable items
          suggested_metrics: validMetrics.map((m) => ({
            name: m.name,
            sql: m.sql,
            type: m.type,
            fieldType: m.fieldType,
            description: m.description,
            ai_generation_context: m.ai_generation_context,
            source_columns: m.source_columns,
            rollingWindow: m.rollingWindow,
            multiStage: m.multiStage,
            timeShift: m.timeShift,
          })),
        };
      } else {
        // Even if LLM failed/returned nothing, superset-retain prior AI metrics
        if (existingAIMetrics.length > 0) {
          const columnSet = new Set(tableColumnNames);
          const mergedNames = new Set();
          for (const cube of cubeResult.cubes) {
            for (const f of [...(cube.dimensions || []), ...(cube.measures || [])]) {
              mergedNames.add(f.name);
            }
          }

          const retainedMetrics = [];
          for (const prior of existingAIMetrics) {
            if (mergedNames.has(prior.name)) continue;
            const srcCols = prior.source_columns || [];
            const allExist = srcCols.length > 0 && srcCols.every((c) => columnSet.has(c));
            if (allExist) {
              retainedMetrics.push({
                name: prior.name,
                sql: prior.sql,
                type: prior.type,
                fieldType: prior.fieldType || 'measure',
                description: prior.description,
                ai_generation_context: prior.ai_generation_context,
                source_columns: prior.source_columns,
              });
            }
          }

          if (retainedMetrics.length > 0) {
            mergeAIMetrics(cubeResult.cubes, retainedMetrics);
          }
        }

        aiEnrichment = {
          status: enrichResult.status === 'success' ? 'success' : 'failed',
          model: enrichResult.model,
          metrics_count: 0,
          error: enrichResult.error,
        };
      }
    }

    // Generate JS model
    emitter.emit('generating', 'Generating JS model...', 0.7);
    const yamlContent = generateJs(cubeResult.cubes);

    // Apply merge strategy
    emitter.emit('merging', 'Applying merge strategy...', 0.78);

    // Extract previous generation filters from existing model (if any)
    let previousFilters = null;
    if (existingCode) {
      try {
        const existingCubes = parseCubesFromJs(existingCode);
        if (existingCubes) {
          for (const cube of existingCubes) {
            if (cube.meta?.generation_filters) {
              previousFilters = cube.meta.generation_filters;
              break;
            }
          }
        }
      } catch {
        // Non-fatal — leave previousFilters as null
      }
    }

    let finalYaml = yamlContent;
    if (existingCode) {
      finalYaml = mergeModels(existingCode, yamlContent, mergeStrategy);
    }

    // Validate generated model — syntax check + smoke-test query
    emitter.emit('validating', 'Validating model...', 0.79);
    const syntaxResult = await validateModelSyntax(finalYaml, fileName);
    if (!syntaxResult.valid) {
      return res.status(400).json({
        code: 'smart_generate_validation_error',
        message: `Generated model has compile errors: ${syntaxResult.errors.join('; ')}`,
        errors: syntaxResult.errors,
      });
    }

    const smokeResult = await smokeTestQuery(cubejs, securityContext, cubeResult.cubes);
    const modelValidation = {
      syntax_valid: syntaxResult.valid,
      query_test: smokeResult.success ? 'passed' : 'failed',
      query_error: smokeResult.error,
    };

    // Compute change preview (pass structured cubes for new model — JS strings can't be YAML-parsed)
    const changePreview = diffModels(existingCode, cubeResult.cubes, mergeStrategy);

    // Dry-run: return preview without saving
    if (dryRun) {
      const { summary } = cubeResult;
      const payload = {
        code: 'ok',
        message: changePreview.summary,
        version_id: null,
        file_name: fileName,
        changed: existingCode !== finalYaml,
        change_preview: changePreview,
        model_summary: {
          dimensions_count: summary.dimensions_count,
          measures_count: summary.measures_count,
          cubes_count: summary.cubes_count,
        },
        ai_enrichment: aiEnrichment,
        model_validation: modelValidation,
        previous_filters: previousFilters,
      };
      emitter.complete(payload);
      return;
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

    // Compute checksum of ALL files
    emitter.emit('versioning', 'Computing checksum...', 0.8);
    const commitChecksum = createMd5Hex(
      files.reduce((acc, f) => acc + f.code, '')
    );

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
        change_preview: changePreview,
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
        ai_enrichment: aiEnrichment,
        model_validation: modelValidation,
        previous_filters: previousFilters,
      };

      emitter.complete(payload);
      return;
    }

    // Create new version
    emitter.emit('versioning', 'Creating new version...', 0.85);

    const dataSourceId = securityContext.userScope?.dataSource?.dataSourceId;
    const preparedSchemas = files.map((file) => ({
      name: file.name,
      code: file.code,
      user_id: userId,
      datasource_id: dataSourceId,
    }));

    const result = await createDataSchema({
      user_id: userId,
      branch_id: branchId,
      checksum: commitChecksum,
      dataschemas: {
        data: [...preparedSchemas],
      },
    });

    // Purge compiler cache
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
      change_preview: changePreview,
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
      ai_enrichment: aiEnrichment,
      previous_filters: previousFilters,
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
