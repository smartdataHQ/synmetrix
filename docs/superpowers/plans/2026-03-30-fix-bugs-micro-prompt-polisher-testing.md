# Fix Bugs + Micro-Prompt Polisher + Full Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the remaining Apply path bugs, rewrite the monolithic LLM polisher as focused micro-prompts that guide the builder, and run proper end-to-end testing — generate a model, validate it with the Cube.js compiler, query it via the Explore page.

**Architecture:** The polisher is replaced by a `modelAdvisor` that sends 4-5 focused micro-prompts to the LLM, each with the full model as context but asking ONE specific question with a small structured output. The builder applies each response incrementally. Validation runs once at the end via `validateModelSyntax` + `smokeTestQuery`. Bug fixes include increasing the Hasura action timeout and adding debug logging to trace the nested filter alias mismatch.

**Tech Stack:** JavaScript (ES modules, Node.js 22), OpenAI API (gpt-5.4, structured output via Zod), Cube.js compiler (validation), ClickHouse

**Principles:** `services/cubejs/principles/cube-principles.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `services/hasura/metadata/actions.yaml:107` | Increase timeout to 300s |
| Modify | `services/actions/src/rpc/smartGenSchemas.js` | Add debug logging for nestedFilters |
| Create | `services/cubejs/src/utils/smart-generation/modelAdvisor.js` | Micro-prompt LLM advisor (replaces modelPolisher) |
| Modify | `services/cubejs/src/routes/smartGenerate.js` | Replace polishModel with advisorPasses, fix timeout |
| Delete | `services/cubejs/src/utils/smart-generation/modelPolisher.js` | Replaced by modelAdvisor |

---

### Task 1: Fix Hasura timeout + debug nested filter flow

**Files:**
- Modify: `services/hasura/metadata/actions.yaml:107`
- Modify: `services/actions/src/rpc/smartGenSchemas.js`

- [ ] **Step 1: Increase Hasura action timeout**

In `services/hasura/metadata/actions.yaml`, find the `smart_gen_dataschemas` action (line 102). Change timeout from 180 to 300:

```yaml
      timeout: 300
```

- [ ] **Step 2: Add debug logging in RPC handler**

In `services/actions/src/rpc/smartGenSchemas.js`, after the destructuring (line 22), add:

```javascript
  if (nestedFilters) {
    console.log('[smartGenSchemas] nested_filters received:', JSON.stringify(nestedFilters));
  }
```

- [ ] **Step 3: Apply Hasura metadata**

```bash
docker exec -w /hasura synmetrix-hasura_cli-1 hasura-cli metadata apply --endpoint http://hasura:8080 --admin-secret devsecret
```

- [ ] **Step 4: Commit**

```bash
git add services/hasura/metadata/actions.yaml services/actions/src/rpc/smartGenSchemas.js
git commit -m "fix: increase smart_gen_dataschemas timeout to 300s, add nested filter debug logging"
```

---

### Task 2: Create the micro-prompt modelAdvisor

Replace the monolithic `modelPolisher.js` with a `modelAdvisor.js` that sends focused micro-prompts. Each prompt sends the full model as context but asks ONE question with a small Zod-validated structured output.

**Files:**
- Create: `services/cubejs/src/utils/smart-generation/modelAdvisor.js`

- [ ] **Step 1: Create modelAdvisor.js**

The advisor runs 4 focused passes:

**Pass 1 — Descriptions & Titles:** "Review these fields. For any that are missing a description or have a poor title, provide corrections."
- Input: full model + column descriptions from profiler
- Output: `[{ name, title?, description? }]` — only fields that need changes

**Pass 2 — Segments:** "What meaningful analyst-facing segments should this cube have?"
- Input: full model + LC values from profiler
- Output: `[{ name, sql, title, description }]` — 0-5 segments

**Pass 3 — Derived Metrics:** "What calculated metrics (rates, ratios, decomposed averages) would support analysis?"
- Input: full model + existing measures
- Output: `[{ name, sql, type, title, description, referencedMeasures }]` — 0-10 metrics

**Pass 4 — Pre-aggregation Review:** "Review the pre-aggregations. Are they appropriate for this data? What changes would you make?"
- Input: full model + pre-aggregations
- Output: `{ keep: string[], remove: string[], add: [{ name, type, dimensions, measures, time_dimension, granularity }] }`

Each pass gets a concise best-practices summary (NOT the full principles doc — a 20-line extract of the relevant principle section).

```javascript
// services/cubejs/src/utils/smart-generation/modelAdvisor.js

