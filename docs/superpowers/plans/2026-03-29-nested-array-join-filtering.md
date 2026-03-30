# Nested Array Join Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new step to the smart model generator that lets users select nested structures for array join, filter by discriminator columns, and auto-derive cube names from the filter context.

**Architecture:** New CubeJS route (`/api/v1/discover-nested`) detects nested column groups and their discriminator values. The smart gen mutation accepts a new `nestedFilters` parameter that flows through the RPC handler to `cubeBuilder.js`, which generates filtered `LEFT ARRAY JOIN` SQL. The frontend inserts a conditional `nested_config` step between table selection and profiling.

**Tech Stack:** JavaScript (ES modules, Node.js 22+), React 18 + Ant Design 5 + TypeScript, ClickHouse (system.columns queries), Hasura v2 (action input types), URQL (GraphQL client)

**Spec:** `docs/superpowers/specs/2026-03-29-nested-array-join-filtering-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `services/cubejs/src/routes/discoverNested.js` | New route: detect nested groups + discriminator values |
| Modify | `services/cubejs/src/routes/index.js` | Register the new route |
| Modify | `services/cubejs/src/utils/smart-generation/cubeBuilder.js` | Accept `nestedFilters`, generate filtered ARRAY JOIN SQL, derive cube name |
| Modify | `services/cubejs/src/routes/smartGenerate.js` | Parse + pass `nestedFilters` to `buildCubes()` and profiler |
| Modify | `services/cubejs/src/utils/smart-generation/profiler.js` | Accept nested filters in WHERE clause construction |
| Modify | `services/hasura/metadata/actions.graphql` | Add `NestedFilterInput` type + `nested_filters` param |
| Modify | `services/hasura/metadata/actions.yaml` | Register `NestedFilterInput` in custom_types |
| Modify | `services/actions/src/rpc/smartGenSchemas.js` | Pass `nested_filters` through to CubeJS API |
| Modify | `client-v2/src/graphql/gql/datasources.gql` | Add `$nested_filters` to mutation |
| Modify | `client-v2/src/components/SmartGeneration/index.tsx` | Add `nested_config` step, remove old array join UI |

---

### Task 1: Backend — `discoverNested` Route

**Files:**
- Create: `services/cubejs/src/routes/discoverNested.js`
- Modify: `services/cubejs/src/routes/index.js:27-28` (import) and `index.js:249-254` (mount)

- [ ] **Step 1: Create `discoverNested.js` with the route handler**

```javascript
// services/cubejs/src/routes/discoverNested.js
import { ColumnType } from '../utils/smart-generation/typeParser.js';

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
export default async function discoverNested(req, res, cubejs) {
  const { table, schema } = req.body;

  if (!table || !schema) {
    return res.status(400).json({ error: 'table and schema are required' });
  }

  try {
    const driver = await cubejs.driverFactory();

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
            discriminators.push({
              column: disc.column,
              childName: disc.child,
              values,
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
    res.status(500).json({ error: err.message || 'Failed to discover nested structures' });
  }
}
```

- [ ] **Step 2: Register the route in `index.js`**

Add the import at line 28 (after the `columnValues` import):

```javascript
import discoverNested from './discoverNested.js';
```

Add the route mount after the `column-values` route (after line 254):

```javascript
  router.post(
    `${basePath}/v1/discover-nested`,
    checkAuthMiddleware,
    async (req, res) => discoverNested(req, res, cubejs)
  );
```

- [ ] **Step 3: Test manually via curl**

```bash
curl -s -X POST http://localhost:4000/api/v1/discover-nested \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "x-hasura-datasource-id: <datasource-id>" \
  -H "x-hasura-branch-id: <branch-id>" \
  -d '{"table":"semantic_events","schema":"cst"}' | jq .
```

Expected: JSON with `groups` array containing entries like `{ name: "commerce.products", columnCount: 76, discriminators: [{ column: "commerce.products.entry_type", childName: "entry_type", values: ["Cart Item", "Line Item", ...] }] }`.

- [ ] **Step 4: Commit**

```bash
git add services/cubejs/src/routes/discoverNested.js services/cubejs/src/routes/index.js
git commit -m "feat: add /api/v1/discover-nested route for nested structure detection"
```

---

### Task 2: Backend — Enhance `cubeBuilder.js` for Nested Filters

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/cubeBuilder.js:708-774` (`buildArrayJoinCube`), `cubeBuilder.js:806-844` (`buildCubes`)

- [ ] **Step 1: Add `deriveCubeNameFromFilters` helper**

Add this function above `buildArrayJoinCube` (before line 708):

```javascript
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
```

- [ ] **Step 2: Update `buildArrayJoinCube` to accept nested filters**

Replace the `buildArrayJoinCube` function (lines 708-774) with:

```javascript
/**
 * Build a flattened ARRAY JOIN cube for nested column groups.
 *
 * When nestedFilters are provided, the SQL includes WHERE clauses on
 * discriminator columns and the cube name reflects the filter values.
 *
 * @param {object} profiledTable
 * @param {string[]} arrayJoinGroups - Parent group names to ARRAY JOIN (e.g. ["commerce.products"])
 * @param {object} rawCube - The already-built raw cube (to inherit non-array fields)
 * @param {object} options
 * @param {Array<{group: string, filters: Array<{column: string, values: string[]}>}>} [options.nestedFilters]
 * @returns {object} Cube definition
 */
function buildArrayJoinCube(profiledTable, arrayJoinGroups, rawCube, options) {
  const {
    partition = null,
    internalTables = [],
    nestedFilters = [],
  } = options;

  const schema = profiledTable.database;
  const table = profiledTable.table;
  const isInternal = internalTables.includes(table);

  // Collect all child columns for the selected groups
  const groupColumns = new Map(); // group -> [childName]
  for (const [colName, colData] of profiledTable.columns) {
    if (colData.columnType !== 'GROUPED' || !colData.parentName) continue;
    if (!arrayJoinGroups.includes(colData.parentName)) continue;
    if (!groupColumns.has(colData.parentName)) groupColumns.set(colData.parentName, []);
    groupColumns.get(colData.parentName).push(colData);
  }

  // Derive cube name from table + filter values (or group names if no filters)
  const allFilters = nestedFilters.flatMap((nf) => nf.filters || []);
  const filterSuffix = deriveCubeNameFromFilters(allFilters);
  const groupSuffix = filterSuffix || arrayJoinGroups.map((g) => sanitizeCubeName(g)).join('_');
  const cubeName = sanitizeCubeName(`${table}_${groupSuffix}`);

  // Build the ARRAY JOIN SQL with optional WHERE filters
  const arrayJoinClauses = arrayJoinGroups.map((g) => `${g}`);
  let sql = `SELECT * FROM ${schema}.${table} LEFT ARRAY JOIN ${arrayJoinClauses.join(', ')}`;

  // Collect WHERE conditions
  const whereParts = [];
  if (isInternal && partition) {
    whereParts.push(`partition = '${partition}'`);
  }
  for (const nf of nestedFilters) {
    for (const f of nf.filters || []) {
      const fullCol = f.column.includes('.') ? f.column : `${nf.group}.${f.column}`;
      if (f.values.length === 1) {
        whereParts.push(`${fullCol} = '${f.values[0].replace(/'/g, "\\'")}'`);
      } else if (f.values.length > 1) {
        const vals = f.values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(', ');
        whereParts.push(`${fullCol} IN (${vals})`);
      }
    }
  }
  if (whereParts.length > 0) {
    sql += ` WHERE ${whereParts.join(' AND ')}`;
  }

  // Start with non-array dimensions/measures from the raw cube
  const dimensions = rawCube.dimensions
    .filter((d) => !d._isArrayField)
    .map((d) => ({ ...d }));
  const measures = rawCube.measures.map((m) => ({ ...m }));

  // Add dimensions for each child column in the selected groups
  const existingNames = new Set([
    ...dimensions.map((d) => d.name),
    ...measures.map((m) => m.name),
  ]);

  for (const [group, cols] of groupColumns) {
    for (const col of cols) {
      const dimName = sanitizeFieldName(col.childName);
      let finalName = dimName;
      if (existingNames.has(finalName)) {
        finalName = `${sanitizeFieldName(group)}_${finalName}`;
      }
      if (existingNames.has(finalName)) {
        finalName = `${finalName}_${existingNames.size}`;
      }
      existingNames.add(finalName);

      // Map value types to Cube.js types
      let cubeType = 'string';
      if (col.valueType === 'NUMBER') cubeType = 'number';
      else if (col.valueType === 'DATE') cubeType = 'time';
      else if (col.valueType === 'BOOLEAN') cubeType = 'boolean';

      // Numeric child columns become measures; strings become dimensions
      if (col.valueType === 'NUMBER') {
        measures.push({
          name: finalName,
          sql: `{CUBE}.${col.childName}`,
          type: 'sum',
          meta: { auto_generated: true, source_column: col.name, source_group: group },
        });
      } else {
        dimensions.push({
          name: finalName,
          sql: `{CUBE}.${col.childName}`,
          type: cubeType,
          meta: { auto_generated: true, source_column: col.name, source_group: group },
        });
      }
    }
  }

  const meta = {
    auto_generated: true,
    source_database: schema,
    source_table: table,
    array_join_groups: arrayJoinGroups,
    nested_filters: nestedFilters.length > 0 ? nestedFilters : undefined,
    generated_at: new Date().toISOString(),
  };

  if (isInternal && partition) {
    meta.source_partition = partition;
  }

  return {
    name: cubeName,
    sql,
    meta,
    dimensions,
    measures,
  };
}
```

- [ ] **Step 3: Update `buildCubes` to handle both legacy `arrayJoinColumns` and new `nestedFilters`**

Replace the `buildCubes` function body (lines 806-844):

```javascript
export function buildCubes(profiledTable, options = {}) {
  const {
    arrayJoinColumns = [],
    nestedFilters = [],
  } = options;

  const cubes = [];

  // 1. Build the raw (main) cube
  const { cube: rawCube, mapKeysDiscovered, columnsProfiled, columnsSkipped } =
    buildRawCube(profiledTable, options);

  cubes.push(rawCube);

  // 2a. Build nested-filter ARRAY JOIN cube (new path)
  if (nestedFilters.length > 0) {
    const groups = nestedFilters.map((nf) => nf.group);
    const ajCube = buildArrayJoinCube(profiledTable, groups, rawCube, options);
    cubes.push(ajCube);
  }

  // 2b. Build legacy ARRAY JOIN cubes (backwards-compatible path)
  if (nestedFilters.length === 0) {
    for (const ajDef of arrayJoinColumns) {
      const legacyCube = buildArrayJoinCube(profiledTable, [ajDef.column], rawCube, {
        ...options,
        nestedFilters: [],
      });
      // Override name to use the legacy alias-based naming
      legacyCube.name = sanitizeCubeName(`${profiledTable.table}_${ajDef.alias}`);
      legacyCube.meta.array_join_column = ajDef.column;
      legacyCube.meta.array_join_alias = ajDef.alias;
      cubes.push(legacyCube);
    }
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
```

- [ ] **Step 4: Commit**

```bash
git add services/cubejs/src/utils/smart-generation/cubeBuilder.js
git commit -m "feat: enhance cubeBuilder with nested filter support and auto-derived cube names"
```

---

### Task 3: Backend — Update `smartGenerate.js` and `profiler.js`

**Files:**
- Modify: `services/cubejs/src/routes/smartGenerate.js:70-100` (param parsing)
- Modify: `services/cubejs/src/utils/smart-generation/profiler.js:48-78` (`buildWhereClause`)

- [ ] **Step 1: Add `nestedFilters` param parsing in `smartGenerate.js`**

After line 95 (`const filters = Array.isArray(rawFilters) ? rawFilters : [];`), add:

```javascript
  const nestedFilters = Array.isArray(req.body.nestedFilters) ? req.body.nestedFilters : [];
```

- [ ] **Step 2: Pass `nestedFilters` to `buildCubes` call**

Find the `buildCubes` call in `smartGenerate.js` (search for `buildCubes(`) and add `nestedFilters` to its options object:

```javascript
    nestedFilters,
```

- [ ] **Step 3: Update `buildWhereClause` in `profiler.js` to support nested filters**

Modify the `buildWhereClause` function to accept and apply nested filters. Add an `nestedFilters` parameter and generate array join + WHERE conditions:

After the existing `filterClause` block (around line 72), add:

```javascript
  // Nested filter clause — for profiling within ARRAY JOIN context
  let nestedClause = '';
  if (Array.isArray(nestedFilters) && nestedFilters.length > 0) {
    const parts = [];
    for (const nf of nestedFilters) {
      for (const f of nf.filters || []) {
        const fullCol = f.column.includes('.') ? f.column : `${nf.group}.${f.column}`;
        if (f.values.length === 1) {
          parts.push(`${fullCol} = '${f.values[0].replace(/'/g, "\\'")}'`);
        } else if (f.values.length > 1) {
          const vals = f.values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(', ');
          parts.push(`${fullCol} IN (${vals})`);
        }
      }
    }
    nestedClause = parts.join(' AND ');
  }
```

Update the return logic to include `nestedClause`:

```javascript
  const allParts = [partitionClause, filterClause, nestedClause].filter(Boolean);
  if (allParts.length > 0) {
    return ` WHERE ${allParts.join(' AND ')}`;
  }
  return '';
```

Also update the function signature to accept `nestedFilters`:

```javascript
export function buildWhereClause(schema, table, partition, internalTables, filters, tableColumns, nestedFilters) {
```

- [ ] **Step 4: Pass `nestedFilters` through all `buildWhereClause` call sites in `smartGenerate.js`**

Search for `buildWhereClause(` calls in `smartGenerate.js` and add the `nestedFilters` argument at the end of each call.

- [ ] **Step 5: Pass `nestedFilters` to the profiler call**

In `smartGenerate.js`, find where `profileTable` is called and ensure `nestedFilters` is included in the options passed to it.

- [ ] **Step 6: Commit**

```bash
git add services/cubejs/src/routes/smartGenerate.js services/cubejs/src/utils/smart-generation/profiler.js
git commit -m "feat: thread nestedFilters through smart-generate pipeline and profiler"
```

---

### Task 4: Hasura Action Schema + RPC Handler

**Files:**
- Modify: `services/hasura/metadata/actions.graphql:119` (add param), `actions.graphql:148+` (add input type)
- Modify: `services/hasura/metadata/actions.yaml:166` (register type)
- Modify: `services/actions/src/rpc/smartGenSchemas.js` (pass param)

- [ ] **Step 1: Add input types to `actions.graphql`**

After the `FilterConditionInput` definition (line 148), add:

```graphql
input NestedFilterConditionInput {
  column: String!
  values: [String!]!
}

input NestedFilterInput {
  group: String!
  filters: [NestedFilterConditionInput!]!
}
```

- [ ] **Step 2: Add `nested_filters` param to the mutation**

In the `smart_gen_dataschemas` mutation definition (line 119, before the closing paren), add:

```graphql
    nested_filters: [NestedFilterInput]
```

- [ ] **Step 3: Register types in `actions.yaml`**

In the `custom_types.input_objects` list (after `FilterConditionInput`), add:

```yaml
    - name: NestedFilterConditionInput
    - name: NestedFilterInput
```

- [ ] **Step 4: Update the RPC handler to pass `nested_filters`**

In `services/actions/src/rpc/smartGenSchemas.js`, add to the destructured input:

```javascript
    nested_filters: nestedFilters,
```

And add to the `cubejsApi().smartGenerate()` call:

```javascript
      nestedFilters,
```

- [ ] **Step 5: Apply Hasura metadata**

```bash
./cli.sh hasura cli "metadata apply"
```

- [ ] **Step 6: Commit**

```bash
git add services/hasura/metadata/actions.graphql services/hasura/metadata/actions.yaml services/actions/src/rpc/smartGenSchemas.js
git commit -m "feat: add NestedFilterInput types to Hasura actions and RPC handler"
```

---

### Task 5: Frontend — GraphQL Mutation Update

**Files:**
- Modify: `../client-v2/src/graphql/gql/datasources.gql:216-258`
- Regenerate: `../client-v2/src/graphql/generated.ts` (via codegen)

- [ ] **Step 1: Add `$nested_filters` to the mutation**

In `datasources.gql`, add to the `SmartGenDataSchemas` mutation variables (after `$selected_columns`):

```graphql
  $nested_filters: [NestedFilterInput]
```

And add to the mutation body arguments:

```graphql
    nested_filters: $nested_filters
```

- [ ] **Step 2: Regenerate TypeScript types**

```bash
cd ../client-v2 && yarn codegen
```

- [ ] **Step 3: Commit**

```bash
cd ../client-v2 && git add src/graphql/gql/datasources.gql src/graphql/generated.ts
git commit -m "feat: add nested_filters to SmartGenDataSchemas mutation"
```

---

### Task 6: Frontend — `nested_config` Step in SmartGeneration

**Files:**
- Modify: `../client-v2/src/components/SmartGeneration/index.tsx`

- [ ] **Step 1: Add types and state**

Add to the `SmartGenStep` union type (line 829):

```typescript
type SmartGenStep =
  | "select"
  | "nested_config"
  | "profiling"
  | "preview"
  | "previewing_changes"
  | "change_preview"
  | "applying"
  | "done";
```

Add the `NestedGroup` interface after `ArrayJoinSelection` (line 842):

```typescript
interface NestedDiscriminator {
  column: string;
  childName: string;
  values: string[];
  selectedValues: string[];
}

interface NestedGroup {
  name: string;
  columnCount: number;
  selected: boolean;
  discriminators: NestedDiscriminator[];
}
```

Add state in the component (after line 883, replacing `arrayJoinSelections` state):

```typescript
  const [nestedGroups, setNestedGroups] = useState<NestedGroup[]>([]);
  const [nestedLoading, setNestedLoading] = useState(false);
```

- [ ] **Step 2: Add the discover-nested fetch on table selection**

Replace `handleTableSelect` (lines 1163-1169) with:

```typescript
  const handleTableSelect = useCallback(
    async (value: string) => {
      const [schemaName, tableName] = value.split("::");
      setSelectedSchema(schemaName);
      setSelectedTable(tableName);
      setFilters([]);
      setError(null);
      setNestedGroups([]);

      // Discover nested structures
      const token =
        AuthTokensStore.getState().workosAccessToken ||
        AuthTokensStore.getState().accessToken;

      setNestedLoading(true);
      try {
        const res = await fetch("/api/v1/discover-nested", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "x-hasura-datasource-id": dataSource.id!,
            "x-hasura-branch-id": branchId,
          },
          body: JSON.stringify({ table: tableName, schema: schemaName }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.groups?.length > 0) {
            setNestedGroups(
              data.groups.map((g: any) => ({
                name: g.name,
                columnCount: g.columnCount,
                selected: false,
                discriminators: (g.discriminators || []).map((d: any) => ({
                  column: d.column,
                  childName: d.childName,
                  values: d.values || [],
                  selectedValues: [],
                })),
              }))
            );
          }
        }
      } catch {
        // Non-fatal — proceed without nested discovery
      } finally {
        setNestedLoading(false);
      }
    },
    [dataSource.id, branchId]
  );
```

- [ ] **Step 3: Update the "Profile Table" button to route through nested_config when groups exist**

In the `select` step's "Profile Table" button onClick (line 1401), change to:

```typescript
            <Button
              type="primary"
              size="large"
              disabled={!selectedTable || nestedLoading}
              loading={nestedLoading}
              onClick={() => {
                if (nestedGroups.length > 0) {
                  setStep("nested_config");
                } else {
                  handleProfile();
                }
              }}
            >
              {nestedLoading ? "Checking structure..." : "Profile Table"}
            </Button>
```

- [ ] **Step 4: Add the `derivedCubeName` computation**

Add a `useMemo` after the existing state declarations:

```typescript
  const derivedCubeName = useMemo(() => {
    if (!selectedTable) return "";
    const selectedNested = nestedGroups.filter((g) => g.selected);
    if (selectedNested.length === 0) return "";

    const filterValues = selectedNested.flatMap((g) =>
      g.discriminators.flatMap((d) =>
        d.selectedValues.map((v) =>
          v.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/, "") +
          (v.toLowerCase().endsWith("s") ? "" : "s")
        )
      )
    );

    if (filterValues.length > 0) {
      return `${selectedTable}_${filterValues.join("_")}`;
    }
    const groupNames = selectedNested.map((g) =>
      g.name.replace(/[^a-zA-Z0-9]/g, "_")
    );
    return `${selectedTable}_${groupNames.join("_")}`;
  }, [selectedTable, nestedGroups]);
```

- [ ] **Step 5: Add the `nested_config` step JSX**

After the `{/* Step 1: Table Selection */}` block (after line 1408), add:

```tsx
      {/* Step 1.5: Nested Structure Configuration (conditional) */}
      {step === "nested_config" && (
        <>
          <div style={{ marginBottom: 16 }}>
            <Title level={5}>
              Nested Structures Detected
            </Title>
            <Text type="secondary">
              {nestedGroups.length} nested group{nestedGroups.length !== 1 ? "s" : ""} found
              in {selectedTable}. Expand a group to array join and filter it.
            </Text>
          </div>

          <div style={{ marginBottom: 16 }}>
            {nestedGroups.map((group, gIdx) => (
              <div
                key={group.name}
                style={{
                  border: "1px solid var(--color-border, #d9d9d9)",
                  borderRadius: 8,
                  marginBottom: 8,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 16px",
                    cursor: "pointer",
                    background: group.selected
                      ? "var(--color-primary-bg, #e6f4ff)"
                      : "transparent",
                  }}
                  onClick={() => {
                    const updated = [...nestedGroups];
                    updated[gIdx] = { ...updated[gIdx], selected: !updated[gIdx].selected };
                    setNestedGroups(updated);
                  }}
                >
                  <Checkbox checked={group.selected} />
                  <Text strong>{group.name}</Text>
                  <Tag>{group.columnCount} columns</Tag>
                  <RightOutlined
                    style={{
                      marginLeft: "auto",
                      transform: group.selected ? "rotate(90deg)" : "none",
                      transition: "transform 0.2s",
                    }}
                  />
                </div>

                {group.selected && group.discriminators.length > 0 && (
                  <div style={{ padding: "0 16px 16px", borderTop: "1px solid var(--color-border, #f0f0f0)" }}>
                    {group.discriminators.map((disc, dIdx) => (
                      <div key={disc.column} style={{ marginTop: 12 }}>
                        <Text type="secondary" style={{ display: "block", marginBottom: 4, fontSize: 12 }}>
                          Filter by {disc.childName}
                        </Text>
                        <Checkbox.Group
                          options={disc.values.map((v) => ({ label: v, value: v }))}
                          value={disc.selectedValues}
                          onChange={(checked) => {
                            const updated = [...nestedGroups];
                            const updatedDiscs = [...updated[gIdx].discriminators];
                            updatedDiscs[dIdx] = {
                              ...updatedDiscs[dIdx],
                              selectedValues: checked as string[],
                            };
                            updated[gIdx] = { ...updated[gIdx], discriminators: updatedDiscs };
                            setNestedGroups(updated);
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {group.selected && group.discriminators.length === 0 && (
                  <div style={{ padding: "8px 16px 16px", borderTop: "1px solid var(--color-border, #f0f0f0)" }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      No discriminator columns detected — all rows will be included in the array join.
                    </Text>
                  </div>
                )}
              </div>
            ))}
          </div>

          {derivedCubeName && (
            <div style={{ marginBottom: 16 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>Cube name: </Text>
              <Tag color="blue">{derivedCubeName}</Tag>
            </div>
          )}

          {error && (
            <Alert className={styles.errorMessage} message={error} type="error" showIcon />
          )}

          <div className={styles.actions}>
            <Button size="large" onClick={() => setStep("select")}>
              Back
            </Button>
            <Button
              type="link"
              onClick={() => {
                setNestedGroups((prev) => prev.map((g) => ({ ...g, selected: false })));
                handleProfile();
              }}
            >
              Skip — no array joins
            </Button>
            <Button
              type="primary"
              size="large"
              onClick={() => {
                if (derivedCubeName) {
                  setCubeNameOverride(derivedCubeName);
                  setFileNameOverride(`${derivedCubeName}.js`);
                }
                handleProfile();
              }}
            >
              Continue
            </Button>
          </div>
        </>
      )}
```

- [ ] **Step 6: Remove the old array join UI from the `preview` step**

Delete lines 1447-1495 (the `{arrayJoinSelections.length > 0 && (...)}` block in the preview step). Remove the `arrayJoinSelections` and `setArrayJoinSelections` state declarations and all references to them.

- [ ] **Step 7: Wire `nestedFilters` into `handlePreviewChanges` and `handleApply`**

In both `handlePreviewChanges` (around line 1177) and `handleApply` (around line 1243), replace the `selectedArrayJoins` logic with:

```typescript
    // Build nestedFilters from nestedGroups state
    const activeNested = nestedGroups
      .filter((g) => g.selected)
      .map((g) => ({
        group: g.name,
        filters: g.discriminators
          .filter((d) => d.selectedValues.length > 0)
          .map((d) => ({ column: d.childName, values: d.selectedValues })),
      }));
```

And pass it in the mutation call:

```typescript
      nested_filters: activeNested.length > 0 ? activeNested : undefined,
```

Remove the old `array_join_columns` parameter from both mutation calls.

- [ ] **Step 8: Commit**

```bash
cd ../client-v2 && git add src/components/SmartGeneration/index.tsx
git commit -m "feat: add nested_config step to smart generation UI with filter cards"
```

---

### Task 7: Integration Test

**Files:** No new files — manual browser testing

- [ ] **Step 1: Restart services**

```bash
./cli.sh compose restart actions cubejs
```

Wait for services to be healthy.

- [ ] **Step 2: Open the smart generator in the browser**

Navigate to the Models page for dev-clickhouse, open Smart Generate, select `cst.semantic_events`.

- [ ] **Step 3: Verify nested structure detection**

After selecting the table, the "Profile Table" button should briefly show "Checking structure..." while the `/api/v1/discover-nested` call runs. Then clicking it should advance to the `nested_config` step showing groups like `commerce.products`, `involves`, `sentiment`, `classification`, `location`, etc.

- [ ] **Step 4: Test nested filter selection**

Expand `commerce.products`, verify `entry_type` appears as a discriminator with checkbox values. Select "Line Item". Verify the cube name preview shows `semantic_events_line_items`.

- [ ] **Step 5: Continue through the full flow**

Click "Continue", verify profiling runs, then preview the generated cube. The cube SQL should include `LEFT ARRAY JOIN commerce.products WHERE commerce.products.entry_type = 'Line Item'`. The cube name should be `semantic_events_line_items`.

- [ ] **Step 6: Test the skip path**

Go back and click "Skip — no array joins". Verify it proceeds to profiling without array join context, producing a standard `semantic_events` cube.

- [ ] **Step 7: Commit any fixes**

```bash
git add -A && git commit -m "fix: integration fixes for nested array join filtering"
```
