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
import { adviseModel, applyAdvisoryPasses } from '../utils/smart-generation/modelAdvisor.js';
import { mergeModels, extractAIMetrics } from '../utils/smart-generation/merger.js';
import { deserializeProfile } from '../utils/smart-generation/profileSerializer.js';
import { diffModels, parseCubesFromJs } from '../utils/smart-generation/diffModels.js';
import { loadRules } from '../utils/queryRewrite.js';
import { validateModelSyntax, smokeTestQuery } from '../utils/smart-generation/modelValidator.js';

function reorderProfileColumns(profiledTable) {
  if (!profiledTable?.columns || !(profiledTable.columns instanceof Map)) return profiledTable;
  const ordered = new Map();
  const seen = new Set();
  const preferred = Array.isArray(profiledTable.columnOrder) ? profiledTable.columnOrder : [];

  for (const colName of preferred) {
    if (profiledTable.columns.has(colName)) {
      ordered.set(colName, profiledTable.columns.get(colName));
      seen.add(colName);
    }
  }

  for (const [colName, colData] of profiledTable.columns) {
    if (seen.has(colName)) continue;
    ordered.set(colName, colData);
    preferred.push(colName);
  }

  return {
    ...profiledTable,
    columns: ordered,
    columnOrder: preferred,
  };
}

