# CubeBuilder Principles-Compliant Heuristics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the cubeBuilder to produce principle-compliant models deterministically — titles, descriptions, meta blocks, paired counts, format inference, partition ordering, drill members, pre-aggregations, and public: false on plumbing. The LLM polisher becomes a refinement step, not a builder.

**Architecture:** Add heuristic functions to `cubeBuilder.js` that run after the raw cube is built. Each heuristic transforms the cube definition in place: add titles from column names, detect grain from primary keys, order partition first, generate paired counts from profile data, infer currency/percent format, mark plumbing fields as public:false, add drill members to count, generate default pre-aggregations. Order matters: partition → titles → meta → counts → format → public → drill → pre-aggs.

**Tech Stack:** JavaScript (ES modules, Node.js 22)

**Principles:** `services/cubejs/principles/cube-principles.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `services/cubejs/src/utils/smart-generation/cubeBuilder.js` | Add heuristic functions after raw cube build |
| Modify | `services/cubejs/src/utils/smart-generation/yamlGenerator.js` | Serialize new properties (title, description, segments, pre_aggregations, drill_members, format, public) |

---

### Task 1: Add `titleFromName` helper and apply titles to all fields + cube

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/cubeBuilder.js`

- [ ] **Step 1: Add the titleFromName helper**

Add this function near the top of `cubeBuilder.js`, after the existing helpers:

```javascript
/**
 * Convert a snake_case or camelCase field name to a human-readable Title.
 * E.g. "commerce_products_entry_type" → "Commerce Products Entry Type"
 *       "unit_price" → "Unit Price"
 *       "gs1_brick_id" → "GS1 Brick ID"
 *
 * @param {string} name
 * @returns {string}
 */
function titleFromName(name) {
  // Common abbreviations that should stay uppercase
  const UPPER = new Set(['id', 'gid', 'sku', 'upc', 'ean', 'isbn', 'gtin', 'uom', 'gs1', 'ip', 'url', 'img', 'os', 'ms', 'mgr']);

  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((w) => UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
```

- [ ] **Step 2: Apply titles in `buildRawCube` after fields are built**

In `buildRawCube`, after the dimensions and measures arrays are populated (just before the `return` statement), add:

```javascript
  // --- Heuristic: Add titles to all public fields ---
  for (const dim of dimensions) {
    if (!dim.title) dim.title = titleFromName(dim.name);
  }
  for (const meas of measures) {
    if (!meas.title) meas.title = titleFromName(meas.name);
  }
```

- [ ] **Step 3: Add cube-level title and description**

In the cube object construction (where `name`, `sql`, `meta` are set), add:

```javascript
  const cubeTitle = titleFromName(sanitizeCubeName(profiledTable.table));
  const cubeDescription = profiledTable.tableDescription
    || `Analytical model for ${profiledTable.database}.${profiledTable.table}, auto-generated from table profiling.`;
```

Set `title` and `description` on the returned cube object:

```javascript
  return {
    name: cubeName || sanitizeCubeName(profiledTable.table),
    title: cubeTitle,
    description: cubeDescription,
    sql,
    meta,
    dimensions,
    measures,
  };
```

- [ ] **Step 4: Apply same titles in `buildArrayJoinCube`**

After the dimensions/measures loops in `buildArrayJoinCube`, add:

```javascript
  for (const dim of dimensions) {
    if (!dim.title) dim.title = titleFromName(dim.name);
  }
  for (const meas of measures) {
    if (!meas.title) meas.title = titleFromName(meas.name);
  }
```

And add `title` and `description` to the array join cube return object.

- [ ] **Step 5: Commit**

```bash
git add services/cubejs/src/utils/smart-generation/cubeBuilder.js
git commit -m "feat: add human-readable titles to all fields and cubes"
```

---

### Task 2: Partition-first ordering + meta block completeness

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/cubeBuilder.js`

- [ ] **Step 1: Ensure partition is the first dimension**

After all dimensions are collected in `buildRawCube` (before the title heuristic), add:

```javascript
  // --- Heuristic: Partition must be the first dimension ---
  const partitionIdx = dimensions.findIndex((d) => d.name === 'partition');
  if (partitionIdx > 0) {
    const [partitionDim] = dimensions.splice(partitionIdx, 1);
    dimensions.unshift(partitionDim);
  }
