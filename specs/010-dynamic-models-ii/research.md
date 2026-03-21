# Research: Dynamic Models II

**Branch**: `010-dynamic-models-ii` | **Date**: 2026-03-15

## R1: OpenAI Node.js SDK Integration

**Decision**: Use `openai` npm package v6.x with structured output via `zodResponseFormat`

**Rationale**: The CubeJS service is Node.js (ES modules). The OpenAI Node.js SDK v6 provides:
- `client.chat.completions.parse()` with Zod schema validation
- `zodResponseFormat()` for guaranteed structured JSON output
- Built-in timeout and retry support
- The `gpt-5.4` model supports structured outputs natively

**Alternatives considered**:
- Raw `fetch()` to OpenAI API — rejected: loses structured output parsing, retry logic, error typing
- Python sidecar service — rejected: adds deployment complexity, violates Service Isolation principle

## R2: Structured Output Schema for Metric Generation

**Decision**: Define a Zod schema for the LLM response that enforces valid Cube.js field structures

**Rationale**: Using `zodResponseFormat` guarantees the LLM returns parseable JSON matching our expected structure. Each metric must include `name`, `sql`, `type`, `fieldType` (dimension/measure), and `meta` with `ai_generated: true`. This eliminates malformed responses as a failure mode.

**Schema shape**:
```
{
  metrics: [{
    name: string,
    sql: string,
    type: "number" | "string" | "time" | "count" | "sum" | "avg" | ...,
    fieldType: "dimension" | "measure",
    description: string,
    ai_generation_context: string
  }]
}
```

**Alternatives considered**:
- Free-form text parsing — rejected: fragile, requires complex regex/AST parsing
- Function calling / tool use — viable but structured output is simpler for this use case

## R3: Filter WHERE Clause Construction

**Decision**: Build parameterized WHERE clauses from structured filter conditions, AND-ed with existing partition filter

**Rationale**: The profiler already has `buildWhereClause()` for partition filtering. User filters extend this with additional AND conditions. Values must be escaped to prevent SQL injection.

**Escaping mechanism**: Follow the existing codebase pattern — the profiler's `buildWhereClause()` uses string interpolation with single-quote wrapping and manual escaping (single quotes doubled, backslashes escaped). The ClickHouse HTTP driver does not natively support parameterized queries in the way SQL databases do. The `filterBuilder.js` module will use the same escaping approach: string values wrapped in escaped single quotes (`'value'` → `'val''ue'` for values containing quotes), numeric values validated as numbers before interpolation, array values for `IN`/`NOT IN` individually escaped and joined. Column names are validated against the table schema whitelist (not user-supplied strings interpolated raw).

**Alternatives considered**:
- ClickHouse parameterized queries (`{param:Type}`) — ideal but requires driver support verification and changes the query construction pattern across all profiler passes
- Raw string interpolation — rejected: SQL injection risk

## R4: AI Metric Validation

**Decision**: Post-LLM validation layer that checks SQL expressions before inclusion in the model

**Validation checks**:
1. Balanced parentheses and backticks
2. Only allowed Cube.js template variables (`{CUBE}`, `{FILTER_PARAMS}`)
3. No dangerous SQL (DDL, DML keywords: DROP, DELETE, INSERT, ALTER, TRUNCATE)
4. Field name uniqueness (no collision with profiler-generated fields)
5. Valid Cube.js measure/dimension types per CubeValidator (measures: `number`, `string`, `boolean`, `time`, `count`, `sum`, `avg`, `min`, `max`, `countDistinct`, `countDistinctApprox`, `runningTotal`; dimensions: `string`, `number`, `time`, `boolean`)
6. Column reference validation: extract `{CUBE}.column_name` patterns from the SQL and verify each `column_name` exists in the profiled table's column list. This catches hallucinated column names without requiring the full schema compiler.
7. `source_columns` validation: verify each entry in `source_columns` is a raw ClickHouse column name from the profiled table (not a generated member name)

**Rationale**: Even with structured output, the `sql` field is free-text. Shallow checks (parentheses, keywords) are necessary but insufficient — hallucinated column names are the most common LLM failure mode for SQL generation. Column reference validation (check 6) catches this cheaply by comparing against the profiled table's column list, which is already in memory.

## R5: Superset Merge Strategy for AI Metrics

**Decision**: Extend the existing merger to handle `ai_generated` fields as a distinct category alongside `auto_generated` and user-created fields

**Merge rules**:
- `ai_generated` fields from the previous model are extracted and sent to the LLM as "retain these"
- LLM output is validated: every previously existing AI metric must appear (superset check)
- If the LLM drops a valid metric, it's force-retained from the previous model
- If a metric's source column no longer exists, it's removed and surfaced in the diff
- User edits to AI metric descriptions are preserved (description treated as user content)

**Rationale**: The existing merger already distinguishes auto-generated vs user fields via `meta.auto_generated`. Adding `meta.ai_generated` as a third category follows the same pattern.

