# Contract: CubeJS Authentication (Updated)

**Branch**: `007-workos-jwt-query` | **Date**: 2026-03-10

## REST API Authentication

All CubeJS REST endpoints (`/api/v1/*`) accept two token types:

### Token Type 1: WorkOS JWT (new)

**Headers**:
```
Authorization: Bearer <workos-jwt>
x-hasura-datasource-id: <uuid>
x-hasura-branch-id: <uuid>           (optional, defaults to active branch)
x-hasura-branch-version-id: <uuid>   (optional, defaults to latest version)
```

**Token format**: RS256-signed JWT from WorkOS

**Required claims**:
```json
{
  "sub": "user_01KEC615YDR3NK2SPGW84ZASR3",
  "partition": "blue.is",
  "org_id": "org_01KEC612MEP1Z3FVQ6QD9HGAVG",
  "exp": 1773152982,
  "iat": 1773152682
}
```

**Verification**: JWKS at `https://api.workos.com/sso/jwks/{WORKOS_CLIENT_ID}` (or custom issuer via `WORKOS_ISSUER` env var for custom domain deployments). Audience (`aud`) validated against `WORKOS_CLIENT_ID`.

**User resolution**: `sub` → `auth_accounts.workos_user_id` → `user_id`

### Token Type 2: Hasura JWT (existing, unchanged)

**Headers**: Same as above.

**Token format**: HS256-signed JWT minted by Actions service

**Required claims**:
```json
{
  "hasura": {
    "x-hasura-user-id": "748e8a31-080f-4532-...",
    "x-hasura-allowed-roles": ["user"],
    "x-hasura-default-role": "user"
  }
}
```

**Verification**: Shared `JWT_KEY` with HS256 algorithm

**User resolution**: `hasura.x-hasura-user-id` → direct `user_id`

### Token Detection

The system distinguishes tokens by decoding the JWT header (without verification):
- `alg: "RS256"` → WorkOS token → JWKS verification path
- `alg: "HS256"` → Hasura token → shared-key verification path

### Error Responses

| Scenario | HTTP Status | Error Message |
|---|---|---|
| Missing Authorization header | 403 | `Provide Hasura Authorization token` |
| Expired token | 403 | `TokenExpiredError: jwt expired` |
| Invalid signature (either type) | 403 | `JsonWebTokenError: invalid signature` |
| User not found (after provisioning attempt fails) | 404 | `404: user "{sub}" not found` |
| Missing datasource header | 400 | `400: No x-hasura-datasource-id provided` |
| Datasource not found | 404 | `404: datasource not found` |
| Datasource not authorized (SQL API) | 403 | `403: access denied for datasource "{id}"` |
| WorkOS API unreachable during provisioning | 503 | `503: Unable to provision user` |
| JWKS endpoint unreachable | 503 | `503: Unable to verify token` |

**Important**: All errors MUST use structured error objects with a `status` property. The Express error handler reads `err.status` to set the HTTP response code. Errors without a `status` property default to 500.

## SQL API Authentication

### WorkOS JWT as password (new)

```
Username: <datasource-id>
Password: <workos-jwt>
```

The username field specifies which datasource to query. The user must have access to this datasource (member of the owning team).

**Detection**: If the password contains two dots and the decoded header has `alg: "RS256"`, use JWKS verification path. **Fail-closed**: if JWT verification fails (expired, invalid signature, JWKS unreachable), reject the connection immediately — do NOT fall through to legacy credential lookup. Only if the password does NOT look like a JWT, fall back to `sql_credentials` table lookup.

### Existing credential method (unchanged)

```
Username: <sql_credentials.username>
Password: <sql_credentials.password>
```

## Token Endpoint (Actions Service)

### GET /auth/token

**Response** (updated):
```json
{
  "accessToken": "<hasura-jwt>",
  "workosAccessToken": "<workos-jwt>",
  "userId": "748e8a31-...",
  "teamId": "abc123-...",
  "role": "user"
}
```

New field: `workosAccessToken` — the WorkOS JWT for direct CubeJS queries.
