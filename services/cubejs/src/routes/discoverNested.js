/** Naming patterns that indicate a lookup/discriminator column. */
const LOOKUP_KEY_PATTERN = /(_of|_type|_kind|_category)$/i;

/**
 * POST /api/v1/discover-nested
 *
 * Detects nested (GROUPED) column structures in a ClickHouse table and
 * returns discriminator columns with their distinct values.
 *
 * Request body: { table: string, schema: string }
 * Response: { groups: NestedGroup[] }
 */
/** Safe identifier pattern — only alphanumeric, underscore, dot allowed. */
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_.]+$/;

export default async function discoverNested(req, res, cubejs) {
  const { securityContext } = req;
  const { table, schema } = req.body;

  if (!table || !schema) {
    return res.status(400).json({
      code: 'discover_nested_missing_params',
      message: 'The table and schema parameters are required.',
    });
  }

  if (!SAFE_IDENTIFIER.test(schema) || !SAFE_IDENTIFIER.test(table)) {
    return res.status(400).json({
      code: 'discover_nested_invalid_identifier',
      message: 'The schema and table parameters must contain only alphanumeric characters, underscores, and dots.',
    });
  }

  let driver;
  try {
    driver = await cubejs.options.driverFactory({ securityContext });

    // 1. Fetch all columns for the table from system.columns
    const columnsRows = await driver.query(
      `SELECT name, type FROM system.columns WHERE database = '${schema}' AND table = '${table}' ORDER BY position`
    );

    // 2. Identify GROUPED columns (dotted names) and group by parent
    const groups = new Map(); // parent -> { columns: string[], discriminators: [] }
    for (const row of columnsRows) {
      const colName = row.name;
      if (!colName.includes('.')) continue;

      const dotIdx = colName.indexOf('.');
      const parent = colName.slice(0, dotIdx);
      const child = colName.slice(dotIdx + 1);

      if (!groups.has(parent)) {
        groups.set(parent, { columns: [], childTypes: new Map() });
      }
      const group = groups.get(parent);
      group.columns.push(colName);
      group.childTypes.set(child, row.type);
    }

    if (groups.size === 0) {
      return res.json({ groups: [] });
    }

    // 3. For each group, detect discriminator columns and fetch distinct values
    const result = [];
    for (const [parent, group] of groups) {
      // Find discriminator candidates: LowCardinality string sub-columns
      // matching the naming pattern, or fall back to first LC string
      const candidates = [];
      for (const [child, type] of group.childTypes) {
        const isLCString = /LowCardinality\(String\)/i.test(type)
          || /LowCardinality\(Nullable\(String\)\)/i.test(type);
        if (!isLCString) continue;
        candidates.push({ child, column: `${parent}.${child}`, isPattern: LOOKUP_KEY_PATTERN.test(child) });
      }

      // Prefer pattern matches, fall back to first LC string
      const patternMatches = candidates.filter((c) => c.isPattern);
      const selected = patternMatches.length > 0 ? patternMatches : candidates.slice(0, 1);

      const discriminators = [];
      for (const disc of selected) {
        try {
          const rows = await driver.query(
            `SELECT DISTINCT arrayJoin(${disc.column}) AS val FROM ${schema}.${table} WHERE notEmpty(${disc.column}) LIMIT 100`
          );
          const values = rows.map((r) => r.val).filter(Boolean).sort();
          if (values.length > 0) {
            const type = group.childTypes.get(disc.child);
            discriminators.push({
              column: disc.column,
              childName: disc.child,
              values,
              raw_type: type,
              value_type: /int|float|decimal|double/i.test(type) ? 'NUMBER'
                : /date|datetime/i.test(type) ? 'DATE'
                : /bool/i.test(type) ? 'BOOLEAN'
                : 'STRING',
            });
          }
        } catch (err) {
          // Non-fatal — skip this discriminator if the query fails
          console.warn(`[discoverNested] Failed to fetch values for ${disc.column}: ${err.message}`);
        }
      }

      result.push({
        name: parent,
        columnCount: group.columns.length,
        discriminators,
      });
    }

    res.json({ groups: result });
  } catch (err) {
    console.error('[discoverNested] Error:', err);

    if (driver?.release) {
      await driver.release();
    }

    res.status(500).json({
      code: 'discover_nested_error',
      message: err.message || 'Failed to discover nested structures',
    });
  }
}