/**
 * Model advisor — sends focused micro-prompts to the LLM to refine
 * a generated Cube.js model. Each prompt asks ONE question with a
 * small structured output. The full model stays in context for every call.
 *
 * Never throws — all errors caught and returned as status.
 */

import fs from 'fs';
import { validateModelSyntax } from './modelValidator.js';
import { generateJs } from './yamlGenerator.js';

const MODEL = 'gpt-5.4';
const PASS_TIMEOUT = 45_000; // 45s per micro-prompt (plenty for small output)

// -- Principles excerpts (concise, relevant per pass) -------------------------

const PRINCIPLES_DESCRIPTIONS = [
  'Every public dimension and measure must have a title that makes sense to a non-technical consumer or AI agent.',
  'Cube-level description: one paragraph covering grain, source, and what analytical questions it supports.',
  'Descriptions on non-obvious measures: if behavior is subtle (median bypassing pre-aggs, rate biased toward longer events), say so.',
  'Section comments group related fields. Readers scan headings before fields.',
].join('\n');

const PRINCIPLES_SEGMENTS = [
  'Segments encode analyst intent. Name for what the analyst wants to see (exclude_returns, confirmed_only), not the technical filter.',
  'Segments and filtered measures are complementary. Use segments when filter logic is complex or encodes reusable business intent.',
  'Each segment should trace to a question the user actually asks.',
].join('\n');

const PRINCIPLES_METRICS = [
  'Counts come in pairs: total + filtered. This enables rate calculations without consumer-side filters.',
  'Derived metrics reference other metrics, never raw SQL. Use {measure_name} syntax.',
  'Decompose avg as {sum_field} / {count_field} using type: number for pre-aggregation compatibility.',
  'Research industry KPIs before designing. Prioritize standard metrics computable from the grain.',
  'format: currency for revenue/price/cost measures. format: percent for rate/ratio measures (store raw decimal, not x100).',
].join('\n');

const PRINCIPLES_PREAGGS = [
  '2-3 rollups per cube at different aggregation levels. Match to dashboard query patterns.',
  'Include only the measures dashboards actually query. Don\'t dump all measures into every rollup.',
  'Standardized refresh: every: 1 hour, incremental: true, update_window: 7 days.',
  'Partition by month, index by primary filters. ClickHouse: always define indexes.',
  'build_range_start from min(timestamp), build_range_end from SELECT NOW().',
].join('\n');

// -- Shared context builder ---------------------------------------------------

function buildModelContext(generatedCode, profileSummary, cubes) {
  let ctx = '## Current Model\n\n```javascript\n' + generatedCode + '\n```\n\n';
  ctx += '## Table: ' + profileSummary.schema + '.' + profileSummary.table + '\n';
  ctx += '- Row count: ' + (profileSummary.row_count?.toLocaleString() || 'unknown') + '\n';
  ctx += '- Cubes: ' + cubes.length + '\n';
  for (const c of cubes) {
    ctx += '- ' + c.name + ': ' + (c.dimensions?.length || 0) + ' dimensions, ' + (c.measures?.length || 0) + ' measures\n';
  }
  return ctx;
}

// -- Individual passes --------------------------------------------------------

async function runPass(client, zodResponseFormat, z, modelContext, passName, principles, question, schema, timeout) {
  const systemPrompt = [
    'You are a Cube.js data modeling advisor. You review auto-generated models and suggest improvements.',
    'You have deep expertise in Cube.js, ClickHouse, and semantic layer best practices.',
    '',
    '## Relevant Principles',
    '',
    principles,
    '',
    '## Rules',
    '- SQL uses {CUBE}.column for column references, {measure_name} for measure references',
    '- Never put aggregation functions in sql — use the type property',
    '- Return ONLY what needs changing. Empty arrays are fine if no changes needed.',
  ].join('\n');

  try {
    const completion = await client.chat.completions.parse(
      {
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: modelContext + '\n\n## Question\n\n' + question },
        ],
        response_format: zodResponseFormat(schema, passName),
        temperature: 0.3,
      },
      { signal: AbortSignal.timeout(timeout) }
    );

    return completion.choices[0]?.message?.parsed || null;
  } catch (err) {
    console.warn('[modelAdvisor] Pass "' + passName + '" failed: ' + err.message);
    return null;
  }
}

// -- Main export --------------------------------------------------------------

/**
 * Run focused advisory passes on a generated model.
 *
 * @param {string} generatedCode - JS model code
 * @param {object} profileSummary - { table, schema, row_count, columns }
 * @param {object[]} cubes - Parsed cube definitions
 * @param {object} [options]
 * @returns {Promise<{ passes: object[], status: string, error: string|null }>}
 */
