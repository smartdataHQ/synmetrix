# Quickstart: Improved Query Output

**Feature**: 009-query-output
**Date**: 2026-03-12

## Prerequisites

- Docker development environment running (`./cli.sh compose up`)
- ClickHouse accessible via port-forward (`kubectl port-forward -n clickhouse svc/clickhouse-fraios-clickhouse 18123:8123`)
- Valid JWT token for API authentication
- Node.js 22+ for jsonstat-toolkit development

## Quick Verification

### 1. CSV Export (ClickHouse fast path)

```bash
curl -X POST http://localhost:4000/api/v1/run-sql \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-hasura-datasource-id: $DATASOURCE_ID" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT * FROM events LIMIT 10", "format": "csv"}' \
  -o result.csv

# Verify: should be valid CSV with header row
head -5 result.csv
```

### 2. JSON-Stat Export

```bash
curl -X POST http://localhost:4000/api/v1/run-sql \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-hasura-datasource-id: $DATASOURCE_ID" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT country, year, sum(revenue) as revenue FROM sales GROUP BY country, year", "format": "jsonstat"}' | jq .version

# Should output: "2.0"
```

### 3. Default JSON (unchanged)

```bash
curl -X POST http://localhost:4000/api/v1/run-sql \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-hasura-datasource-id: $DATASOURCE_ID" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT 1 as test"}'

# Should output: [{"test": 1}]  (same as before)
```

### 4. Frontend Format Export (Explore Page)

1. Open Explore page at `http://localhost:8000`
2. Build a query (select dimensions + measures)
3. Click "Run Query" to see results
4. Click the export dropdown → select "CSV"
5. Verify: a CSV file downloads with all matching rows (not just the visible page)

## Development Workflow

### CubeJS Service (format parameter)

```bash
cd services/cubejs
npm run start.dev    # Dev mode with nodemon — auto-restarts on changes
```

Key files to modify:
- `src/routes/runSql.js` — Add format parameter handling
- `src/routes/index.js` — Route registration (unchanged)

### jsonstat-toolkit Fork

```bash
# Clone the fork
git clone git@github.com:smartdataHQ/toolkit.git
cd toolkit

# Install and test
npm install
npm test            # Run existing ~80 tests

# Build all formats
npm run build       # Rollup → IIFE, CJS, ESM module, ESM import

# Run benchmarks (after adding benchmark scripts)
node benchmarks/transform-100k.js
node benchmarks/dice-1m.js
```

### Frontend Format Selector (`../client-v2`)

```bash
cd ../client-v2
yarn dev                         # Dev server on port 8000
```

Key files to modify:
- `src/components/ExploreDataSection/index.tsx` — Replace react-csv export with format selector
- `src/components/ExploreSettingsForm/index.tsx` — Remove MAX_ROWS_LIMIT
- `src/hooks/useFormatExport.ts` — New hook: gen_sql → run-sql → file download

### Row Limit Removal

Environment variables (in `.env` or docker-compose):
```bash
# Remove or set to very large values
CUBEJS_DB_QUERY_DEFAULT_LIMIT=1000000
CUBEJS_DB_QUERY_LIMIT=1000000
```

Frontend (`../client-v2/src/components/ExploreSettingsForm/index.tsx`):
- Remove or raise `MAX_ROWS_LIMIT` constant

## Test Strategy

1. **Unit tests**: CSV escaping, JSON-Stat construction, format validation
2. **Integration tests**: End-to-end format parameter on run-sql with real ClickHouse
3. **Benchmark tests**: jsonstat-toolkit performance on 100K/1M datasets
4. **Regression tests**: Existing JSON output unchanged when no format specified
5. **StepCI tests**: Add format parameter scenarios to `tests/` workflow
