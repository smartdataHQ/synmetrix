# Contract: GET /api/v1/version

**Service**: CubeJS (port 4000)
**Auth**: JWT Bearer token (same as all CubeJS routes)

## Request

```
GET /api/v1/version
Authorization: Bearer <jwt_token>
```

## Response (200)

```json
{
  "version": "1.6.19"
}
```

| Field | Type | Description |
|-------|------|-------------|
| version | string | CubeJS schema-compiler package version |

## Notes

- Used by the frontend to compare against the static schema spec version
- If versions diverge (major/minor), frontend shows a soft warning banner
- Lightweight endpoint — reads version from package.json at startup, no computation
