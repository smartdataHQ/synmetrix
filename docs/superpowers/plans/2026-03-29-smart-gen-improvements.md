# Smart Model Generator Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three improvements to the smart model generator: (A) consolidate all filtering into step 1's FilterBuilder, (B) make Change Preview use the same ColumnList UI as the profile step, (C) add an LLM polishing step that rewrites generated models according to cube-principles.md.

**Architecture:** (A) replaces the `nested_config` step with a compact group selector + moves discriminator filters into the existing FilterBuilder. (B) extracts ColumnList into a shared component and adapts Change Preview to use it. (C) adds a new `polishWithLLM` module that takes generated cube JS and the cube principles, sends to GPT with structured output, and returns a polished model with validation report.

**Tech Stack:** TypeScript (React 18, Ant Design 5), JavaScript (Node.js 22, ES modules), OpenAI API (gpt-5.4, structured output via Zod), Cube.js YAML/JS models

**Spec:** `docs/superpowers/specs/2026-03-29-nested-array-join-filtering-design.md`
**Principles:** `/Users/stefanbaxter/Development/fraios/shared/principles/cube-principles.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `client-v2/src/components/SmartGeneration/index.tsx` | (A) Replace nested_config with group selector, add discriminator filters to FilterBuilder. (B) Use ColumnList for change preview |
| Modify | `client-v2/src/components/SmartGeneration/FilterBuilder.tsx` | (A) Accept nested discriminator filter definitions and render them inline |
| Create | `services/cubejs/src/utils/smart-generation/modelPolisher.js` | (C) LLM call to polish generated models per cube-principles |
| Modify | `services/cubejs/src/routes/smartGenerate.js` | (C) Insert polish step after buildCubes + AI enrichment |
| Modify | `services/cubejs/src/routes/discoverNested.js` | (A) Return discriminator info as FilterBuilder-compatible schema |

---

### Task 1: Simplify `nested_config` into a compact group selector

The current `nested_config` step shows 24 collapsible cards with discriminator checkboxes. This replaces it with a compact checklist (just group names + column counts) that returns the user to the `select` step where discriminator filters appear in the existing FilterBuilder.

**Files:**
- Modify: `client-v2/src/components/SmartGeneration/index.tsx`

- [ ] **Step 1: Replace the `nested_config` step JSX with a compact group selector**

Find the `{step === "nested_config" && (` block (around line 1495). Replace the entire block (through its closing `)}`) with a compact inline selector that appears as part of the `select` step instead. The new design:

- Remove `"nested_config"` from `SmartGenStep` type — it's no longer a separate step
- Add a new section in the `select` step (after filters, before the action buttons) that shows when `nestedGroups.length > 0`
- The section is a compact scrollable list of checkboxes (group name + column count), max-height 200px
- When a group is checked, its discriminator columns are injected into the FilterBuilder as pre-configured filter rows

```tsx
          {/* Nested structure selection (shown when groups detected) */}
          {nestedGroups.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <Title level={5}>Array Join (optional)</Title>
              <Text
                type="secondary"
                style={{ display: "block", marginBottom: 8, fontSize: 12 }}
              >
                Select nested structures to flatten via ARRAY JOIN. Discriminator
                filters will appear in the filter builder above.
              </Text>
              <div
                style={{
                  maxHeight: 200,
                  overflowY: "auto",
                  border: "1px solid var(--color-border, #d9d9d9)",
                  borderRadius: 6,
                  padding: "4px 0",
                }}
              >
                {nestedGroups.map((group, gIdx) => (
                  <div
                    key={group.name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "4px 12px",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                    onClick={() => {
                      const updated = [...nestedGroups];
                      updated[gIdx] = {
                        ...updated[gIdx],
                        selected: !updated[gIdx].selected,
                      };
                      setNestedGroups(updated);
                    }}
                  >
                    <Checkbox checked={group.selected} />
                    <Text style={{ fontSize: 13 }}>{group.name}</Text>
                    <Tag style={{ fontSize: 11 }}>{group.columnCount} cols</Tag>
                  </div>
                ))}
              </div>
              {derivedCubeName && (
                <div style={{ marginTop: 8 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Cube name:{" "}
                  </Text>
                  <Tag color="blue">{derivedCubeName}</Tag>
                </div>
              )}
            </div>
          )}
```

- [ ] **Step 2: Remove the `nested_config` step type and routing logic**

- Remove `"nested_config"` from the `SmartGenStep` union type
- In the "Profile Table" button's onClick, remove the `if (nestedGroups.length > 0) { setStep("nested_config") }` branch — it should always call `handleProfile()` directly (but first set cube name overrides if groups are selected)
- Remove the "Back" / "Skip" / "Continue" button group that was part of `nested_config`
- Update `handleProfile` to set cube name overrides before profiling if `derivedCubeName` is non-empty

```tsx
            <Button
              type="primary"
              size="large"
              disabled={!selectedTable || nestedLoading}
              loading={nestedLoading}
              onClick={() => {
                if (derivedCubeName) {
                  setCubeNameOverride(derivedCubeName);
                  setFileNameOverride(`${derivedCubeName}.js`);
                }
                handleProfile();
              }}
            >
              {nestedLoading ? "Checking structure..." : "Profile Table"}
            </Button>
```

- [ ] **Step 3: Commit**

```bash
cd ../client-v2 && git add src/components/SmartGeneration/index.tsx
git commit -m "refactor: replace nested_config step with compact inline group selector"
```

---

### Task 2: Inject discriminator filters into FilterBuilder

When a nested group is selected, its discriminator columns should appear as pre-populated filter rows in the existing FilterBuilder. The user can then modify operators, values, or remove them like any other filter.

**Files:**
- Modify: `client-v2/src/components/SmartGeneration/FilterBuilder.tsx`
- Modify: `client-v2/src/components/SmartGeneration/index.tsx`
- Modify: `services/cubejs/src/routes/discoverNested.js`

- [ ] **Step 1: Update `discoverNested.js` to return discriminator schema info**

Add `raw_type` and `value_type` to each discriminator in the response so the FilterBuilder can render appropriate operators:

In `services/cubejs/src/routes/discoverNested.js`, update the discriminator objects pushed to the `discriminators` array:

```javascript
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
```

- [ ] **Step 2: Add `suggestedFilters` prop to FilterBuilder**

In `FilterBuilder.tsx`, add an optional prop that injects read-only "suggested" filter chips above the regular filter rows. These come from nested group discriminators and let the user click to add them as real filters.

Add to the props interface:

```typescript
export interface SuggestedFilter {
  column: string;
  label: string;       // e.g. "commerce.products.entry_type"
  values: string[];     // distinct values available
  value_type: string;   // STRING, NUMBER, etc.
}

export interface FilterBuilderProps {
  schema: SchemaColumn[];
  filters: FilterCondition[];
  onChange: (filters: FilterCondition[]) => void;
  dimensionMap?: DimensionMap;
  tableName?: string;
  tableSchema?: string;
  datasourceId?: string;
  branchId?: string;
  suggestedFilters?: SuggestedFilter[];  // NEW
}
```

- [ ] **Step 3: Render suggested filter chips in FilterBuilder**

Before the existing filter rows, render a row of clickable chips for each suggested filter. Clicking a chip adds a pre-populated filter row with `column`, `operator: "IN"`, and `value: []` (empty — user picks values from the chip's available list).

Add this JSX above the existing filter rows (before the `{filters.map(...)}`):

```tsx
      {suggestedFilters && suggestedFilters.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>
            Array join filters — click to add:
          </Text>
          <Space size={4} wrap>
            {suggestedFilters
              .filter(
                (sf) => !filters.some((f) => f.column === sf.column)
              )
              .map((sf) => (
                <Tag
                  key={sf.column}
                  color="blue"
                  style={{ cursor: "pointer", fontSize: 12 }}
                  onClick={() => {
                    if (filters.length >= MAX_FILTERS) return;
                    onChange([
                      ...filters,
                      { column: sf.column, operator: "IN", value: [] },
                    ]);
                  }}
                >
                  + {sf.label}
                </Tag>
              ))}
          </Space>
        </div>
      )}
```

- [ ] **Step 4: Build suggestedFilters from nestedGroups in SmartGeneration**

In `index.tsx`, compute `suggestedFilters` from selected nested groups and pass to FilterBuilder:

```typescript
  const suggestedFilters = useMemo(() => {
    const selected = nestedGroups.filter((g) => g.selected);
    if (selected.length === 0) return undefined;
    return selected.flatMap((g) =>
      g.discriminators.map((d) => ({
        column: d.column,
        label: `${g.name}.${d.childName}`,
        values: d.values,
        value_type: "STRING" as const,
      }))
    );
  }, [nestedGroups]);
```

Pass it to FilterBuilder:

```tsx
              <FilterBuilder
                schema={...}
                filters={filters}
                onChange={setFilters}
                dimensionMap={dimensionMap}
                tableName={selectedTable}
                tableSchema={selectedSchema}
                datasourceId={dataSource.id!}
                branchId={branchId}
                suggestedFilters={suggestedFilters}
              />
```

- [ ] **Step 5: Ensure nested discriminator columns appear in FilterBuilder column dropdown**

The FilterBuilder's column dropdown is built from the `schema` prop. Nested discriminator columns (like `commerce.products.entry_type`) must be in that list. Update the `schema` computation in the `select` step to include discriminator columns from selected groups:

```typescript
                schema={(() => {
                  const tableColumns =
                    schema?.[selectedSchema]?.[selectedTable] || [];
                  const base = tableColumns.map((col) => ({
                    name: col.name,
                    raw_type: col.type,
                    value_type: /int|float|decimal|double/i.test(col.type)
                      ? "NUMBER"
                      : /date|datetime/i.test(col.type)
                      ? "DATE"
                      : /bool/i.test(col.type)
                      ? "BOOLEAN"
                      : "STRING",
                  }));
                  // Add discriminator columns from selected nested groups
                  const discCols = nestedGroups
                    .filter((g) => g.selected)
                    .flatMap((g) =>
                      g.discriminators.map((d) => ({
                        name: d.column,
                        raw_type: "LowCardinality(String)",
                        value_type: "STRING",
                      }))
                    )
                    .filter((dc) => !base.some((b) => b.name === dc.name));
                  return [...base, ...discCols];
                })()}
```

- [ ] **Step 6: Convert discriminator filter values to `nestedFilters` for the backend**

In `handlePreviewChanges` and `handleApply`, build `nestedFilters` from the filters state by detecting which filters target nested discriminator columns:

```typescript
    // Build nestedFilters from filters that target nested discriminator columns
    const selectedNested = nestedGroups.filter((g) => g.selected);
    const discColumns = new Set(
      selectedNested.flatMap((g) => g.discriminators.map((d) => d.column))
    );
    const nestedFilterMap = new Map<string, { column: string; values: string[] }[]>();
    const regularFilters: FilterCondition[] = [];

    for (const f of filters) {
      if (discColumns.has(f.column)) {
        // Find the group this discriminator belongs to
        const group = selectedNested.find((g) =>
          g.discriminators.some((d) => d.column === f.column)
        );
        if (group) {
          if (!nestedFilterMap.has(group.name)) nestedFilterMap.set(group.name, []);
          const values = f.operator === "IN" || f.operator === "NOT IN"
            ? (Array.isArray(f.value) ? f.value : [f.value]).filter(Boolean)
            : f.value != null ? [String(f.value)] : [];
          if (values.length > 0) {
            const childName = f.column.includes(".")
              ? f.column.split(".").pop()!
              : f.column;
            nestedFilterMap.get(group.name)!.push({ column: childName, values });
          }
        }
      } else {
        regularFilters.push(f);
      }
    }

    const activeNested = selectedNested.map((g) => ({
      group: g.name,
      filters: nestedFilterMap.get(g.name) || [],
    }));
```

Then pass `regularFilters` as `filters` and `activeNested` as `nested_filters` in the mutation.

- [ ] **Step 7: Commit**

```bash
cd ../client-v2 && git add src/components/SmartGeneration/
git commit -m "feat: inject nested discriminator filters into FilterBuilder"
cd ../synmetrix && git add services/cubejs/src/routes/discoverNested.js
git commit -m "feat: return raw_type and value_type in discoverNested discriminators"
```

---

### Task 3: Make Change Preview use ColumnList-style UI

The current Change Preview uses plain Ant Design Tables. Replace it with the same ColumnList visual style (status dots, fill bars, expand/collapse, search/filter tabs) used in the profile preview step.

**Files:**
- Modify: `client-v2/src/components/SmartGeneration/index.tsx`

- [ ] **Step 1: Adapt ChangePreviewPanel to use ColumnList-style rendering**

Replace the `ChangePreviewPanel` component (lines 193-431) with a new version that renders fields using the same visual language as `ColumnList`:

- Status dots: green for added, blue for updated, red for removed, gray for preserved
- Group fields by category (Added, Updated, Removed, Preserved) using tabs similar to the All/Active/Empty tabs in ColumnList
- Each field row shows: status dot, field name, member_type tag, cube type, cube name
- Click to expand shows the field's SQL, description, and reason (for preserved fields)
- Search filter across all field names
- Scrollable container with max-height matching ColumnList

The key difference from ColumnList: these are model fields (dimensions/measures), not raw columns. So the columns are:
```
[StatusDot] | Name | Member Type (dim/measure tag) | Cube Type | Cube
```

Replace the `ChangePreviewPanel` FC with:

```tsx
const ChangePreviewPanel: FC<{ preview: ChangePreview }> = ({ preview }) => {
  const [filter, setFilter] = useState<"all" | "added" | "updated" | "removed" | "preserved">("all");
  const [search, setSearch] = useState("");
  const [expandedField, setExpandedField] = useState<string | null>(null);

  const allFields = useMemo(() => {
    const fields: Array<ChangeField & { _status: string }> = [];
    preview.fields_added.forEach((f) => fields.push({ ...f, _status: "added" }));
    preview.fields_updated.forEach((f) => fields.push({ ...f, _status: "updated" }));
    preview.fields_removed.forEach((f) => fields.push({ ...f, _status: "removed" }));
    preview.fields_preserved
      .filter((f) => f.reason !== "ai_generated")
      .forEach((f) => fields.push({ ...f, _status: "preserved" }));
    return fields;
  }, [preview]);

  const counts = useMemo(() => ({
    all: allFields.length,
    added: preview.fields_added.length,
    updated: preview.fields_updated.length,
    removed: preview.fields_removed.length,
    preserved: preview.fields_preserved.filter((f) => f.reason !== "ai_generated").length,
  }), [allFields, preview]);

  const filtered = useMemo(() => {
    let result = allFields;
    if (filter !== "all") result = result.filter((f) => f._status === filter);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (f) => f.name.toLowerCase().includes(q) || f.cube.toLowerCase().includes(q)
      );
    }
    return result;
  }, [allFields, filter, search]);

  const statusColor: Record<string, string> = {
    added: "var(--color-success, #52c41a)",
    updated: "var(--color-primary, #1677ff)",
    removed: "var(--color-error, #ff4d4f)",
    preserved: "var(--color-text-quaternary, #bfbfbf)",
  };

  return (
    <div className={styles.changePreview} style={{ maxHeight: 450, overflowY: "auto" }}>
      <Title level={5}>Change Preview</Title>
      <Text type="secondary" style={{ display: "block", marginBottom: 12 }}>
        {preview.summary}
      </Text>

      <div className={styles.columnFilterTabs}>
        {(["all", "added", "updated", "removed", "preserved"] as const).map((f) => (
          <span
            key={f}
            className={`${styles.columnFilterTab} ${filter === f ? styles.columnFilterTabActive : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? `All (${counts.all})`
              : f === "added" ? `+${counts.added} Added`
              : f === "updated" ? `~${counts.updated} Updated`
              : f === "removed" ? `-${counts.removed} Removed`
              : `${counts.preserved} Preserved`}
          </span>
        ))}
        <AntInput
          placeholder="Filter fields..."
          size="small"
          allowClear
          className={styles.columnSearchInput}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className={styles.columnScroll}>
        <div className={styles.columnItemHeader}>
          <span />
          <span>Name</span>
          <span>Type</span>
          <span>Cube Type</span>
          <span>Cube</span>
        </div>
        {filtered.map((field) => {
          const key = `${field.cube}.${field.name}`;
          const isOpen = expandedField === key;
          return (
            <div key={key}>
              <div
                className={`${styles.columnItem} ${isOpen ? styles.columnItemExpanded : ""}`}
                onClick={() => setExpandedField(isOpen ? null : key)}
              >
                <span
                  className={styles.columnStatusDot}
                  style={{ backgroundColor: statusColor[field._status] }}
                />
                <span className={styles.columnName}>{field.name}</span>
                <span>
                  <Tag
                    color={field.member_type === "dimension" ? "blue" : "green"}
                    style={{ margin: 0, fontSize: 11 }}
                  >
                    {field.member_type}
                  </Tag>
                </span>
                <span className={styles.columnType}>{field.type || "—"}</span>
                <span className={styles.columnInfo}>
                  <span className={styles.columnInfoText}>{field.cube}</span>
                </span>
              </div>
              {isOpen && (
                <div className={styles.columnDetails}>
                  <div className={styles.detailGrid}>
                    {field.reason && (
                      <div className={styles.detailItem}>
                        <span className={styles.detailLabel}>Reason</span>
                        <span className={styles.detailValue}>{field.reason}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--color-dimgray-300)", fontSize: 13 }}>
            No fields match "{search}"
          </div>
        )}
      </div>

      {/* AI Metrics section — keep existing */}
      {(preview.ai_metrics_added?.length ?? 0) > 0 ||
       (preview.ai_metrics_retained?.length ?? 0) > 0 ||
       (preview.ai_metrics_removed?.length ?? 0) > 0 ? (
        <div className={styles.changeSection} style={{ marginTop: 12 }}>
          <div className={styles.changeSectionHeader}>
            <Text strong>AI-Generated Metrics</Text>
          </div>
          {/* ... keep existing AI metric tag rendering ... */}
        </div>
      ) : null}
    </div>
  );
};
```

- [ ] **Step 2: Verify the CSS classes from ColumnList apply correctly**

The new ChangePreviewPanel reuses CSS classes from ColumnList (`.columnFilterTabs`, `.columnItem`, `.columnStatusDot`, etc.). The `.columnItemHeader` grid needs a slightly different column layout (no checkbox, no chevron, no fill bar). Add a modifier class or inline grid override:

```tsx
        <div className={styles.columnItemHeader} style={{
          gridTemplateColumns: "8px 1fr 80px 80px 1fr",
        }}>
```

And for each row:

```tsx
                className={`${styles.columnItem} ${isOpen ? styles.columnItemExpanded : ""}`}
                style={{ gridTemplateColumns: "8px 1fr 80px 80px 1fr" }}
```

- [ ] **Step 3: Commit**

```bash
cd ../client-v2 && git add src/components/SmartGeneration/index.tsx
git commit -m "feat: change preview uses ColumnList-style UI with tabs and search"
```

---

### Task 4: Create the `modelPolisher.js` LLM module

This is the core of improvement (C). A new module that takes generated cube JS code and rewrites it according to cube-principles.md using an LLM with structured output.

**Files:**
- Create: `services/cubejs/src/utils/smart-generation/modelPolisher.js`

- [ ] **Step 1: Create `modelPolisher.js` with the LLM call**

```javascript
// services/cubejs/src/utils/smart-generation/modelPolisher.js

/**
 * Model polisher — rewrites a generated Cube.js model to conform
 * to cube-principles.md using an LLM with structured output.
 *
 * Input: generated JS model code, table profile summary, cube principles
 * Output: polished JS model code + validation report
 */

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const MODEL = 'gpt-5.4';
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

// -- Structured output schema ------------------------------------------------

const PolishedFieldSchema = z.object({
  name: z.string(),
  sql: z.string(),
  type: z.string(),
  fieldType: z.enum(['dimension', 'measure', 'segment']),
  title: z.string().describe('Human-readable title for non-technical consumers'),
  description: z.string().nullable().describe('Description for non-obvious fields'),
  public: z.boolean().nullable().describe('false for internal plumbing fields'),
  primary_key: z.boolean().nullable(),
  format: z.enum(['currency', 'percent']).nullable(),
  meta: z.record(z.any()).nullable(),
  drill_members: z.array(z.string()).nullable(),
  rollingWindow: z.any().nullable(),
  multiStage: z.boolean().nullable(),
  timeShift: z.any().nullable(),
});

const PolishedCubeSchema = z.object({
  name: z.string(),
  sql: z.string().nullable(),
  sql_table: z.string().nullable(),
  title: z.string(),
  description: z.string().describe('Paragraph: grain, source, analytical questions supported'),
  meta: z.object({
    grain: z.string(),
    grain_description: z.string(),
    time_dimension: z.string().nullable(),
    time_zone: z.string().nullable(),
    refresh_cadence: z.string().nullable(),
    auto_generated: z.boolean(),
  }).passthrough(),
  dimensions: z.array(PolishedFieldSchema),
  measures: z.array(PolishedFieldSchema),
  segments: z.array(PolishedFieldSchema).nullable(),
  pre_aggregations: z.array(z.object({
    name: z.string(),
    type: z.enum(['rollup', 'original_sql', 'rollup_join', 'rollup_lambda']),
    dimensions: z.array(z.string()).nullable(),
    measures: z.array(z.string()).nullable(),
    time_dimension: z.string().nullable(),
    granularity: z.string().nullable(),
    partition_granularity: z.string().nullable(),
    refresh_key: z.any().nullable(),
    indexes: z.array(z.object({
      name: z.string(),
      columns: z.array(z.string()),
    })).nullable(),
  })).nullable(),
});

const PolishResponseSchema = z.object({
  cubes: z.array(PolishedCubeSchema),
  validation_report: z.object({
    principles_applied: z.array(z.string()).describe('Which principles from cube-principles.md were applied'),
    issues_fixed: z.array(z.string()).describe('Specific issues found and corrected'),
    warnings: z.array(z.string()).describe('Things the user should review manually'),
    grain: z.string().describe('The identified analytical grain'),
    primary_key: z.string().describe('The identified primary key expression'),
  }),
});

// -- Principles loader -------------------------------------------------------

let _principlesCache = null;

function loadPrinciples() {
  if (_principlesCache) return _principlesCache;
  try {
    const principlesPath = process.env.CUBE_PRINCIPLES_PATH
      || '/app/shared/principles/cube-principles.md';
    _principlesCache = fs.readFileSync(principlesPath, 'utf-8');
  } catch {
    // Fallback: inline summary of key principles
    _principlesCache = `
# Cube Modeling Principles (Summary)

- One cube = one grain. Primary key encodes the grain.
- Partition is always the first dimension.
- Push all computation into SQL. Cube layer is a thin projection.
- Wrap SQL in SELECT * FROM (...). No CTE/WITH/HAVING.
- Use sql_table for simple cases, sql for transformations.
- Every public member needs a title.
- Cube-level description: grain, source, analytical questions.
- Cube-level meta: grain, grain_description, time_dimension, time_zone, refresh_cadence.
- Derived metrics reference other metrics, never raw SQL.
- Counts come in pairs: total + filtered.
- Decompose avg as sum/count for pre-aggregation compatibility.
- Hide internal plumbing with public: false.
- Titles on every public member.
- Drill members on the primary count.
- 2-3 pre-aggregations per cube, hourly refresh, incremental, 7-day window.
- Partition by month, index by primary filters.
- ClickHouse: always define indexes in pre-aggregations.
- format: currency / percent where applicable.
- Segments encode analyst intent, not technical filters.
`;
  }
  return _principlesCache;
}

// -- System prompt -----------------------------------------------------------

function buildSystemPrompt() {
  const principles = loadPrinciples();
  return `You are a Cube.js data modeling expert. Your job is to polish an auto-generated Cube.js model to conform to the modeling principles below.

## Your Task

1. Review the generated model against the principles
2. Fix issues: add missing titles, descriptions, meta blocks, segments, pre-aggregations
3. Improve field names if they don't match analyst expectations
4. Add derived metrics (rates, ratios, counts in pairs) where the data supports them
5. Add pre-aggregations matching likely dashboard query patterns
6. Set public: false on internal plumbing fields
7. Add drill_members to the primary count measure
8. Ensure the primary key is correct and encodes the grain
9. Add format: currency/percent where appropriate
10. Return the complete polished model + a validation report

## CRITICAL RULES
- Preserve ALL existing dimensions and measures — do not remove any
- You may rename fields, add descriptions/titles, change types, add new fields
- SQL must use {CUBE}.column syntax for column references
- SQL must use {measure_name} syntax for referencing other measures
- Never put aggregation functions (SUM, COUNT, etc.) in the sql field — use the type property
- Wrap complex SQL in SELECT * FROM (...)
- partition must be the first dimension
- Every public member must have a title

## Cube Modeling Principles

${principles}

Return your response as structured JSON matching the schema.`;
}

// -- Main function -----------------------------------------------------------

/**
 * Polish a generated Cube.js model using an LLM.
 *
 * @param {string} generatedCode - The JS model code from yamlGenerator
 * @param {object} profileSummary - { table, schema, row_count, columns: [{name, type, description}] }
 * @param {object[]} cubes - Parsed cube definitions
 * @param {object} [options]
 * @returns {Promise<{ polishedCubes: object[]|null, report: object|null, status: string, error: string|null }>}
 */
export async function polishModel(generatedCode, profileSummary, cubes, options = {}) {
  const { timeout = TIMEOUT_MS } = options;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { polishedCubes: null, report: null, status: 'skipped', error: 'No OPENAI_API_KEY configured' };
  }

  const client = new OpenAI({ apiKey, timeout });

  const userMessage = `## Generated Model

\`\`\`javascript
${generatedCode}
\`\`\`

## Table Profile

- Table: ${profileSummary.schema}.${profileSummary.table}
- Row count: ${profileSummary.row_count?.toLocaleString() || 'unknown'}
- Columns: ${profileSummary.columns?.length || 'unknown'}

### Column Summary
${(profileSummary.columns || []).slice(0, 100).map(
  (c) => `- ${c.name}: ${c.type}${c.description ? ` — ${c.description}` : ''}`
).join('\n')}

## Current Cube Structure

${cubes.map((c) => `### ${c.name}
- Dimensions: ${c.dimensions?.length || 0}
- Measures: ${c.measures?.length || 0}
- SQL: ${c.sql ? 'custom' : c.sql_table ? 'sql_table' : 'none'}
`).join('\n')}

Polish this model according to the principles. Preserve all existing fields but improve them with titles, descriptions, proper types, and meta. Add derived metrics, segments, and pre-aggregations as appropriate.`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.beta.chat.completions.parse({
        model: MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: userMessage },
        ],
        response_format: zodResponseFormat(PolishResponseSchema, 'polished_model'),
        temperature: 0.3,
      });

      const parsed = response.choices[0]?.message?.parsed;
      if (!parsed) {
        if (attempt < MAX_RETRIES) continue;
        return { polishedCubes: null, report: null, status: 'failed', error: 'No parsed response from LLM' };
      }

      return {
        polishedCubes: parsed.cubes,
        report: parsed.validation_report,
        status: 'success',
        error: null,
      };
    } catch (err) {
      if (attempt < MAX_RETRIES) continue;
      console.error('[modelPolisher] LLM call failed:', err.message);
      return {
        polishedCubes: null,
        report: null,
        status: 'failed',
        error: err.message || 'LLM polishing failed',
      };
    }
  }

  return { polishedCubes: null, report: null, status: 'failed', error: 'Max retries exceeded' };
}
```

- [ ] **Step 2: Commit**

```bash
git add services/cubejs/src/utils/smart-generation/modelPolisher.js
git commit -m "feat: add modelPolisher LLM module for cube-principles compliance"
```

---

### Task 5: Integrate `modelPolisher` into the smart-generate pipeline

Insert the polishing step after AI enrichment and before merge/validation. The polished model replaces the generated one.

**Files:**
- Modify: `services/cubejs/src/routes/smartGenerate.js`

- [ ] **Step 1: Import `polishModel`**

At the top of `smartGenerate.js`, add:

```javascript
import { polishModel } from '../utils/smart-generation/modelPolisher.js';
```

- [ ] **Step 2: Insert the polish step after AI enrichment**

After the AI enrichment block (around line 340, after `mergeAIMetrics` is called) and before the `generateJs` call (around line 350), insert:

```javascript
  // ── Stage: LLM Model Polishing ──────────────────────────────────────
  let polishResult = null;
  const generatedPrePolish = generateJs(cubeResult.cubes);

  const profileSummaryForPolish = {
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
    polishResult = await polishModel(generatedPrePolish, profileSummaryForPolish, cubeResult.cubes);

    if (polishResult.status === 'success' && polishResult.polishedCubes) {
      // Replace cube definitions with polished versions
      // Preserve the original cube names and SQL to avoid breaking references
      for (let i = 0; i < cubeResult.cubes.length && i < polishResult.polishedCubes.length; i++) {
        const original = cubeResult.cubes[i];
        const polished = polishResult.polishedCubes[i];

        // Preserve original SQL (polisher shouldn't change data access)
        polished.sql = original.sql;
        polished.sql_table = original.sql_table;

        // Merge polished fields back
        cubeResult.cubes[i] = {
          ...original,
          ...polished,
          sql: original.sql,
          sql_table: original.sql_table,
          meta: { ...original.meta, ...polished.meta },
        };
      }
    }
  } catch (err) {
    console.warn('[smartGenerate] Model polishing failed (non-fatal):', err.message);
    polishResult = { status: 'failed', error: err.message };
  }
