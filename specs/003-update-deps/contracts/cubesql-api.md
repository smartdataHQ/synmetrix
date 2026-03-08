# Contract: SQL API over HTTP (`POST /api/v1/cubesql`)

**Feature**: 003-update-deps | **Date**: 2026-03-07
**Type**: REST endpoint (additive — new endpoint, no existing endpoints changed)
**Source**: [cube-js/cube](https://github.com/cube-js/cube) open-source codebase (verified against source)

## Overview

Cube.js v1.5+ exposes a `POST /cubejs-api/v1/cubesql` endpoint that allows executing SQL queries against the semantic layer via HTTP with streaming JSONL responses. With this project's `basePath: '/api'` (set in `index.js:L55`), the endpoint is registered at `POST /api/v1/cubesql`. This is automatically registered by `cubejs.initApp(app)` — no custom route code is needed.

**Note:** This is a *separate* endpoint from the existing `GET /api/v1/sql` (which translates Cube queries to SQL for debugging). They serve different purposes:
- `GET /api/v1/sql` — Returns the SQL that Cube would generate for a given query (debug/inspection)
- `POST /api/v1/cubesql` — Executes a SQL query against the semantic layer and returns results (data retrieval)

## Endpoint

```
POST /api/v1/cubesql
```

## Authentication

Same as all existing `/api/v1/*` endpoints:
- `Authorization: Bearer <JWT>` header required
- JWT verified by `checkAuth.js` → same security context as `/api/v1/load`
- Access control enforced via `defineUserScope.js` access lists

## Request

```bash
curl \
  -X POST \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT status, COUNT(*) as order_count FROM orders GROUP BY status ORDER BY order_count DESC LIMIT 10"}' \
  http://localhost:4000/api/v1/cubesql
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | SQL query to execute against the semantic layer |

## Response

Streaming JSONL (JSON Lines) response. Each line is a separate JSON object:

```jsonl
{"schema":[{"name":"status","column_type":"String"},{"name":"order_count","column_type":"Int64"}],"lastRefreshTime":"2026-03-07T12:00:00.000Z"}
{"data":[["completed","1523"]]}
{"data":[["shipped","892"]]}
{"data":[["pending","341"]]}
```

| Field | Type | Description |
|-------|------|-------------|
| `schema` | array | First line: column definitions with `name` and `column_type` |
| `lastRefreshTime` | string | First line: timestamp of last data refresh (new in v1.6) |
| `data` | array | Subsequent lines: row data as arrays of values |

## Error Responses

| Status | Condition |
|--------|-----------|
| 401 | Missing or invalid JWT |
| 403 | User lacks access to queried cubes/members |
| 400 | Invalid SQL syntax or unsupported query |
| 500 | Internal query execution error |

## Proxy Routing

| Layer | Path | Target | Change Required |
|-------|------|--------|-----------------|
| Nginx | `/api/v1` → `http://synmetrix-cubejs:4000` | Already covered | None |
| Vite dev proxy | `/api/v1` → `http://localhost:4000` | Already covered | None |

## Query Pushdown Behavior

When enabled (GA in v1.6), eligible queries are pushed down directly to the source database:
- Single-datasource queries with supported SQL patterns are executed on the source DB
- Cross-datasource or unsupported patterns fall back to Cube.js processing
- Pushdown is transparent to the caller — same request/response format

## Relationship to Existing Endpoints

| Endpoint | Purpose | Affected |
|----------|---------|----------|
| `POST /api/v1/load` | JSON query API (existing) | Unchanged |
| `GET /api/v1/sql` | SQL translation/debug (existing) | Unchanged |
| `POST /api/v1/run-sql` | Raw SQL against datasource (custom) | Unchanged |
| `GET /api/v1/meta` | Schema metadata (existing) | Unchanged |
| `POST /api/v1/cubesql` | SQL against semantic layer (new) | **Added** |

## Notes

- This endpoint queries the **semantic layer** (cubes, views, measures, dimensions), NOT the raw database. For raw SQL against the datasource, use `/api/v1/run-sql`.
- The `lastRefreshTime` field is new in v1.6 streaming responses.
- The `cache` parameter is also available on `/api/v1/load` after the upgrade.
- Response format is streaming JSONL, not a single JSON object — clients must parse line-by-line.