```

- [ ] **Step 2: Add complete meta block**

Enhance the meta object in `buildRawCube` to include principle-required fields:

```javascript
  // --- Heuristic: Detect time dimension and grain ---
  const timeDim = dimensions.find((d) => d.type === 'time' && d.primary_key !== true);
  const grainParts = (primaryKeys || []).length > 0
    ? primaryKeys.map(sanitizeFieldName).join(' + ')
    : 'one row per source record';

  const meta = {
    auto_generated: true,
    source_database: schema,
    source_table: table,
    grain: grainParts,
    grain_description: `Each row represents one ${table} record, keyed by ${grainParts}.`,
    time_dimension: timeDim ? timeDim.name : null,
    time_zone: 'UTC',
    refresh_cadence: '1 hour',
    generated_at: new Date().toISOString(),
  };
```

- [ ] **Step 3: Commit**

```bash
git add services/cubejs/src/utils/smart-generation/cubeBuilder.js
git commit -m "feat: partition-first ordering and complete meta block with grain/time_dimension"
```

---

### Task 3: Paired counts + drill members + format inference

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/cubeBuilder.js`

- [ ] **Step 1: Add paired counts for key categorical dimensions**

After the base `count` measure is added in `buildRawCube`, add filtered counts for low-cardinality dimensions that have LC values:

```javascript
  // --- Heuristic: Paired filtered counts for key categorical dimensions ---
  const countMeasure = measures.find((m) => m.type === 'count');
  if (countMeasure) {
    // Add drill_members to the primary count
    const drillCandidates = dimensions
      .filter((d) => d.type === 'string' && !d.name.includes('_id') && !d.name.includes('_gid') && d.public !== false)
      .slice(0, 5)
      .map((d) => d.name);
    if (drillCandidates.length > 0) {
      countMeasure.drill_members = drillCandidates;
    }

    // Generate filtered counts for dimensions with low-cardinality values
    for (const dim of dimensions) {
      const lcValues = dim.meta?.lc_values;
      if (!Array.isArray(lcValues) || lcValues.length === 0 || lcValues.length > 10) continue;
      if (dim.type !== 'string') continue;

      for (const val of lcValues) {
        const slug = sanitizeFieldName(val.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
        const measName = `count_${dim.name}_${slug}`;
        if (measures.some((m) => m.name === measName)) continue;

        measures.push({
          name: measName,
          title: titleFromName(measName),
          sql: `{CUBE}.${dim.name}`,
          type: 'count',
          filters: [{ sql: `{CUBE}.${dim.name} = '${val.replace(/'/g, "''")}'` }],
          meta: { auto_generated: true, filtered_count_for: dim.name, filter_value: val },
        });
      }
    }
  }
```

- [ ] **Step 2: Add format inference for currency and percent columns**

After measures are built, detect currency/percent by column name patterns:

```javascript
  // --- Heuristic: Format inference for currency/percent ---
  const CURRENCY_PATTERNS = /^(revenue|tax|discount|cogs|commission|price|cost|amount|fee|total|payment|balance)$/i;
  const PERCENT_PATTERNS = /_(percentage|pct|ratio|rate)$/i;

  for (const meas of measures) {
    if (meas.format) continue; // Already set
    if (CURRENCY_PATTERNS.test(meas.name) || meas.name.endsWith('_price') || meas.name.endsWith('_cost') || meas.name.endsWith('_revenue')) {
      meas.format = 'currency';
    } else if (PERCENT_PATTERNS.test(meas.name)) {
      meas.format = 'percent';
    }
  }
```

- [ ] **Step 3: Mark internal/plumbing fields as public: false**

```javascript
  // --- Heuristic: Hide internal plumbing fields ---
  const PLUMBING_PATTERNS = /^(message_id|event_gid|anonymous_gid|session_gid|user_gid|write_key|ttl_days)$/;

  for (const dim of dimensions) {
    if (dim.public !== undefined) continue; // Already set (e.g. PK = public: true)
    if (PLUMBING_PATTERNS.test(dim.name) || dim.name.endsWith('_gid') || dim.name === 'write_key') {
      dim.public = false;
    }
  }
```

- [ ] **Step 4: Commit**

```bash
git add services/cubejs/src/utils/smart-generation/cubeBuilder.js
git commit -m "feat: paired counts, drill members, format inference, public:false on plumbing"
```

---

### Task 4: Default pre-aggregations

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/cubeBuilder.js`

- [ ] **Step 1: Generate 2 default pre-aggregations after the cube is built**

In `buildRawCube`, before returning, add a `pre_aggregations` array to the cube:

