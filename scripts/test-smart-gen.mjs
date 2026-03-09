#!/usr/bin/env node
/**
 * Integration test for Smart Generation pipeline.
 *
 * Connects directly to ClickHouse, profiles a table, builds cubes,
 * generates YAML, and validates the output — all against real data.
 *
 * Usage:
 *   node scripts/test-smart-gen.mjs [--table TABLE] [--schema SCHEMA] [--host HOST] [--port PORT]
 *
 * Defaults: cst.semantic_events on localhost:18123
 */

import { createClient } from '@clickhouse/client';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

// Resolve paths relative to the cubejs service
const __dirname = dirname(fileURLToPath(import.meta.url));
const smartGenDir = join(__dirname, '../services/cubejs/src/utils/smart-generation');

// Import smart generation modules
const { profileTable } = await import(join(smartGenDir, 'profiler.js'));
const { ColumnType, ValueType, parseType } = await import(join(smartGenDir, 'typeParser.js'));
const { detectPrimaryKeys } = await import(join(smartGenDir, 'primaryKeyDetector.js'));
const { buildCubes } = await import(join(smartGenDir, 'cubeBuilder.js'));
const { generateYaml, generateFileName } = await import(join(smartGenDir, 'yamlGenerator.js'));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const TABLE = getArg('table', 'semantic_events');
const SCHEMA = getArg('schema', 'cst');
const HOST = getArg('host', 'localhost');
const PORT = getArg('port', '18123');
const OUTPUT_DIR = getArg('output', join(__dirname, '../test-output'));