export async function adviseModel(generatedCode, profileSummary, cubes, options = {}) {
  const timeout = options.timeout ?? PASS_TIMEOUT;

  if (!process.env.OPENAI_API_KEY) {
    return { passes: [], status: 'skipped', error: 'No OPENAI_API_KEY configured' };
  }

  const { default: OpenAI } = await import('openai');
  const { zodResponseFormat } = await import('openai/helpers/zod');
  const { z } = await import('zod');

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const modelContext = buildModelContext(generatedCode, profileSummary, cubes);
  const passes = [];

  // -- Pass 1: Descriptions & Titles --
  const DescSchema = z.object({
    corrections: z.array(z.object({
      name: z.string().describe('Field name to correct'),
      title: z.string().nullable().describe('Corrected title, or null if OK'),
      description: z.string().nullable().describe('Description to add, or null if OK'),
    })),
    cube_description: z.string().nullable().describe('Improved cube description, or null if OK'),
  });

  const descResult = await runPass(client, zodResponseFormat, z, modelContext,
    'descriptions', PRINCIPLES_DESCRIPTIONS,
    'Review all dimensions and measures. For any with a poor title or missing description, provide corrections. Focus on titles that would confuse a non-technical analyst.',
    DescSchema, timeout);
  if (descResult) passes.push({ pass: 'descriptions', result: descResult });

  // -- Pass 2: Segments --
  const SegSchema = z.object({
    segments: z.array(z.object({
      name: z.string(),
      sql: z.string().describe('SQL filter expression using {CUBE}.column syntax'),
      title: z.string(),
      description: z.string(),
    })),
  });

  const segResult = await runPass(client, zodResponseFormat, z, modelContext,
    'segments', PRINCIPLES_SEGMENTS,
    'What meaningful analyst-facing segments should this cube have? Consider common filter patterns analysts would reuse. Return 0-5 segments.',
    SegSchema, timeout);
  if (segResult) passes.push({ pass: 'segments', result: segResult });

  // -- Pass 3: Derived Metrics --
  const MetricsSchema = z.object({
    metrics: z.array(z.object({
      name: z.string(),
      sql: z.string(),
      type: z.enum(['number', 'count', 'sum', 'avg', 'min', 'max', 'count_distinct', 'count_distinct_approx']),
      title: z.string(),
      description: z.string(),
      format: z.enum(['currency', 'percent']).nullable(),
    })),
  });

  const metricsResult = await runPass(client, zodResponseFormat, z, modelContext,
    'derived_metrics', PRINCIPLES_METRICS,
    'What calculated metrics (rates, ratios, decomposed averages) would support analysis of this data? Reference existing measures using {measure_name} syntax. Return 0-10 metrics.',
    MetricsSchema, timeout);
  if (metricsResult) passes.push({ pass: 'derived_metrics', result: metricsResult });

  // -- Pass 4: Pre-aggregation Review --
  const PreAggSchema = z.object({
    assessment: z.string().describe('Brief assessment of current pre-aggregations'),
    replacements: z.array(z.object({
      name: z.string(),
      type: z.enum(['rollup', 'original_sql']),
      dimensions: z.array(z.string()),
      measures: z.array(z.string()),
      time_dimension: z.string().nullable(),
      granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).nullable(),
      partition_granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).nullable(),
    })).describe('Complete set of recommended pre-aggregations (replaces existing)'),
  });

  const preAggResult = await runPass(client, zodResponseFormat, z, modelContext,
    'pre_aggregations', PRINCIPLES_PREAGGS,
    'Review the pre-aggregations. Are they appropriate for this data and likely dashboard patterns? Return the complete recommended set (it replaces existing pre-aggs).',
    PreAggSchema, timeout);
  if (preAggResult) passes.push({ pass: 'pre_aggregations', result: preAggResult });

  return {
    passes,
    status: passes.length > 0 ? 'success' : 'failed',
    error: passes.length === 0 ? 'All advisory passes failed' : null,
  };
}

/**
 * Apply advisory pass results to cube definitions.
 *
 * @param {object[]} cubes - Mutable cube definitions
 * @param {object[]} passes - Results from adviseModel
 */