async function hydrateColumnOrderFromClickHouse(driver, profiledTable, schema, table) {
  if (!driver || !profiledTable?.columns || !(profiledTable.columns instanceof Map)) {
    return profiledTable;
  }
  const hasStableOrder =
    Array.isArray(profiledTable.columnOrder)
    && profiledTable.columnOrder.length > 0
    && profiledTable.columnOrder.length >= profiledTable.columns.size;
  if (hasStableOrder) {
    return reorderProfileColumns(profiledTable);
  }

  try {
    const rows = await driver.query(
      `SELECT name FROM system.columns WHERE database = '${schema}' AND table = '${table}' ORDER BY position`
    );
    const ddlOrder = rows.map((r) => r.name).filter((name) => profiledTable.columns.has(name));
    if (ddlOrder.length > 0) {
      return reorderProfileColumns({ ...profiledTable, columnOrder: ddlOrder });
    }
  } catch (err) {
    console.warn(`[smartGenerate] Column order hydration failed (non-fatal): ${err.message}`);
  }

  return reorderProfileColumns(profiledTable);
}

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
  const skipLlm = req.body.skip_llm === true;
  const filters = Array.isArray(rawFilters) ? rawFilters : [];
  const nestedFilters = Array.isArray(req.body.nestedFilters) ? req.body.nestedFilters : [];
  const fileNameOverride = typeof rawFileName === 'string' && rawFileName.trim() ? rawFileName.trim() : null;
  // Derive cube name from file name if not explicitly set (strip extension)
  const explicitCubeName = typeof rawCubeName === 'string' && rawCubeName.trim() ? rawCubeName.trim() : null;
  const cubeNameOverride = explicitCubeName
    || (fileNameOverride ? fileNameOverride.replace(/\.(js|yml|yaml)$/, '') : null);
  // When provided, only these AI metric names are merged into the model (user selection from preview)
  const selectedAIMetrics = Array.isArray(rawSelectedAIMetrics) ? new Set(rawSelectedAIMetrics) : null;
  // When provided, these fully-qualified field names (cube.field) are excluded from the final model
  const rawExcludedFields = req.body.excluded_fields;
  console.log('[smartGenerate] raw excluded_fields:', typeof rawExcludedFields, Array.isArray(rawExcludedFields) ? rawExcludedFields.length : rawExcludedFields);
  const excludedFields = Array.isArray(rawExcludedFields) ? new Set(rawExcludedFields) : null;
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
    const rewriteRuleDimensions = new Set(); // Track which dimensions are required by rewrite rules

    if (profileData) {
      // Use cached profile data from the profile_table step — no ClickHouse queries
      emitter.emit('building', 'Using cached profile...', 0.5);

      const deserialized = deserializeProfile(profileData);
      profiledTable = deserialized.profiledTable;
      primaryKeys = deserialized.primaryKeys;
      // Ensure column order is stable even when profile_data transport reorders object keys.

      driver = await cubejs.options.driverFactory({ securityContext });

      profiledTable = await hydrateColumnOrderFromClickHouse(driver, profiledTable, schema, table);


      // Load rewrite rules even on cached path — needed for required_fields
      try {
        const rules = await loadRules();
        for (const rule of rules) {
          if (rule.cube_name === table) rewriteRuleDimensions.add(rule.dimension);
        }
      } catch { /* non-fatal */ }
    } else {
      // Legacy path: profile from scratch (two ClickHouse round-trips)
      driver = await cubejs.options.driverFactory({ securityContext });

      // Apply query rewrite rules as mandatory filters
      const ruleFilters = [];
      try {
        const rules = await loadRules();
        const { teamProperties, memberProperties } = securityContext.userScope || {};
        for (const rule of rules) {
          if (rule.cube_name !== table) continue;
          rewriteRuleDimensions.add(rule.dimension);
          const source = rule.property_source === 'team' ? teamProperties : memberProperties;
          const value = source?.[rule.property_key];
          if (value === undefined || value === null) continue;
          const sqlOp = rule.operator === 'equals' ? '='
            : rule.operator === 'notEquals' ? '!='
            : rule.operator === 'contains' ? 'LIKE'
            : '=';
          const sqlVal = sqlOp === 'LIKE' ? `%${String(value)}%` : String(value);
          ruleFilters.push({ column: rule.dimension, operator: sqlOp, value: sqlVal });
        }
      } catch (err) {
        console.warn('[smartGenerate] Failed to load query rewrite rules (non-fatal):', err.message);
      }

      emitter.emit('profile', 'Profiling table...', 0.05);
      profiledTable = await profileTable(driver, schema, table, {
        partition,
        internalTables,
        filters: [...filters, ...ruleFilters],
        nestedFilters,
        emitter,
      });

      emitter.emit('primary_keys', 'Detecting primary keys...', 0.5);
      primaryKeys = await detectPrimaryKeys(driver, schema, table);
      profiledTable = reorderProfileColumns(profiledTable);
    }

    // Filter columns if user selected a subset.
    // Always preserve nested group children for active nested filters — they're
    // needed by buildArrayJoinCube even if the user didn't explicitly select them
    // (they appear inactive in the UI because the profiler can't profile Array
    // columns without ARRAY JOIN, so hasValues stays false).
    if (selectedColumns) {
      const nestedGroupNames = new Set(nestedFilters.map((nf) => nf.group));
      const fullColumns = profiledTable.columns;
      const filtered = new Map();
      for (const [name, data] of fullColumns) {
        const isNestedChild = data.columnType === 'GROUPED' && data.parentName
          && nestedGroupNames.has(data.parentName);
        const isNestedParent = data.columnType === 'NESTED';
        if (selectedColumns.has(name) || isNestedChild || isNestedParent) {
          filtered.set(name, data);
        }
      }
      const existingOrder = Array.isArray(profiledTable.columnOrder) ? profiledTable.columnOrder : [];
      const filteredOrder = existingOrder.length > 0
        ? existingOrder.filter((name) => filtered.has(name))
        : Array.from(filtered.keys());
      profiledTable = { ...profiledTable, columns: filtered, columnOrder: filteredOrder };
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
      nestedFilters,
    });

    // Store filters in cube-level meta for provenance tracking
    if (filters.length > 0) {
      for (const cube of cubeResult.cubes) {
        if (!cube.meta) cube.meta = {};
        cube.meta.generation_filters = filters;
      }
    }

    // Fetch existing schemas early (needed for AI superset regeneration and merge)
    // When nested filters produce a different cube name, use that for the file name
    // so file name matches cube name (required for Cube.js resolution).
    const cubeName = cubeResult.cubes[0]?.name;
    const effectiveFileNameOverride = (nestedFilters.length > 0 && cubeName)
      ? `${cubeName}.js`
      : fileNameOverride;
    const fileName = effectiveFileNameOverride
      ? (effectiveFileNameOverride.endsWith('.js') || effectiveFileNameOverride.endsWith('.yml') ? effectiveFileNameOverride : `${effectiveFileNameOverride}.js`)
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

    if (!skipLlm) {
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

    // ── Stage: LLM Model Advisory Passes (only on Apply, skip if LLM disabled) ──
    let advisorResult = null;
    if (!dryRun && !skipLlm) {
      emitter.emit('advising', 'Running LLM advisory passes...', 0.65);
      const generatedPreAdvise = generateJs(cubeResult.cubes);

      const profileSummaryForAdvisor = {
        table,
        schema,
        row_count: profiledTable.row_count,
        columns: profiledTable.columnOrder
          ? profiledTable.columnOrder.map((name) => {
              const col = profiledTable.columns.get(name);
              return { name, type: col?.rawType || col?.valueType || 'unknown', description: col?.description || '' };
            })
          : [],
      };

      try {
        advisorResult = await adviseModel(generatedPreAdvise, profileSummaryForAdvisor, cubeResult.cubes);

        if (advisorResult.status === 'success' && advisorResult.passes.length > 0) {
          applyAdvisoryPasses(cubeResult.cubes, advisorResult.passes);
        }
      } catch (err) {
        console.warn('[smartGenerate] Model advisory failed (non-fatal):', err.message);
        advisorResult = { passes: [], status: 'failed', error: err.message };
      }
    }

    // Strip excluded fields and clean up all cross-references
    if (excludedFields && excludedFields.size > 0) {
      console.log('[smartGenerate] Excluding fields:', [...excludedFields]);
      for (const cube of cubeResult.cubes) {
        cube.dimensions = cube.dimensions.filter(
          (d) => !excludedFields.has(`${cube.name}.${d.name}`)
        );
        cube.measures = cube.measures.filter(
          (m) => !excludedFields.has(`${cube.name}.${m.name}`)
        );
        if (cube.segments) {
          cube.segments = cube.segments.filter(
            (s) => !excludedFields.has(`${cube.name}.${s.name}`)
          );
        }

        // Clean up cross-references to surviving fields only
        const survivingDims = new Set(cube.dimensions.map((d) => d.name));
        const survivingMeasures = new Set(cube.measures.map((m) => m.name));
        const survivingAll = new Set([...survivingDims, ...survivingMeasures]);

        // Drill members: remove references to excluded dimensions
        for (const m of cube.measures) {
          if (m.drill_members) {
            m.drill_members = m.drill_members.filter((d) => survivingDims.has(d));
            if (m.drill_members.length === 0) delete m.drill_members;
          }
        }

        // Paired counts: remove if referenced dimension is gone
        cube.measures = cube.measures.filter((m) => {
          if (m.meta?.filtered_count_for && !survivingDims.has(m.meta.filtered_count_for)) return false;
          return true;
        });

        // Pre-aggregations: filter to surviving measures/dimensions only
        if (cube.pre_aggregations) {
          for (const pa of cube.pre_aggregations) {
            if (pa.measures) pa.measures = pa.measures.filter((m) => survivingMeasures.has(m));
            if (pa.dimensions) pa.dimensions = pa.dimensions.filter((d) => survivingDims.has(d));
            if (pa.time_dimension && !survivingDims.has(pa.time_dimension)) pa.time_dimension = null;
          }
          // Remove pre-aggs with no measures left
          cube.pre_aggregations = cube.pre_aggregations.filter(
            (pa) => !pa.measures || pa.measures.length > 0
          );
        }

        // Iteratively remove fields with broken references until stable.
        // Each pass may remove fields that other fields depend on.
        let changed = true;
        while (changed) {
          changed = false;
          const currentDims = new Set(cube.dimensions.map((d) => d.name));
          const currentMeasures = new Set(cube.measures.map((m) => m.name));
          const currentAll = new Set([...currentDims, ...currentMeasures]);

          // Helper: check if SQL references only surviving fields
          const sqlRefsValid = (sql) => {
            if (!sql) return true;
            // Check {measure_name} references
            const curlyRefs = sql.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g) || [];
            for (const ref of curlyRefs) {
              const name = ref.slice(1, -1);
              if (name === 'CUBE') continue;
              if (!currentAll.has(name)) return false;
            }
            // Check {CUBE}.field references
            const cubeRefs = sql.match(/\{CUBE\}\.([a-zA-Z_][a-zA-Z0-9_]*)/g) || [];
            for (const ref of cubeRefs) {
              const name = ref.replace('{CUBE}.', '');
              if (!currentAll.has(name)) return false;
            }
            return true;
          };

          const prevMeasureCount = cube.measures.length;
          cube.measures = cube.measures.filter((m) => {
            if (m.meta?.filtered_count_for && !currentDims.has(m.meta.filtered_count_for)) return false;
            return sqlRefsValid(m.sql);
          });
          if (cube.measures.length !== prevMeasureCount) changed = true;

          if (cube.segments) {
            const prevSegCount = cube.segments.length;
            cube.segments = cube.segments.filter((s) => sqlRefsValid(s.sql));
            if (cube.segments.length !== prevSegCount) changed = true;
          }

          // Clean drill_members
          for (const m of cube.measures) {
            if (m.drill_members) {
              const before = m.drill_members.length;
              m.drill_members = m.drill_members.filter((d) => currentDims.has(d));
              if (m.drill_members.length === 0) delete m.drill_members;
              if (m.drill_members?.length !== before) changed = true;
            }
          }
        }

        // Pre-aggregations: filter to surviving measures/dimensions only
        if (cube.pre_aggregations) {
          const finalMeasures = new Set(cube.measures.map((m) => m.name));
          const finalDims = new Set(cube.dimensions.map((d) => d.name));
          for (const pa of cube.pre_aggregations) {
            if (pa.measures) pa.measures = pa.measures.filter((m) => finalMeasures.has(m));
            if (pa.dimensions) pa.dimensions = pa.dimensions.filter((d) => finalDims.has(d));
            if (pa.time_dimension && !finalDims.has(pa.time_dimension)) pa.time_dimension = null;
          }
          cube.pre_aggregations = cube.pre_aggregations.filter(
            (pa) => !pa.measures || pa.measures.length > 0
          );
        }
      }

      // Rebuild ARRAY JOIN SQL to exclude columns that no longer have
      // surviving dimensions/measures. This avoids ClickHouse processing
      // unnecessary nested columns in the LEFT ARRAY JOIN.
      for (const cube of cubeResult.cubes) {
        if (!cube.sql || !cube.sql.includes('LEFT ARRAY JOIN')) continue;
        // Collect all source_column values from surviving fields
        const usedSourceColumns = new Set();
        for (const d of cube.dimensions || []) {
          if (d.meta?.source_column) usedSourceColumns.add(d.meta.source_column);
        }
        for (const m of cube.measures || []) {
          if (m.meta?.source_column) usedSourceColumns.add(m.meta.source_column);
        }
        // Also keep filter columns referenced in the WHERE clause
        const nestedFilterMeta = cube.meta?.nested_filters;
        if (Array.isArray(nestedFilterMeta)) {
          for (const nf of nestedFilterMeta) {
            for (const f of nf.filters || []) {
              usedSourceColumns.add(f.column);
            }
          }
        }

        // Parse and rebuild the ARRAY JOIN clause
        const ajMatch = cube.sql.match(/([\s\S]*?)LEFT ARRAY JOIN\n([\s\S]*?)(\nWHERE[\s\S]*)?$/);
        if (!ajMatch) continue;
        const [, selectPart, ajBody, wherePart = ''] = ajMatch;
        const ajLines = ajBody.split(',\n').map((l) => l.trim()).filter(Boolean);
        // Keep only lines whose source column is used
        const keptAjLines = ajLines.filter((line) => {
          // Extract dotted name from: `commerce.products.units` AS `commerce_products_units`
          const m = line.match(/`([^`]+)`\s+AS\s+`([^`]+)`/);
          if (!m) return true; // keep non-standard lines
          return usedSourceColumns.has(m[1]);
        });
        if (keptAjLines.length === 0) continue; // shouldn't happen but guard
        // Rebuild SELECT: keep all base columns, drop alias names for pruned AJ columns
        const selectMatch = selectPart.match(/SELECT\n([\s\S]*?)\nFROM/);
        if (!selectMatch) continue;
        const selectLines = selectMatch[1].split(',\n').map((l) => l.trim()).filter(Boolean);
        // Build the full set of alias names from the ORIGINAL ARRAY JOIN (before pruning)
        const allAliasNames = new Set(ajLines.map((line) => {
          const m = line.match(/AS\s+`([^`]+)`/);
          return m ? m[1] : null;
        }).filter(Boolean));
        // And the surviving subset
        const keptAliasNames = new Set(keptAjLines.map((line) => {
          const m = line.match(/AS\s+`([^`]+)`/);
          return m ? m[1] : null;
        }).filter(Boolean));
        const keptSelectLines = selectLines.filter((line) => {
          const clean = line.replace(/`/g, '').trim();
          // If it's a known alias name, only keep if it survived pruning
          if (allAliasNames.has(clean)) return keptAliasNames.has(clean);
          // Not an alias — it's a base column, always keep
          return true;
        });
        const fromMatch = selectPart.match(/\nFROM\s+(.+)/);
        const fromClause = fromMatch ? fromMatch[1].trim() : '';
        cube.sql = `SELECT\n${keptSelectLines.map((l) => `  ${l}`).join(',\n')}\nFROM ${fromClause}\nLEFT ARRAY JOIN\n${keptAjLines.map((l) => `  ${l}`).join(',\n')}${wherePart}`;
      }

      // Recompute summary after field exclusion
      let totalDimensions = 0;
      let totalMeasures = 0;
      for (const cube of cubeResult.cubes) {
        totalDimensions += cube.dimensions.length;
        totalMeasures += cube.measures.length;
      }
      cubeResult.summary.dimensions_count = totalDimensions;
      cubeResult.summary.measures_count = totalMeasures;
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
    // When nested filters are active, the cube structure is fundamentally
    // different (ARRAY JOIN flattens arrays into scalars). Merging with an
    // existing model that has FILTER_PARAMS on array columns will break.
    // Force replace to start clean.
    const effectiveMergeStrategy = nestedFilters.length > 0 ? 'replace' : mergeStrategy;
    if (existingCode && effectiveMergeStrategy !== 'replace') {
      finalYaml = mergeModels(existingCode, yamlContent, effectiveMergeStrategy);
    }

    // Fix FILTER_PARAMS references: after merge, old cube names may persist
    // in FILTER_PARAMS expressions from the previous model version.
    const actualCubeName = cubeResult.cubes[0]?.name;
    if (actualCubeName && finalYaml.includes('FILTER_PARAMS.')) {
      const fpPattern = /FILTER_PARAMS\.([a-zA-Z_][a-zA-Z0-9_]*)\./g;
      finalYaml = finalYaml.replace(fpPattern, (match, refCubeName) => {
        if (refCubeName !== actualCubeName) {
          return `FILTER_PARAMS.${actualCubeName}.`;
        }
        return match;
      });
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

    // Build required_fields: fields that must always be included (rewrite rules + nested filters).
    // These are fully-qualified "cube.field" names matching the change preview format.
    const requiredFields = [];
    for (const cube of cubeResult.cubes) {
      for (const dim of cube.dimensions || []) {
        if (rewriteRuleDimensions.has(dim.name)) {
          requiredFields.push(`${cube.name}.${dim.name}`);
        }
      }
    }
    // Nested filter columns are baked into the cube SQL WHERE — their dimensions must survive
    for (const nf of nestedFilters) {
      for (const f of nf.filters || []) {
        const childName = f.column.includes('.') ? f.column.split('.').pop() : f.column;
        for (const cube of cubeResult.cubes) {
          const dim = (cube.dimensions || []).find((d) =>
            d.name.includes(childName) && d.meta?.source_group
          );
          if (dim) requiredFields.push(`${cube.name}.${dim.name}`);
        }
      }
    }

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
        required_fields: requiredFields,
        model_summary: {
          dimensions_count: summary.dimensions_count,
          measures_count: summary.measures_count,
          cubes_count: summary.cubes_count,
        },
        ai_enrichment: aiEnrichment,
        advisor: advisorResult ? {
          status: advisorResult.status,
          passes: advisorResult.passes?.map((p) => ({ pass: p.pass, fields: Object.keys(p.result || {}) })) || [],
          error: advisorResult.error || null,
        } : null,
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
        advisor: advisorResult ? {
          status: advisorResult.status,
          passes: advisorResult.passes?.map((p) => ({ pass: p.pass, fields: Object.keys(p.result || {}) })) || [],
          error: advisorResult.error || null,
        } : null,
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
      advisor: advisorResult ? {
        status: advisorResult.status,
        passes: advisorResult.passes?.map((p) => ({ pass: p.pass, fields: Object.keys(p.result || {}) })) || [],
        error: advisorResult.error || null,
      } : null,
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
