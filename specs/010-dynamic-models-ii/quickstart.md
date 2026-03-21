# Quickstart: Dynamic Models II

**Branch**: `010-dynamic-models-ii` | **Date**: 2026-03-15

## Prerequisites

- Docker services running: `./cli.sh compose up`
- ClickHouse port-forward: `kubectl port-forward -n clickhouse svc/clickhouse-fraios-clickhouse 18123:8123`
- client-v2 dev server: `cd ../client-v2 && yarn dev`
- OpenAI API key set in `.dev.env`: `OPENAI_API_KEY=sk-...`

## New Dependencies

```bash
# In services/cubejs/
npm install openai

# In ../client-v2/
yarn add react-querybuilder
```

## Key Files to Modify

### Backend (services/cubejs/)

| File | Change |
|------|--------|
| `src/utils/smart-generation/profiler.js` | Accept `filters` param, extend `buildWhereClause()` |
| `src/utils/smart-generation/filterBuilder.js` | **NEW** — build parameterized WHERE from filter conditions |
| `src/utils/smart-generation/llmEnricher.js` | **NEW** — OpenAI integration, prompt construction, response parsing |
| `src/utils/smart-generation/llmValidator.js` | **NEW** — validate LLM-generated SQL expressions |
| `src/utils/smart-generation/cubeBuilder.js` | Integrate AI metrics into cube output |
| `src/utils/smart-generation/merger.js` | Handle `ai_generated` fields as third category |
| `src/utils/smart-generation/diffModels.js` | Add AI metric diff sections |
| `src/routes/smartGenerate.js` | Accept `filters`, call LLM enricher after build |
| `src/routes/profileTable.js` | Accept and apply `filters` |

### Backend (services/actions/)

| File | Change |
|------|--------|
| `src/rpc/smartGenSchemas.js` | Pass `filters` through to CubeJS API |

### Frontend (../client-v2/)

| File | Change |
|------|--------|
| `src/components/SmartGeneration/index.tsx` | Add filter builder UI to Select step |
| `src/components/SmartGeneration/FilterBuilder.tsx` | **NEW** — filter condition rows |
| `src/components/CodeEditor/index.tsx` | AI metric decorations and hover provider |
| `src/graphql/gql/datasources.gql` | Add `filters` param to mutations |

### Hasura

| File | Change |
|------|--------|
| `services/hasura/metadata/actions.graphql` | Add `FilterConditionInput` type, update `smart_gen_dataschemas` |
| `services/hasura/metadata/actions.yaml` | Update action definition |

## Verification

```bash
# Test filtered profiling (after backend changes)
curl -X POST http://localhost:4000/api/v1/profile-table \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "table": "your_table",
    "schema": "default",
    "branchId": "your-branch-id",
    "filters": [{"column": "country", "operator": "=", "value": "US"}]
  }'

# Test smart generation with AI metrics
curl -X POST http://localhost:4000/api/v1/smart-generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "table": "your_table",
    "schema": "default",
    "branchId": "your-branch-id",
    "filters": [{"column": "country", "operator": "=", "value": "US"}]
  }'
```