export function applyAdvisoryPasses(cubes, passes) {
  for (const { pass, result } of passes) {
    if (pass === 'descriptions' && result) {
      // Apply title/description corrections
      for (const correction of result.corrections || []) {
        for (const cube of cubes) {
          const field = [...(cube.dimensions || []), ...(cube.measures || [])]
            .find((f) => f.name === correction.name);
          if (field) {
            if (correction.title) field.title = correction.title;
            if (correction.description) field.description = correction.description;
          }
        }
      }
      if (result.cube_description && cubes[0]) {
        cubes[0].description = result.cube_description;
      }
    }

    if (pass === 'segments' && result) {
      for (const cube of cubes) {
        if (!cube.segments) cube.segments = [];
        for (const seg of result.segments || []) {
          if (!cube.segments.some((s) => s.name === seg.name)) {
            cube.segments.push({
              ...seg,
              meta: { auto_generated: true, ai_generated: true },
            });
          }
        }
      }
    }

    if (pass === 'derived_metrics' && result) {
      for (const cube of cubes) {
        for (const metric of result.metrics || []) {
          if (cube.measures.some((m) => m.name === metric.name)) continue;
          cube.measures.push({
            ...metric,
            meta: { auto_generated: true, ai_generated: true },
          });
        }
      }
    }

    if (pass === 'pre_aggregations' && result) {
      for (const cube of cubes) {
        if (result.replacements && result.replacements.length > 0) {
          cube.pre_aggregations = result.replacements.map((pa) => ({
            ...pa,
            refresh_key: { every: '1 hour' },
            indexes: pa.dimensions?.length > 0
              ? [{ name: pa.name + '_idx', columns: pa.dimensions.slice(0, 3) }]
              : [],
          }));
        }
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add services/cubejs/src/utils/smart-generation/modelAdvisor.js
git commit -m "feat: add micro-prompt modelAdvisor replacing monolithic polisher"
```

---

### Task 3: Integrate modelAdvisor into smartGenerate pipeline

**Files:**
- Modify: `services/cubejs/src/routes/smartGenerate.js`

- [ ] **Step 1: Replace polishModel import with adviseModel**

Change the import from:
```javascript
import { polishModel } from '../utils/smart-generation/modelPolisher.js';
```
To:
```javascript
import { adviseModel, applyAdvisoryPasses } from '../utils/smart-generation/modelAdvisor.js';
```

- [ ] **Step 2: Replace the polish stage with advisory passes**

Find the `// ── Stage: LLM Model Polishing` block and replace it entirely with:

```javascript
    // ── Stage: LLM Model Advisory Passes (only on Apply) ────────────────
    let advisorResult = null;
    if (!dryRun) {
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
```

- [ ] **Step 3: Update the response payload**

Replace `polish` with `advisor` in all three response paths (dry-run, no-changes, apply):

```javascript
    advisor: advisorResult ? {
      status: advisorResult.status,
      passes: advisorResult.passes?.map((p) => ({ pass: p.pass, fields: Object.keys(p.result || {}) })) || [],
      error: advisorResult.error || null,
    } : null,
```

- [ ] **Step 4: Remove debug logging from smartGenerate**

Remove the `console.log('[smartGenerate] nestedFilters:', ...)` line added earlier.

- [ ] **Step 5: Commit**

```bash
git add services/cubejs/src/routes/smartGenerate.js
git commit -m "feat: replace monolithic polisher with micro-prompt advisor in smartGenerate pipeline"
```

---

### Task 4: Update frontend to show advisor results instead of polish report

**Files:**
- Modify: `../client-v2/src/components/SmartGeneration/index.tsx`

- [ ] **Step 1: Replace polish report section with advisor report**

Find the `{genData?.polish?.report && (` block in the `change_preview` step. Replace with:

```tsx
          {genData?.advisor?.passes?.length > 0 && (
            <div style={{ marginTop: 12, marginBottom: 12 }}>
              <Title level={5} style={{ fontSize: 14 }}>
                LLM Advisory Passes
              </Title>
              <div
                style={{
                  border: "1px solid var(--color-border, #d9d9d9)",
                  borderRadius: 6,
                  padding: "8px 12px",
                  fontSize: 12,
                }}
              >
                <Space size={4} wrap>
                  {genData.advisor.passes.map((p: any, i: number) => (
                    <Tag key={i} color="blue">
                      {p.pass}
                    </Tag>
                  ))}
                </Space>
              </div>
            </div>
          )}

          {genData?.advisor?.status === "failed" && genData?.advisor?.error && (
            <Alert
              style={{ marginBottom: 12 }}
              message="LLM advisory failed"
              description={genData.advisor.error}
              type="warning"
              showIcon
            />
          )}
```

Also update the `polish` references in the `generated.ts` response type to `advisor` (or leave as `any` since it's already `any`).

- [ ] **Step 2: Commit**

```bash
cd ../client-v2 && git add src/components/SmartGeneration/index.tsx
git commit -m "feat: show advisor pass results instead of polish report"
```

---

### Task 5: Delete old modelPolisher.js

**Files:**
- Delete: `services/cubejs/src/utils/smart-generation/modelPolisher.js`

- [ ] **Step 1: Delete the file**

```bash
rm services/cubejs/src/utils/smart-generation/modelPolisher.js
```

- [ ] **Step 2: Verify no remaining imports**

```bash
grep -r "modelPolisher" services/cubejs/src/
```

Expected: no results. If any found, update to use `modelAdvisor.js`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: remove old monolithic modelPolisher, replaced by modelAdvisor"
```

---

### Task 6: End-to-end test — generate, validate, query

This is the REAL test. Not "the UI rendered" but "the model works."

**Files:** No new files — testing only.

- [ ] **Step 1: Restart all services**

```bash
docker compose -f docker-compose.dev.yml restart actions cubejs
docker exec -w /hasura synmetrix-hasura_cli-1 hasura-cli metadata apply --endpoint http://hasura:8080 --admin-secret devsecret
```

Wait 10 seconds for services to be ready.

- [ ] **Step 2: Delete existing model to start fresh**

In the Synmetrix UI, go to the Models page, find `semantic_events_commerce.js`, delete it via the UI (or delete the version in the database).

- [ ] **Step 3: Run the full Smart Generate flow**

1. Open Smart Generate for `cst.semantic_events`
2. Check `commerce` group
3. Add `commerce.products.entry_type IN [Line Item]` filter
4. Click Profile Table — wait for completion
5. Verify: 4,377,428 rows, 82+ active columns
6. Click Preview Changes — verify fields with titles, format, paired counts visible
7. Click Apply Changes — wait for completion (up to 5 minutes with advisor passes)

- [ ] **Step 4: Check cubejs logs for advisor pass results**

```bash
docker compose -f docker-compose.dev.yml logs cubejs --tail 50 | grep -i "advisor\|advise\|pass.*fail\|pass.*success\|validation"
```

Expected: 4 passes logged (descriptions, segments, derived_metrics, pre_aggregations). Some may succeed, some may fail — that's OK. At least one should succeed.

- [ ] **Step 5: Examine the saved model file**

After Apply completes, the model is saved to the database. Find it:

```bash
docker exec synmetrix-postgres psql -U synmetrix -d synmetrix -c "
SELECT d.name, d.code
FROM dataschemas d
JOIN versions v ON d.version_id = v.id
JOIN branches b ON v.branch_id = b.id
WHERE b.id = '7599f190-fb33-4a17-9207-4a35f3d0359d'
AND d.name = 'semantic_events_commerce.js'
ORDER BY v.created_at DESC
LIMIT 1;
" -t
```

Save the code to a file and inspect it for:
- Cube-level `title` and `description`
- `meta.grain` and `meta.time_dimension`
- Dimensions with `title` properties
- Measures with `title` and `format` (currency/percent)
- `drill_members` on the count measure
- `public: false` on plumbing fields (GIDs, write_key)
- Paired filtered counts
- Pre-aggregations with indexes
- Segments (if advisor succeeded)

- [ ] **Step 6: Validate model syntax with Cube.js compiler**

```bash
docker exec synmetrix-cubejs-1 node -e "
import { validateModelSyntax } from './src/utils/smart-generation/modelValidator.js';
import { readFileSync } from 'fs';

// Read the saved model from the database output file
const code = \`<paste the model code here>\`;
const result = await validateModelSyntax(code, 'semantic_events_commerce.js');
console.log('Valid:', result.valid);
if (result.errors.length > 0) {
  console.log('Errors:', result.errors);
}
"
```

Expected: `Valid: true`. If errors, log them and fix.

- [ ] **Step 7: Query the model via the Explore page**

Navigate to the Explore page in the browser. Select the `semantic_events_commerce` cube (or `semantic_events_line_items`). Add the `count` measure. Run the query. Verify it returns data (not an error).

- [ ] **Step 8: Verify pre-aggregation compatibility**

In the Explore page, check the "Generated SQL" tab. It should show the SQL that Cube.js generates. Verify it references the correct table and ARRAY JOIN clause.

- [ ] **Step 9: Commit any fixes discovered during testing**

```bash
git add -A && git commit -m "fix: integration fixes from end-to-end testing"
```