```

- [ ] **Step 3: Include polish result in the response payload**

In the final return object (around line 500), add:

```javascript
    polish: polishResult ? {
      status: polishResult.status,
      report: polishResult.report || null,
      error: polishResult.error || null,
    } : null,
```

- [ ] **Step 4: Commit**

```bash
git add services/cubejs/src/routes/smartGenerate.js
git commit -m "feat: integrate modelPolisher into smart-generate pipeline"
```

---

### Task 6: Copy cube-principles.md into the Docker build context

The `modelPolisher` needs access to the principles file at runtime inside the Docker container.

**Files:**
- Modify: `services/cubejs/Dockerfile` (or docker-compose volume mount)

- [ ] **Step 1: Add a volume mount in `docker-compose.dev.yml`**

In the `cubejs` service definition, add a volume mount for the principles file:

```yaml
    volumes:
      - ./services/cubejs:/app
      - ../fraios/shared/principles:/app/shared/principles:ro
```

If the `../fraios` directory is not available in all environments, use the `CUBE_PRINCIPLES_PATH` env var to point to the file, and the module's fallback summary will be used when the file is missing.

- [ ] **Step 2: Add `CUBE_PRINCIPLES_PATH` env var in `.dev.env`**

```
CUBE_PRINCIPLES_PATH=/app/shared/principles/cube-principles.md
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.dev.yml .dev.env
git commit -m "feat: mount cube-principles.md for modelPolisher in dev environment"
```

---

### Task 7: Show polish report in the Change Preview UI

Display the LLM validation report (principles applied, issues fixed, warnings) in the Change Preview step.

**Files:**
- Modify: `client-v2/src/components/SmartGeneration/index.tsx`
- Modify: `services/hasura/metadata/actions.graphql` (add `polish` to SmartGenOutput)

- [ ] **Step 1: Add `polish` field to `SmartGenOutput` in actions.graphql**

In the SmartGenOutput type definition, add:

```graphql
    polish: jsonb
