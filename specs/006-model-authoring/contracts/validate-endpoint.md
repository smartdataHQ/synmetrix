# Contract: POST /api/v1/validate

**Service**: CubeJS (port 4000)
**Auth**: JWT Bearer token (same as all CubeJS routes)

## Request

```
POST /api/v1/validate
Content-Type: application/json
Authorization: Bearer <jwt_token>
```

### Body

```json
{
  "files": [
    {
      "fileName": "semantic_events.js",
      "content": "cube(`semantic_events`, { sql_table: `cst.semantic_events`, ... })"
    },
    {
      "fileName": "orders.yml",
      "content": "cubes:\n  - name: orders\n    sql_table: public.orders\n    ..."
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| files | FileContent[] | Yes | All dataschema files to validate together |
| files[].fileName | string | Yes | File name including extension (.yml, .js) |
| files[].content | string | Yes | Full file content |

## Response

### Success (200)

```json
{
  "valid": true,
  "errors": [],
  "warnings": []
}
```

### Validation Errors (200)

```json
{
  "valid": false,
  "errors": [
    {
      "severity": "error",
      "message": "\"measures.revenue.type\" must be one of [count, sum, avg, min, max, number, count_distinct, count_distinct_approx, running_total, string, boolean, time]",
      "fileName": "orders.yml",
      "startLine": 15,
      "startColumn": 12,
      "endLine": 15,
      "endColumn": 20
    },
    {
      "severity": "error",
      "message": "\"joins.unknown_cube\" references a cube that does not exist",
      "fileName": "semantic_events.js",
      "startLine": 42,
      "startColumn": 5,
      "endLine": 45,
      "endColumn": 6
    }
  ],
  "warnings": [
    {
      "severity": "warning",
      "message": "\"shown\" is deprecated, use \"public\" instead",
      "fileName": "orders.yml",
      "startLine": 8,
      "startColumn": 5,
      "endLine": 8,
      "endColumn": 10
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| valid | boolean | true if no errors (warnings don't affect validity) |
| errors | ValidationItem[] | Compilation errors |
| warnings | ValidationItem[] | Deprecation warnings, style issues |

### ValidationItem

| Field | Type | Description |
|-------|------|-------------|
| severity | "error" \| "warning" | Severity level |
| message | string | Human-readable message |
| fileName | string | File containing the issue |
| startLine | number | 1-based start line |
| startColumn | number | 1-based start column |
| endLine | number \| null | 1-based end line (null if unavailable) |
| endColumn | number \| null | 1-based end column (null if unavailable) |

### Server Error (500)

```json
{
  "code": "validation_failed",
  "message": "Internal validation error: <details>"
}
```

## Notes

- All files are validated together as a unit (cross-file references like joins must resolve)
- The endpoint uses `prepareCompiler` from `@cubejs-backend/schema-compiler` — it does NOT use the live compiler cache
- Line/column positions are 1-based to match Monaco editor conventions
- The `ErrorReporter` from the schema compiler may not always provide end positions — `endLine`/`endColumn` will be null in those cases
