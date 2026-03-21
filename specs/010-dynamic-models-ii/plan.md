# Implementation Plan: Dynamic Models II

**Branch**: `010-dynamic-models-ii` | **Date**: 2026-03-15 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/010-dynamic-models-ii/spec.md`

## Summary

Extend the smart model generation pipeline with two capabilities: (A) user-supplied data filters for introspection, so profiling reflects a relevant data subset rather than the entire table; (B) LLM-generated metrics using OpenAI `gpt-5.4` with structured output, producing intelligent calculated measures (averages, ratios, YoY comparisons) tagged with `ai_generated: true`. On regeneration, the LLM receives prior AI metrics and produces a superset. Frontend includes a filter builder in the smart generation dialog and AI metric visual indicators in the model editor.

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 22+
**Primary Dependencies**: Cube.js v1.6.x (CubeJS service), Express 4.18.2, `openai` npm v6.x (NEW), React 18 + Vite + Ant Design 5 (client-v2), URQL (GraphQL client), `react-querybuilder` (NEW in client-v2, logic only — custom Ant Design control elements, pattern from cxs2 blueprint)
**Storage**: PostgreSQL via Hasura (versions, dataschemas), ClickHouse (profiling target — read-only)
**Testing**: StepCI (integration), Vitest (frontend)
**Target Platform**: Docker containers (Linux amd64), browser (client-v2)
**Project Type**: Web service (monorepo) + frontend SPA
**Performance Goals**: Filtered profiling within same time envelope as unfiltered; LLM call adds ≤30s
**Constraints**: LLM failures must not block base model generation; partition filter always enforced as security boundary
**Scale/Scope**: Single OpenAI model (`gpt-5.4`), up to 10 filter conditions, full-stack changes across CubeJS, Actions, Hasura, client-v2

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Research Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Service Isolation | PASS | Changes span CubeJS (profiler, LLM), Actions (passthrough), Hasura (action schema), client-v2 (UI). Each independently deployable. Shared contract change: `smart_gen_dataschemas` action gains `filters` param (backward compatible — optional field). |
| II. Multi-Tenancy First | PASS | User filters AND-ed with partition filter — partition is a security boundary. `defineUserScope.js` and `buildSecurityContext.js` flow unchanged. |
| III. Test-Driven Development | PASS | New modules (filterBuilder, llmEnricher, llmValidator) will have unit tests. StepCI test for smart-generate with filters. Frontend components tested via Vitest. |
| IV. Security by Default | PASS | Filter values escaped/parameterized (FR-005). OpenAI API key in env var, never exposed. JWT auth unchanged. No new tables requiring RLS. |
| V. Simplicity / YAGNI | PASS | No new abstractions beyond what's needed. LLM integration is a single module. Filter builder follows existing Playground patterns. |

### Post-Design Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Service Isolation | PASS | `openai` dependency added only to CubeJS service. Actions RPC is passthrough only. Hasura action schema change is additive (optional `filters` field). |
| II. Multi-Tenancy First | PASS | Filter WHERE clause composed with partition via AND. No changes to security context, branch resolution, or cache isolation. |
| III. Test-Driven Development | PASS | Unit tests for filterBuilder, llmEnricher, llmValidator. Integration test for filtered smart-generate. |
| IV. Security by Default | PASS | SQL injection prevented via value escaping. LLM output validated before inclusion. API key management via env var. |
| V. Simplicity / YAGNI | PASS | One new dependency (`openai`). Three new utility modules. No new database tables. No new services. |

## Project Structure

### Documentation (this feature)

```text
specs/010-dynamic-models-ii/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: technology decisions
├── data-model.md        # Phase 1: entity definitions
├── quickstart.md        # Phase 1: setup and verification
├── contracts/           # Phase 1: API contracts
│   └── api-contracts.md
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
services/cubejs/
├── src/
│   ├── routes/
│   │   ├── smartGenerate.js        # MODIFY: accept filters, call LLM enricher
│   │   └── profileTable.js         # MODIFY: accept and apply filters
│   └── utils/
│       └── smart-generation/
│           ├── profiler.js          # MODIFY: accept filters, extend WHERE
│           ├── filterBuilder.js     # NEW: build parameterized WHERE from conditions
│           ├── llmEnricher.js       # NEW: OpenAI integration, prompt, parsing
│           ├── llmValidator.js      # NEW: validate LLM SQL output
│           ├── cubeBuilder.js       # MODIFY: integrate AI metrics
│           ├── merger.js            # MODIFY: ai_generated field handling
│           └── diffModels.js        # MODIFY: AI metric diff sections

services/actions/
└── src/rpc/
    └── smartGenSchemas.js           # MODIFY: pass filters through

services/hasura/metadata/
├── actions.graphql                  # MODIFY: add FilterConditionInput
└── actions.yaml                     # MODIFY: update action definition

../client-v2/
└── src/
    ├── components/
    │   ├── SmartGeneration/
    │   │   ├── index.tsx            # MODIFY: add filter builder to Select step
    │   │   └── FilterBuilder.tsx    # NEW: react-querybuilder based (cxs2 pattern)
    │   └── CodeEditor/
    │       └── index.tsx            # MODIFY: AI metric decorations
    └── graphql/
        └── gql/
            └── datasources.gql     # MODIFY: add filters param
```

**Structure Decision**: This is an existing monorepo. Changes follow established patterns — new utility modules in `smart-generation/`, new React component in `SmartGeneration/`, modified Hasura action schema. No new services or projects.

## Filter Value Lookup via Cube.js Load API

**Decision**: When a table has an existing Cube.js model (reprofile case), the filter builder's value inputs for `=`, `!=`, `IN`, `NOT IN` operators query real dimension values via the Cube.js REST API (`POST /api/v1/load`). As the user types, a debounced `contains` filter provides server-side partial matching.

**Query format**: Standard Cube.js load query with a `contains` filter on the selected dimension:
```json
{
  "query": {
    "dimensions": ["cube_name.dimension_name"],
    "filters": [{ "member": "cube_name.dimension_name", "operator": "contains", "values": ["search_term"] }],
    "limit": 200,
    "order": { "cube_name.dimension_name": "asc" }
  }
}
```

**Fallback**: When no cube exists (first-time generation), the value input falls back to free-text entry. When the Cube.js query fails (e.g., dimension not found), the component silently falls back to free-text.

**Why Cube.js load API (not raw SQL)**: The Cube.js load API is the proper abstraction layer — it handles driver selection, caching, access control, and multi-tenancy. Raw SQL queries bypass all of these.

## Complexity Tracking

| Decision | Adds Complexity? | Rejected Simpler Alternative | Justification |
|----------|-----------------|------------------------------|---------------|
| `openai` npm v6.x SDK | Yes — new dependency | Raw `fetch()` to OpenAI API | SDK provides structured output parsing via `zodResponseFormat`, built-in retry/timeout, typed errors. Raw fetch would require reimplementing all of this. See research R1. |
| `react-querybuilder` library | Yes — new dependency | Custom filter builder from scratch | cxs2 blueprint already solved this pattern with react-querybuilder + custom Ant Design controls. Adopting the blueprint pattern per constitution Migration Strategy. Building from scratch would duplicate solved UX problems. See research R6. |
| Three-category field merge (`auto_generated`, `ai_generated`, user) | Moderate — extends existing merger | Two categories (generated vs user) with AI fields treated as auto | AI metrics have distinct lifecycle (superset guarantee, source_column tracking, user-editable descriptions). Treating them as `auto_generated` would lose these semantics and break FR-013–FR-016. |
