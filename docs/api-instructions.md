# Synmetrix API Instructions — Discovery, Metadata & Queries

Base URL: `http://{host}:4000`

---

## Authentication

All endpoints accept a JWT Bearer token in the `Authorization` header. Three token types are supported:

| Token Type | Algorithm | Detection | Verification |
|---|---|---|---|
| **WorkOS** | RS256 | JWT header `alg === "RS256"` | JWKS from `https://api.workos.com/sso/jwks/{WORKOS_CLIENT_ID}` |
| **FraiOS** | HS256 | Payload contains `accountId` claim | HMAC with `TOKEN_SECRET` env var |
| **Legacy Hasura** | HS256 | Fallback (not RS256, no `accountId`) | HMAC with `JWT_KEY` env var |

WorkOS and FraiOS tokens trigger just-in-time user provisioning — the user is created in the system on first use.

---

## Step 1: Discover Available Datasources

### `GET /api/v1/discover`

Returns all datasources and cubes visible to the authenticated user. This is the entry point — call it first to get the IDs needed for all other endpoints.

**Auth:** WorkOS or FraiOS token only. Legacy Hasura tokens are rejected.
**Headers:** `Authorization: Bearer <token>` (no datasource headers needed)

**Response:**

```json
{
  "datasources": [
    {
      "id": "a1b2c3d4-...",
      "name": "Production ClickHouse",
      "db_type": "clickhouse",
      "team_id": "e5f6g7h8-...",
      "branch_id": "i9j0k1l2-...",
      "version_id": "m3n4o5p6-...",
      "cubes": [
        { "name": "Orders", "description": "All customer orders" },
        { "name": "Users", "description": null }
      ]
    }
  ],
  "usage": { ... }
}
```

The response fields map to headers required by subsequent endpoints:

| Response field | Header to send | Required? |
|---|---|---|
| `id` | `x-hasura-datasource-id` | Yes |
| `branch_id` | `x-hasura-branch-id` | No (defaults to active branch) |
| `version_id` | `x-hasura-branch-version-id` | No (defaults to latest version) |

**Partition filtering:** If the JWT contains a `partition` claim, only datasources from teams whose `settings.partition` matches are returned.

**Errors:**

| Status | Meaning |
|---|---|
| 403 | Missing auth, invalid token, or legacy Hasura token used |
| 500 | Internal error |

---

## Step 2: Get Cube Metadata

### `GET /api/v1/meta`

Returns full metadata for all cubes in the selected datasource — dimensions, measures, segments, joins, and types. This is a Cube.js built-in endpoint.

**Auth:** All three token types.
**Headers:**

```
Authorization: Bearer <token>
x-hasura-datasource-id: <datasource id from discover>
x-hasura-branch-id: <branch_id from discover>          (optional)
x-hasura-branch-version-id: <version_id from discover>  (optional)
```

**Response:**

```json
{
  "cubes": [
    {
      "name": "Orders",
      "title": "Orders",
      "description": "All customer orders",
      "measures": [
        {
          "name": "Orders.count",
          "title": "Orders Count",
          "type": "number",
          "aggType": "count",
          "drillMembers": ["Orders.id", "Orders.createdAt"]
        },
        {
          "name": "Orders.totalRevenue",
          "title": "Orders Total Revenue",
          "type": "number",
          "aggType": "sum"
        }
      ],
      "dimensions": [
        {
          "name": "Orders.id",
          "title": "Orders Id",
          "type": "number",
          "primaryKey": true
        },
        {
          "name": "Orders.status",
          "title": "Orders Status",
          "type": "string"
        },
        {
          "name": "Orders.city",
          "title": "Orders City",
          "type": "string"
        }
      ],
      "segments": [
        {
          "name": "Orders.active",
          "title": "Orders Active"
        }
      ],
      "joins": {}
    }
  ]
}
```

Use this to build queries — every `measures`, `dimensions`, `timeDimensions`, and `segments` value in a load query must reference a `name` from this metadata.

---

## Step 3: Run a Query

### `POST /api/v1/load`

Execute a Cube.js query against the selected datasource.

**Auth:** All three token types.
**Headers:** Same as `/meta` (Authorization + datasource headers).

**Request body:**

```json
{
  "query": {
    "measures": ["Orders.count", "Orders.totalRevenue"],
    "dimensions": ["Orders.city"],
    "timeDimensions": [
      {
        "dimension": "Orders.createdAt",
        "granularity": "month",
        "dateRange": ["2024-01-01", "2024-12-31"]
      }
    ],
    "filters": [
      {
        "member": "Orders.status",
        "operator": "equals",
        "values": ["shipped"]
      }
    ],
    "segments": ["Orders.active"],
    "order": { "Orders.count": "desc" },
    "limit": 100,
    "offset": 0
  }
}
```

Also available as `GET` with `query` as a URL-encoded JSON query parameter.

#### Query Object Reference

| Field | Type | Description |
|---|---|---|
| `measures` | `string[]` | Aggregated values to compute. References from `/meta`. |
| `dimensions` | `string[]` | Group-by columns. References from `/meta`. |
| `timeDimensions` | `object[]` | Time-based grouping with granularity and optional date range. |
| `filters` | `object[]` | Row-level filters applied before aggregation. |
| `segments` | `string[]` | Named filter presets defined in the cube model. |
| `order` | `object` | `{ "Member.name": "asc" | "desc" }` |
| `limit` | `number` | Max rows returned (default 10,000). |
| `offset` | `number` | Pagination offset. |

#### Filter Operators