```javascript
  // --- Heuristic: Default pre-aggregations ---
  const preAggDimensions = dimensions
    .filter((d) => d.type === 'string' && d.public !== false)
    .slice(0, 5)
    .map((d) => d.name);

  const preAggMeasures = measures
    .filter((m) => ['count', 'sum', 'min', 'max', 'count_distinct_approx'].includes(m.type))
    .slice(0, 10)
    .map((m) => m.name);

  const preAggregations = [];

  if (timeDim && preAggMeasures.length > 0) {
    // Rollup by day
    preAggregations.push({
      name: 'daily_rollup',
      type: 'rollup',
      dimensions: ['partition', ...preAggDimensions],
      measures: preAggMeasures,
      time_dimension: timeDim.name,
      granularity: 'day',
      partition_granularity: 'month',
      refresh_key: { every: '1 hour' },
      build_range_start: { sql: `SELECT min(${timeDim.name}) FROM ${schema}.${table}` },
      build_range_end: { sql: 'SELECT NOW()' },
      indexes: [
        { name: 'partition_idx', columns: ['partition', timeDim.name] },
      ],
    });

    // Rollup by month (coarser, for overview dashboards)
    preAggregations.push({
      name: 'monthly_rollup',
      type: 'rollup',
      dimensions: ['partition'],
      measures: preAggMeasures.slice(0, 5),
      time_dimension: timeDim.name,
      granularity: 'month',
      partition_granularity: 'month',
      refresh_key: { every: '1 hour' },
      indexes: [
        { name: 'partition_idx', columns: ['partition'] },
      ],
    });
  }
```

Add `pre_aggregations` to the returned cube object.

- [ ] **Step 2: Commit**

```bash
git add services/cubejs/src/utils/smart-generation/cubeBuilder.js
git commit -m "feat: add default daily and monthly pre-aggregations with ClickHouse indexes"
```

---

### Task 5: Update yamlGenerator to serialize new properties

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/yamlGenerator.js`

- [ ] **Step 1: Update `formatField` to include new properties**

In `formatField`, add serialization for: `title`, `description`, `public`, `format`, `drill_members`, `filters`, `primary_key`.

Find the `formatField` function and ensure it includes:

```javascript
  if (field.title) result.title = field.title;
  if (field.description) result.description = field.description;
  if (field.public === false) result.public = false;
  if (field.format) result.format = field.format;
  if (field.drill_members) result.drill_members = field.drill_members;
  if (field.filters) result.filters = field.filters;
  if (field.primary_key) result.primary_key = true;
```

- [ ] **Step 2: Update `formatCube` to include new properties**

In `formatCube`, ensure cube-level `title`, `description`, `pre_aggregations`, and `segments` are serialized:

```javascript
  if (cube.title) result.title = cube.title;
  if (cube.description) result.description = cube.description;
  if (cube.pre_aggregations && cube.pre_aggregations.length > 0) {
    result.pre_aggregations = cube.pre_aggregations;
  }
  if (cube.segments && cube.segments.length > 0) {
    result.segments = cube.segments.map(formatField);
  }
```

- [ ] **Step 3: Commit**

```bash
git add services/cubejs/src/utils/smart-generation/yamlGenerator.js
git commit -m "feat: serialize titles, descriptions, pre-aggregations, format, public, drill_members"
```

---

### Task 6: Integration test — verify generated model follows principles

- [ ] **Step 1: Restart services and run full flow**

```bash
docker compose -f docker-compose.dev.yml restart cubejs
```

Open Smart Generate, select `cst.semantic_events`, check `commerce`, add `entry_type IN [Line Item]`, profile, preview changes.

- [ ] **Step 2: Verify the generated model in Preview Changes**

Check the Change Preview for:
- Fields have titles (not just raw names)
- `count` measure has `drill_members`
- `revenue`, `tax`, `discount` have `format: currency`
- `discount_percentage`, `tax_percentage` have `format: percent`
- `message_id`, `event_gid`, `write_key` are `public: false`
- Paired filtered counts exist (e.g., `count_type_track`, `count_event_...`)
- Pre-aggregations section visible

- [ ] **Step 3: Check cube meta block**

Verify the cube has:
- `title`: human-readable name
- `description`: meaningful description
- `meta.grain`: describes the analytical grain
- `meta.time_dimension`: points to timestamp or business_day
- `meta.time_zone`: "UTC"
- `meta.refresh_cadence`: "1 hour"

- [ ] **Step 4: Click Apply Changes and verify model saved**

Apply the model. Check the Models page shows the generated file. Open it and verify it follows the principles.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "fix: integration fixes for cubeBuilder heuristics"
```