// ---------------------------------------------------------------------------
// ClickHouse driver adapter (matches the interface profileTable expects)
// ---------------------------------------------------------------------------
function createDriver(host, port) {
  const client = createClient({
    url: `http://${host}:${port}`,
    request_timeout: 120_000,
    clickhouse_settings: {
      max_execution_time: 120,
    },
  });

  let queryCount = 0;

  return {
    queryCount: () => queryCount,
    async query(sql) {
      queryCount++;
      const result = await client.query({ query: sql, format: 'JSONEachRow' });
      return result.json();
    },
    async release() {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Progress emitter that also captures events for analysis
// ---------------------------------------------------------------------------
function createEmitter() {
  const events = [];
  return {
    events,
    emit(step, msg, progress, detail) {
      events.push({ step, msg, progress, detail, ts: Date.now() });
      const pct = progress ? `${(progress * 100).toFixed(0)}%` : '';
      console.log(`  [${step}] ${pct} ${msg}`, detail ? JSON.stringify(detail) : '');
    },
  };
}

// ---------------------------------------------------------------------------
// Test assertions
// ---------------------------------------------------------------------------
const failures = [];
const passes = [];

function assert(condition, description) {
  if (condition) {
    passes.push(description);
  } else {
    failures.push(description);
    console.log(`  ✗ FAIL: ${description}`);
  }
}

// ---------------------------------------------------------------------------
// Model validation
// ---------------------------------------------------------------------------
function validateModel(yamlContent) {
  const errors = [];
  const warnings = [];

  let parsed;
  try {
    parsed = YAML.parse(yamlContent);
  } catch (e) {
    errors.push(`YAML parse error: ${e.message}`);
    return { valid: false, errors, warnings };
  }

  if (!parsed.cubes || !Array.isArray(parsed.cubes)) {
    errors.push('Missing or invalid "cubes" array at top level');
    return { valid: false, errors, warnings };
  }

  const validDimTypes = ['string', 'number', 'time', 'boolean', 'geo'];
  const validMeasureTypes = [
    'count', 'count_distinct', 'count_distinct_approx',
    'sum', 'avg', 'min', 'max', 'number',
    'running_total', 'boolean', 'string',
  ];

  for (const cube of parsed.cubes) {
    const cubeName = cube.name || '(unnamed)';

    if (!cube.name) errors.push(`Cube missing "name" field`);
    if (!cube.sql_table && !cube.sql) errors.push(`Cube "${cubeName}": missing both "sql_table" and "sql"`);

    const dims = cube.dimensions || [];
    const measures = cube.measures || [];

    if (dims.length === 0 && measures.length === 0) {
      warnings.push(`Cube "${cubeName}": no dimensions or measures`);
    }

    for (const dim of dims) {
      if (!dim.name) errors.push(`Cube "${cubeName}": dimension missing "name"`);
      if (!dim.sql) errors.push(`Cube "${cubeName}": dimension "${dim.name}" missing "sql"`);
      if (!dim.type) errors.push(`Cube "${cubeName}": dimension "${dim.name}" missing "type"`);
      if (dim.type && !validDimTypes.includes(dim.type)) {
        errors.push(`Cube "${cubeName}": dimension "${dim.name}" has invalid type "${dim.type}"`);
      }
    }

    // Check for duplicate dimension names
    const dimNames = dims.map(d => d.name).filter(Boolean);
    const dimDupes = dimNames.filter((n, i) => dimNames.indexOf(n) !== i);
    if (dimDupes.length > 0) {
      errors.push(`Cube "${cubeName}": duplicate dimension names: ${[...new Set(dimDupes)].join(', ')}`);
    }

    for (const m of measures) {
      if (!m.name) errors.push(`Cube "${cubeName}": measure missing "name"`);
      if (!m.sql) errors.push(`Cube "${cubeName}": measure "${m.name}" missing "sql"`);
      if (!m.type) errors.push(`Cube "${cubeName}": measure "${m.name}" missing "type"`);
      if (m.type && !validMeasureTypes.includes(m.type)) {
        errors.push(`Cube "${cubeName}": measure "${m.name}" has invalid type "${m.type}"`);
      }
    }

    // Check for duplicate measure names
    const measureNames = measures.map(m => m.name).filter(Boolean);
    const mDupes = measureNames.filter((n, i) => measureNames.indexOf(n) !== i);
    if (mDupes.length > 0) {
      errors.push(`Cube "${cubeName}": duplicate measure names: ${[...new Set(mDupes)].join(', ')}`);
    }

    // Cross-collision
    const allNames = [...dimNames, ...measureNames];
    const crossDupes = allNames.filter((n, i) => allNames.indexOf(n) !== i);
    if (crossDupes.length > 0) {
      errors.push(`Cube "${cubeName}": name collision between dimensions and measures: ${[...new Set(crossDupes)].join(', ')}`);
    }

    if (!cube.meta?.auto_generated) {
      warnings.push(`Cube "${cubeName}": missing auto_generated meta`);
    }

    const hasPK = dims.some(d => d.primary_key === true);
    if (!hasPK) {
      warnings.push(`Cube "${cubeName}": no primary key dimension defined`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    parsed,
    cubeCount: parsed.cubes.length,
    stats: parsed.cubes.map(c => ({
      name: c.name,
      dimensions: (c.dimensions || []).length,
      measures: (c.measures || []).length,
      hasPrimaryKey: (c.dimensions || []).some(d => d.primary_key),
    })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== Smart Generation Integration Test ===`);
  console.log(`Table: ${SCHEMA}.${TABLE}`);
  console.log(`ClickHouse: ${HOST}:${PORT}`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const driver = createDriver(HOST, PORT);
  const emitter = createEmitter();

  try {
    // ==== Test 1: Schema Discovery ====
    console.log('\n--- Test 1: Schema Discovery ---');
    const describeRows = await driver.query(`DESCRIBE TABLE ${SCHEMA}.\`${TABLE}\``);

    assert(describeRows.length > 0, 'DESCRIBE TABLE returns columns');
    console.log(`  Total columns from DESCRIBE: ${describeRows.length}`);

    // Dynamically categorize columns
    const columnsByType = { basic: [], grouped: [], array: [], map: [], nested: [] };
    const parentGroups = new Map();

    for (const row of describeRows) {
      const hasParent = row.name.includes('.');
      const isArray = row.type.startsWith('Array(');
      const isMap = row.type.startsWith('Map(');
      const isNested = row.type.startsWith('Nested(');

      if (isNested) columnsByType.nested.push(row);
      else if (hasParent) {
        columnsByType.grouped.push(row);
        const parent = row.name.slice(0, row.name.indexOf('.'));
        if (!parentGroups.has(parent)) parentGroups.set(parent, []);
        parentGroups.get(parent).push(row);
      }
      else if (isArray) columnsByType.array.push(row);
      else if (isMap) columnsByType.map.push(row);
      else columnsByType.basic.push(row);
    }

    console.log(`  Basic: ${columnsByType.basic.length}, Grouped: ${columnsByType.grouped.length}, Array: ${columnsByType.array.length}, Map: ${columnsByType.map.length}, Nested: ${columnsByType.nested.length}`);
    console.log(`  Nested parent groups: ${parentGroups.size} (${[...parentGroups.keys()].join(', ')})`);

    for (const [parent, cols] of parentGroups) {
      console.log(`    ${parent}: ${cols.length} sub-columns`);
    }

    // ==== Test 2: Standalone Sentinel Probe (fail fast) ====
    console.log('\n--- Test 2: Sentinel Probe (standalone, fail fast) ---');

    // Build sentinel expressions the same way the profiler does — type-safe
    const sentinelParts = [];
    const sentinelParentInfo = [];
    for (const [parent, cols] of parentGroups) {
      // Pick a sentinel column: prefer String/Array, fall back to IS NOT NULL
      let sentinel = cols[0];
      let usesLength = false;
      for (const col of cols) {
        const parsed = parseType(col.type, col.name);
        if (parsed.valueType === ValueType.STRING || col.type.startsWith('Array(')) {
          sentinel = col;
          usesLength = true;
          break;
        }
      }
      const alias = parent.replace(/\./g, '_');
      const expr = usesLength
        ? `countIf(length(\`${sentinel.name}\`) > 0) as ${alias}__sentinel`
        : `countIf(\`${sentinel.name}\` IS NOT NULL) as ${alias}__sentinel`;
      sentinelParts.push(expr);
      sentinelParentInfo.push({ parent, alias, sentinel: sentinel.name, colCount: cols.length });
    }

    if (sentinelParts.length > 0) {
      const sentinelSql = `SELECT ${sentinelParts.join(', ')} FROM ${SCHEMA}.\`${TABLE}\``;
      console.log(`  Sentinel query covers ${sentinelParts.length} parent groups`);

      let sentinelRow;
      try {
        const rows = await driver.query(sentinelSql);
        sentinelRow = rows[0];
        assert(true, 'Sentinel query executed without error');
      } catch (sentinelErr) {
        assert(false, `Sentinel query must not error: ${sentinelErr.message}`);
        console.log(`\n  FATAL: Sentinel probe failed. Fix before proceeding.`);
        console.log(`  SQL: ${sentinelSql.slice(0, 500)}...`);
        process.exit(1);
      }

      // Report which groups have data vs empty
      let sentinelSkippable = 0;
      let sentinelSkippableCols = 0;
      for (const { parent, alias, sentinel, colCount } of sentinelParentInfo) {
        const count = Number(sentinelRow[`${alias}__sentinel`]) || 0;
        const status = count === 0 ? 'EMPTY (skippable)' : `HAS DATA (${count} rows)`;
        console.log(`    ${parent} (${colCount} cols, sentinel: ${sentinel}): ${status}`);
        if (count === 0) {
          sentinelSkippable++;
          sentinelSkippableCols += colCount;
        }
      }

      console.log(`\n  Skippable groups: ${sentinelSkippable}/${sentinelParentInfo.length}`);
      console.log(`  Skippable columns: ${sentinelSkippableCols}/${columnsByType.grouped.length}`);

      assert(sentinelSkippable >= 0, 'Sentinel reports skippable count (may be 0 if all groups have data)');

      // Spot-check: for groups marked empty, verify with a direct query
      const emptyGroups = sentinelParentInfo.filter(
        g => (Number(sentinelRow[`${g.alias}__sentinel`]) || 0) === 0
      );
      for (const group of emptyGroups.slice(0, 3)) {
        const cols = parentGroups.get(group.parent);
        // Pick a different column than the sentinel for verification
        const verifyCol = cols[Math.min(1, cols.length - 1)];
        const parsed = parseType(verifyCol.type, verifyCol.name);
        const verifyExpr = (parsed.valueType === ValueType.STRING || verifyCol.type.startsWith('Array('))
          ? `countIf(length(\`${verifyCol.name}\`) > 0)`
          : `countIf(\`${verifyCol.name}\` IS NOT NULL)`;
        try {
          const rows = await driver.query(`SELECT ${verifyExpr} as cnt FROM ${SCHEMA}.\`${TABLE}\``);
          const cnt = Number(rows[0]?.cnt) || 0;
          assert(cnt === 0, `Sentinel accuracy: ${group.parent}.* truly empty (verified ${verifyCol.name}: ${cnt} rows)`);
        } catch (e) {
          console.log(`    Could not verify ${group.parent}: ${e.message}`);
        }
      }
    } else {
      console.log('  No grouped columns — sentinel not applicable');
    }

    // ==== Test 3: Full Profile ====
    console.log('\n--- Test 3: Full Profile (with all optimizations) ---');
    const queriesBefore = driver.queryCount();
    const t0 = Date.now();
    const profiledTable = await profileTable(driver, SCHEMA, TABLE, { emitter });
    const profileMs = Date.now() - t0;
    const queriesUsed = driver.queryCount() - queriesBefore;

    console.log(`  Profiling time: ${(profileMs / 1000).toFixed(1)}s`);
    console.log(`  Queries executed: ${queriesUsed}`);
    console.log(`  Rows: ${profiledTable.row_count}, Sampled: ${profiledTable.sampled}, Method: ${profiledTable.sampling_method}`);
    console.log(`  Columns in result: ${profiledTable.columns.size}`);

    assert(profiledTable.row_count > 0, 'Table has rows');
    assert(profiledTable.columns.size > 0, 'Profile returned columns');

    // Analyze sentinel effectiveness from emitter events
    const sentinelEvents = emitter.events.filter(e => e.msg.includes('Skipping') || e.msg.includes('Skipped'));
    let skippedBysentinel = 0;
    for (const ev of sentinelEvents) {
      const match = ev.msg.match(/Skipped (\d+) columns/);
      if (match) skippedBysentinel = parseInt(match[1], 10);
    }
    for (const ev of sentinelEvents) {
      const match = ev.msg.match(/Skipping (\d+) empty/);
      if (match) skippedBysentinel += parseInt(match[1], 10);
    }

    console.log(`  Sentinel+metadata skipped: ${skippedBysentinel} columns`);

    // Compare queries used vs naive approach (no sentinel)
    const naiveBatches = Math.ceil(describeRows.length / 10);
    const naiveQueries = 1 + 1 + naiveBatches; // DESCRIBE + COUNT + batches
    console.log(`  Query comparison: ${queriesUsed} actual vs ~${naiveQueries} naive (no optimization)`);
    if (skippedBysentinel > 0) {
      const savedBatches = Math.ceil(skippedBysentinel / 10);
      console.log(`  Estimated batches saved: ${savedBatches}`);
    }

    // ==== Test 4: Column Type Handling ====
    console.log('\n--- Test 4: Column Type Handling ---');

    let errorsInProfile = 0;
    for (const [name, col] of profiledTable.columns) {
      // Every column should have a valid columnType
      const validTypes = Object.values(ColumnType);
      if (!validTypes.includes(col.columnType)) {
        console.log(`  ✗ ${name}: invalid columnType "${col.columnType}"`);
        errorsInProfile++;
      }

      // Grouped columns with Array rawType should have been profiled with array SQL
      // (no "!= ''" errors). Check that profile didn't silently fail.
      if (col.columnType === ColumnType.GROUPED && col.rawType?.startsWith('Array(')) {
        // If it has values, valueRows should be populated
        if (col.profile.hasValues && col.profile.valueRows === 0) {
          console.log(`  ✗ ${name}: Array-typed GROUPED column has hasValues=true but valueRows=0`);
          errorsInProfile++;
        }
      }
    }

    assert(errorsInProfile === 0, `All ${profiledTable.columns.size} columns have valid profile data`);

    // Count columns with actual data
    let columnsWithData = 0;
    let columnsEmpty = 0;
    for (const [, col] of profiledTable.columns) {
      if (col.profile.hasValues) columnsWithData++;
      else columnsEmpty++;
    }
    console.log(`  Columns with data: ${columnsWithData}, empty: ${columnsEmpty}`);

    // Save profile
    const profileData = {
      ...profiledTable,
      columns: Object.fromEntries(profiledTable.columns),
    };
    const profilePath = join(OUTPUT_DIR, `${TABLE}_profile.json`);
    writeFileSync(profilePath, JSON.stringify(profileData, null, 2));
    console.log(`  Saved profile → ${profilePath}`);

    // ==== Test 5: Primary Key Detection ====
    console.log('\n--- Test 5: Primary Key Detection ---');
    const primaryKeys = await detectPrimaryKeys(driver, SCHEMA, TABLE);
    console.log(`  Primary keys: ${primaryKeys.length > 0 ? primaryKeys.join(', ') : '(none detected)'}`);
    // Not asserting PK exists — some tables legitimately have none

    // ==== Test 6: Cube Building ====
    console.log('\n--- Test 6: Build Cubes ---');
    const cubeResult = buildCubes(profiledTable, { primaryKeys });

    assert(cubeResult.cubes.length > 0, 'At least one cube generated');
    assert(cubeResult.summary.dimensions_count > 0, 'Cubes have dimensions');

    console.log(`  Cubes: ${cubeResult.summary.cubes_count}`);
    console.log(`  Dimensions: ${cubeResult.summary.dimensions_count}`);
    console.log(`  Measures: ${cubeResult.summary.measures_count}`);
    console.log(`  Columns profiled: ${cubeResult.summary.columns_profiled}`);
    console.log(`  Columns skipped: ${cubeResult.summary.columns_skipped}`);
    console.log(`  Map keys discovered: ${cubeResult.summary.map_keys_discovered}`);

    const cubePath = join(OUTPUT_DIR, `${TABLE}_cubes.json`);
    writeFileSync(cubePath, JSON.stringify(cubeResult, null, 2));

    // ==== Test 7: YAML Generation ====
    console.log('\n--- Test 7: Generate YAML ---');
    const yamlContent = generateYaml(cubeResult.cubes);
    const fileName = generateFileName(TABLE);

    assert(yamlContent.length > 0, 'YAML content generated');
    assert(fileName.endsWith('.yml'), 'File name has .yml extension');

    const yamlPath = join(OUTPUT_DIR, fileName);
    writeFileSync(yamlPath, yamlContent);
    console.log(`  File: ${fileName} (${(yamlContent.length / 1024).toFixed(1)} KB)`);

    // ==== Test 8: Model Validation ====
    console.log('\n--- Test 8: Validate Model ---');
    const validation = validateModel(yamlContent);

    assert(validation.valid, 'Generated model passes validation');

    if (validation.errors.length > 0) {
      for (const err of validation.errors) console.log(`    ERROR: ${err}`);
    }
    if (validation.warnings.length > 0) {
      for (const warn of validation.warnings) console.log(`    WARN: ${warn}`);
    }

    console.log('\n  Cube stats:');
    for (const s of validation.stats) {
      console.log(`    ${s.name}: ${s.dimensions} dims, ${s.measures} measures, PK: ${s.hasPrimaryKey ? 'yes' : 'no'}`);
    }

    const validationPath = join(OUTPUT_DIR, `${TABLE}_validation.json`);
    writeFileSync(validationPath, JSON.stringify(validation, null, 2));

    // ==== Summary ====
    console.log(`\n=== Results ===`);
    console.log(`Profile time: ${(profileMs / 1000).toFixed(1)}s`);
    console.log(`Queries: ${driver.queryCount()}`);
    console.log(`Columns: ${describeRows.length} total, ${skippedBysentinel} skipped by sentinel, ${columnsWithData} with data`);
    console.log(`Passed: ${passes.length}, Failed: ${failures.length}`);

    if (failures.length > 0) {
      console.log('\nFailed assertions:');
      for (const f of failures) console.log(`  ✗ ${f}`);
    } else {
      console.log('\n✓ All assertions passed');
    }

    console.log(`\nOutput files in: ${OUTPUT_DIR}/`);

    process.exit(failures.length > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    console.error(err.stack);
    process.exit(2);
  } finally {
    await driver.release();
  }
}

main();