| Operator | Applies to | Description |
|---|---|---|
| `equals` | all | Exact match (array of values = OR) |
| `notEquals` | all | Exclude values |
| `contains` | string | Case-insensitive substring match |
| `notContains` | string | Exclude substring matches |
| `startsWith` | string | Prefix match |
| `endsWith` | string | Suffix match |
| `gt` | number, time | Greater than |
| `gte` | number, time | Greater than or equal |
| `lt` | number, time | Less than |
| `lte` | number, time | Less than or equal |
| `set` | all | Value is not null |
| `notSet` | all | Value is null |
| `inDateRange` | time | Within date range `["start", "end"]` |
| `notInDateRange` | time | Outside date range |
| `beforeDate` | time | Before a date |
| `afterDate` | time | After a date |

#### Time Dimension Granularities

`second`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`

#### Response (JSON, default)

```json
{
  "query": { /* normalized query */ },
  "data": [
    {
      "Orders.city": "London",
      "Orders.count": 42,
      "Orders.totalRevenue": 12500.00,
      "Orders.createdAt.month": "2024-01-01T00:00:00.000"
    }
  ],
  "annotation": {
    "measures": {
      "Orders.count": { "title": "Orders Count", "type": "number" },
      "Orders.totalRevenue": { "title": "Orders Total Revenue", "type": "number" }
    },
    "dimensions": {
      "Orders.city": { "title": "Orders City", "type": "string" }
    },
    "timeDimensions": {
      "Orders.createdAt.month": { "title": "Orders Created At", "type": "time" }
    }
  },
  "total": 42
}
```

The `annotation` object provides display metadata for each column in the result — use it for labeling and type coercion.

#### Async Polling Protocol

Long-running queries return HTTP 200 with:

```json
{ "error": "Continue wait" }
```

This is **not** an error. The client must retry the same request (same body, same headers). Cube.js processes the query in the background. Typically resolves within a few retries. Recommended retry interval: 1–2 seconds.

#### Output Formats

Add `format` to the request body or as a query parameter:

| Format | Content-Type | Notes |
|---|---|---|
| `json` (default) | `application/json` | Standard response above |
| `csv` | `text/csv` | Streamed. Header row + data rows. Limit raised to `CUBEJS_DB_QUERY_LIMIT` (default 1M rows). |
| `arrow` | `application/vnd.apache.arrow.stream` | Apache Arrow IPC stream. 100K row safety limit on buffered path. Field mapping in `X-Synmetrix-Arrow-Field-Mapping` header (base64url JSON). |
| `jsonstat` | `application/json` | JSON-stat dataset format for statistical tools. |

**Errors:**

| Status | Meaning |
|---|---|
| 400 | Invalid query or unsupported format |
| 403 | Access denied (user lacks permission to queried members) |
| 500 | Query execution failure |

---

## Step 4 (optional): Preview Generated SQL

### `GET /api/v1/sql`

Returns the SQL that Cube.js would generate for a query, without executing it. Useful for debugging or auditing.

**Auth:** All three token types.
**Headers:** Same as `/meta`.
**Query parameter:** `query` — URL-encoded Cube.js query JSON (same format as `/load`).

**Response:**

```json
{
  "sql": {
    "sql": ["SELECT city, count(*) FROM orders WHERE status = ? GROUP BY 1", ["shipped"]],
    "order": [{ "id": "Orders.count", "desc": true }]
  }
}
```

---

## Step 5 (optional): Run Raw SQL

### `POST /api/v1/run-sql`

Execute arbitrary SQL directly against the datasource. Useful for ad-hoc exploration.

**Auth:** All three token types.
**Headers:** Same as `/meta`.

**Request body:**

```json
{
  "query": "SELECT city, count(*) as cnt FROM orders GROUP BY city ORDER BY cnt DESC LIMIT 10",
  "format": "json"
}
```

**Response (JSON):**

```json
[
  { "city": "London", "cnt": "42" },
  { "city": "Berlin", "cnt": "31" }
]
```

Supports `format`: `json`, `csv`, `arrow`, `jsonstat` (same as `/load`).

**Access control:** When query rewrite rules are active for the datasource, freeform SQL is blocked unless the query is HMAC-signed (`sql_signature` field, SHA-256 hex digest using `JWT_KEY`). Signed queries come from the governed SQL generation pipeline.

**Errors:**

| Status | Body | Meaning |
|---|---|---|
| 400 | `{ "code": "query_missing" }` | No SQL provided |
| 403 | `{ "code": "sql_api_blocked" }` | Rules active, unsigned SQL |
| 500 | `{ "code": "run_sql_failed" }` | Execution error |

---

## Complete Flow Example

```
1. GET /api/v1/discover
   Authorization: Bearer <workos-or-fraios-token>

   → Pick a datasource from response, note id, branch_id, version_id

2. GET /api/v1/meta
   Authorization: Bearer <token>
   x-hasura-datasource-id: <id>

   → Browse cubes, pick measures and dimensions to query

3. POST /api/v1/load
   Authorization: Bearer <token>
   x-hasura-datasource-id: <id>
   Content-Type: application/json

   { "query": { "measures": ["Orders.count"], "dimensions": ["Orders.city"] } }

   → If response is { "error": "Continue wait" }, retry after 1-2s
   → Otherwise, data is in response.data[]
```

---

## Access Control

Two layers of access control may restrict query results:

1. **Query rewrite rules** (applies to all roles): Row-level filters injected based on team/member properties. If a required filter dimension doesn't exist on a cube, the query is blocked entirely.

2. **Field-level access list** (non-owner/non-admin roles): Each queried dimension/measure must appear in the user's `access_list.config.datasources[id].cubes` config. Missing fields are rejected with 403.

Both are transparent to the caller — queries either succeed with filtered data or fail with 403.
