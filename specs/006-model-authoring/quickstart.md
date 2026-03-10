# Quickstart: Model Authoring Improvements

## Prerequisites

- Docker services running (`./cli.sh compose up`)
- client-v2 dev server (`cd ../client-v2 && yarn dev`)
- ClickHouse accessible (kubectl port-forward if needed)

## Development Flow

### Backend (CubeJS service)

1. Edit files in `services/cubejs/src/routes/` and `services/cubejs/src/utils/`
2. Restart CubeJS: `./cli.sh compose restart cubejs`
3. Test validate endpoint: `curl -X POST http://localhost:4000/api/v1/validate -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"files": [...]}'`

### Frontend (client-v2)

1. Language service code lives in `src/utils/cubejs-language/`
2. Schema spec lives in `src/utils/cubejs-language/spec.ts`
3. Monaco providers are registered in `src/components/CodeEditor/`
4. Hot reload via Vite — changes appear immediately

### Testing

- Schema spec: unit tests in client-v2 (`yarn test`)
- Parsers: unit tests with fixture files
- Completion/validation providers: unit tests with mock Monaco models
- Validate endpoint: StepCI integration test
- Merge preservation: integration test via smart regeneration with user content

## Key Files to Modify

### CubeJS Service (new)
- `services/cubejs/src/routes/validate.js` — validation endpoint
- `services/cubejs/src/routes/version.js` — version endpoint

### CubeJS Service (existing)
- `services/cubejs/src/routes/index.js` — register new routes

### client-v2 (new)
- `src/utils/cubejs-language/spec.ts` — Cube.js schema spec
- `src/utils/cubejs-language/registry.ts` — Cube registry (wraps FetchMeta)
- `src/utils/cubejs-language/yamlParser.ts` — YAML document parser
- `src/utils/cubejs-language/jsParser.ts` — JS document parser
- `src/utils/cubejs-language/types.ts` — Shared types (ParsedDocument, CursorContext, etc.)
- `src/utils/cubejs-language/completionProvider.ts` — Monaco completion provider
- `src/utils/cubejs-language/diagnosticProvider.ts` — Client + backend validation
- `src/utils/cubejs-language/hoverProvider.ts` — Hover documentation provider

### client-v2 (existing)
- `src/components/CodeEditor/index.tsx` — Register providers, add toolbar button
- `src/components/SmartGeneration/index.tsx` — Regenerate flow integration