```

- [ ] **Step 2: Add `polish` to the mutation response in `datasources.gql`**

In the `smart_gen_dataschemas` mutation response fields, add:

```graphql
      polish
```

- [ ] **Step 3: Update `generated.ts` to include `polish` in the response type**

In the `SmartGenDataSchemasMutation` type, add `polish` as a nullable jsonb field.

- [ ] **Step 4: Render polish report in ChangePreviewPanel**

After the AI Metrics section in the Change Preview, add a polish report section:

```tsx
      {genData?.polish?.report && (
        <div className={styles.changeSection} style={{ marginTop: 12 }}>
          <div className={styles.changeSectionHeader}>
            <Text strong>Model Polish Report</Text>
            <Tag color={genData.polish.status === "success" ? "success" : "warning"}>
              {genData.polish.status}
            </Tag>
          </div>

          {genData.polish.report.issues_fixed?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>Issues fixed:</Text>
              <ul style={{ margin: "4px 0", paddingLeft: 20, fontSize: 12 }}>
                {genData.polish.report.issues_fixed.map((issue: string, i: number) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          {genData.polish.report.warnings?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>Warnings:</Text>
              <ul style={{ margin: "4px 0", paddingLeft: 20, fontSize: 12, color: "var(--color-warning, #faad14)" }}>
                {genData.polish.report.warnings.map((w: string, i: number) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {genData.polish.report.grain && (
            <div style={{ fontSize: 12 }}>
              <Text type="secondary">Grain: </Text>
              <Tag>{genData.polish.report.grain}</Tag>
              <Text type="secondary" style={{ marginLeft: 8 }}>Primary key: </Text>
              <Tag>{genData.polish.report.primary_key}</Tag>
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 5: Commit**

```bash
cd ../client-v2 && git add src/components/SmartGeneration/index.tsx src/graphql/gql/datasources.gql src/graphql/generated.ts
git commit -m "feat: display model polish report in change preview"
cd ../synmetrix && git add services/hasura/metadata/actions.graphql
git commit -m "feat: add polish field to SmartGenOutput"
```

---

### Task 8: Integration test — full flow with all three improvements

- [ ] **Step 1: Restart services**

```bash
docker compose -f docker-compose.dev.yml restart actions cubejs hasura
docker exec -w /hasura synmetrix-hasura_cli-1 hasura-cli metadata apply --endpoint http://hasura:8080 --admin-secret devsecret
```

- [ ] **Step 2: Open Smart Generate for `cst.semantic_events`**

Navigate to the Models page, open Smart Generate, select `cst.semantic_events`.

- [ ] **Step 3: Verify step 1 shows nested group selector and filter builder**

After selecting the table:
- The compact group selector should appear below filters showing 24 groups
- Check `commerce` group
- Verify `commerce.products.entry_type` and `commerce.products.main_category` appear as suggested filter chips in the FilterBuilder
- Click the `entry_type` chip to add it as a filter
- Select "Line Item" as the IN value
- Add a regular filter: `event = 'Sales Report Submitted'`
- Verify cube name preview shows `semantic_events_line_items`

- [ ] **Step 4: Profile and verify preview step**

Click "Profile Table", wait for profiling to complete. Verify the column list shows properly.

- [ ] **Step 5: Preview Changes and verify ColumnList-style UI**

Click "Preview Changes". Verify:
- The change preview uses tabs (All / Added / Updated / Removed / Preserved)
- Fields have status dots (green for added)
- Search filter works across field names
- Click a field to see expanded details

- [ ] **Step 6: Verify polish report**

Below the field list, check for the "Model Polish Report" section showing:
- Principles applied
- Issues fixed (missing titles, descriptions, etc.)
- Identified grain and primary key
- Any warnings

- [ ] **Step 7: Apply and verify model saved**

Click "Apply Changes". Check the Models page shows the new `semantic_events_line_items.js` file with the polished model.

- [ ] **Step 8: Commit any fixes**

```bash
git add -A && git commit -m "fix: integration fixes for smart gen improvements"
```
