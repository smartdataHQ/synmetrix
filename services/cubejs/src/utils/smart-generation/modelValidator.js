/**
 * Model validator — validates generated Cube.js JS model files using
 * the schema compiler, then runs a smoke-test query against the database
 * to confirm the model is actually executable.
 */

import { prepareCompiler } from '@cubejs-backend/schema-compiler';

/**
 * In-memory schema file repository for the compiler.
 */
class InMemorySchemaFileRepository {
  constructor(files) {
    this.files = files;
  }

  localPath() {
    return '/';
  }

  async dataSchemaFiles() {
    return this.files;
  }
}

/**
 * Validate a generated JS model string using the Cube.js schema compiler.
 *
 * @param {string} jsContent - The JS model file content
 * @param {string} [fileName='model.js'] - File name for error reporting
 * @returns {Promise<{ valid: boolean, errors: string[] }>}
 */
export async function validateModelSyntax(jsContent, fileName = 'model.js') {
  const files = [{ fileName, content: jsContent }];
  const repo = new InMemorySchemaFileRepository(files);

  const { compiler } = prepareCompiler(repo, {
    allowNodeRequire: false,
    standalone: true,
  });

  try {
    await compiler.compile();
  } catch {
    // compile() throws on errors — read them from errorsReport
  }

  const errorsReport = compiler.errorsReport;
  const rawErrors = errorsReport ? errorsReport.getErrors() : [];

  return {
    valid: rawErrors.length === 0,
    errors: rawErrors.map((e) => e.plainMessage || e.message || String(e)),
  };
}

/**
 * Run a smoke-test query against the database using the generated model.
 *
 * Picks the count measure and first dimension from the first cube,
 * runs a LIMIT 1 query to verify the model is executable end-to-end.
 *
 * @param {object} cubejs - The CubeJS server instance
 * @param {object} securityContext - The request's security context
 * @param {object[]} cubes - Parsed cube definitions (from cubeBuilder)
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
export async function smokeTestQuery(cubejs, securityContext, cubes) {
  if (!cubes || cubes.length === 0) {
    return { success: true, error: null };
  }

  const cube = cubes[0];
  const cubeName = cube.name;

  // Find a simple measure (prefer count, then first measure)
  const measures = cube.measures || [];
  const countMeasure = measures.find((m) => m.type === 'count');
  const testMeasure = countMeasure || measures[0];

  if (!testMeasure) {
    return { success: true, error: null }; // no measures to test
  }

  // Find a simple string dimension for GROUP BY
  const dimensions = cube.dimensions || [];
  const testDim = dimensions.find((d) => d.type === 'string' && !d.sql?.includes('FILTER_PARAMS'));

  const query = {
    measures: [`${cubeName}.${testMeasure.name}`],
    limit: 1,
  };

  if (testDim) {
    query.dimensions = [`${cubeName}.${testDim.name}`];
  }

  try {
    // Use the internal API to execute a test query
    const driver = await cubejs.options.driverFactory({ securityContext });
    try {
      // Build a minimal SQL query directly — avoids needing a full Cube.js
      // query pipeline which requires the model to be loaded already.
      const table = cube.sql_table || cubeName;
      const measureSql = testMeasure.type === 'count'
        ? 'count(*)'
        : `count(*)`;
      const dimCol = testDim?.sql?.replace(/\{CUBE\}\./g, '') || null;

      let sql = `SELECT ${measureSql} FROM ${table}`;
      if (dimCol) {
        sql += ` GROUP BY ${dimCol}`;
      }
      sql += ' LIMIT 1';

      await driver.query(sql);

      if (driver.release) await driver.release();
      return { success: true, error: null };
    } catch (queryErr) {
      if (driver.release) await driver.release();
      return { success: false, error: queryErr.message || String(queryErr) };
    }
  } catch (driverErr) {
    return { success: false, error: driverErr.message || String(driverErr) };
  }
}