## R6: Frontend Filter Builder Component

**Decision**: Adopt the `react-querybuilder` (logic only, custom Ant Design control elements) pattern from the cxs2 blueprint project

**Pattern**: The cxs2 project (`/Users/stefanbaxter/Development/cxs2`) has a mature, metadata-driven filter builder used in dashboards and the semantic layer explore page. Key reusable patterns:

- **Library**: `react-querybuilder` with custom Ant Design control elements — provides rule management and extensibility. Configured for **flat AND-only mode** (no combinators, no nested groups) in v1 via `combinators={[{name: 'and', label: 'AND'}]}` and `maxGroupDepth={0}`. This matches the backend's flat filter array contract.
- **Operator derivation**: `cubeOperators.ts` maps field `dataType` (string/number/time/boolean/geo) → available operators. Same type system applies to ClickHouse column types
- **Metadata → Fields**: `cubeMetaToFields.ts` converts Cube metadata to react-querybuilder `Field[]` objects. We adapt this to convert ClickHouse table schema (from `/api/v1/get-schema`) to the same `Field[]` format
- **Value editors**: Type-aware — `Switch` for boolean, `DatePicker` for time, `InputNumber` for numeric, async `Select` with infinite scroll for string. For our profiling context, we use free-text input initially (we don't have a Cube meta endpoint for raw tables yet)
- **Custom components**: `FilterRow`, `FilterFieldPicker`, `FilterOperatorBadge`, `CubeValueEditor` — we can reference these but build simplified versions since our context is pre-profiling (fewer fields, no cube relationships)
- **Conversion**: `cubeRuleProcessor.ts` converts react-querybuilder `RuleGroupType` → Cube.dev filter format. We add a parallel converter to our `FilterCondition[]` format for the profiler WHERE clause

**Integration point**: Filter builder appears in the SmartGeneration component's "Select" step, after table selection and before "Profile Table" button. Column dropdown populated from table schema already fetched via `/api/v1/get-schema`.

**Alternatives considered**:
- Custom filter builder from scratch — rejected: cxs2 already solved this well with react-querybuilder; adopt the blueprint pattern per constitution
- Raw SQL WHERE input — rejected: SQL injection risk, poor UX, error-prone
- Reuse cxs2 components directly via shared package — rejected: premature; client-v2 and cxs2 have different build setups. Reference the pattern, build compatible components in client-v2

## R7: AI Metrics Display in Model Editor

**Decision**: Extend the CodeEditor component to visually distinguish AI-generated fields

**Approach**:
- Monaco decorations for lines containing `ai_generated: true` — subtle background tint or gutter icon
- Hover provider extension: when hovering over an AI metric field, show the `ai_generation_context` from meta
- No separate UI panel — the meta is inline in the model code, visible in the editor

**Alternatives considered**:
- Separate "AI Metrics" sidebar panel — rejected: over-engineering, meta is already in the code
- Color-coded field names — rejected: Monaco doesn't support per-token coloring without custom language grammar

## R8: Filter Value Lookup via Cube.js Load API

**Decision**: Use the Cube.js REST API (`POST /api/v1/load`) for real-time value lookups in the filter builder, with `contains` filter for server-side partial matching as the user types.

**Rationale**: The Cube.js load API is the proper abstraction layer for querying data. It handles driver selection, caching (pre-aggregations), access control, and multi-tenancy. For tables that already have a generated Cube.js model (the reprofile case), we can query dimension values directly. The `contains` operator maps to case-insensitive `ILIKE '%term%'` in ClickHouse, providing natural partial matching.

**Query pattern**:
- Initial load (no search term): `{ dimensions: ["cube.dim"], limit: 200, order: { "cube.dim": "asc" } }`
- With search term: adds `filters: [{ member: "cube.dim", operator: "contains", values: ["term"] }]`
- Debounced at 300ms to avoid excessive API calls

**Fallback**: When no cube exists (first-time generation), the value input shows free-text entry. The `contains` query failure (e.g., dimension doesn't exist in the model) silently falls back to free-text.

**Alternatives considered**:
- Raw `SELECT DISTINCT` via ClickHouse driver — rejected: bypasses Cube.js abstraction layer, loses caching/access control
- Client-side filtering of pre-fetched values — rejected: doesn't scale for high-cardinality columns
- Profiler `lcValues` — only available after profiling completes, but filter builder is shown before profiling

## R9: OpenAI API Key Management

**Decision**: Environment variable `OPENAI_API_KEY` on the CubeJS service container

**Rationale**: Consistent with existing secret management (`JWT_KEY`, `CUBEJS_SECRET`). Secrets are managed in the fraios infra repo via Kubernetes secrets. For local dev, added to `.dev.env`. The key is never exposed to the frontend or logged.

**Alternatives considered**:
- Per-team database setting — rejected: premature, adds complexity, single org deployment for now
- WorkOS Vault — rejected: not yet adopted in CubeJS service
