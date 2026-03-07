# Auth API Contract (Ported from cxs2)

Base URL: Actions service (port 3000)
Frontend proxy: `/auth/*` → `http://localhost:3000/auth/*` (via Vite dev proxy)

Each endpoint below maps directly to a cxs2 route. The WorkOS SDK calls are identical; only the HTTP framework differs (Express instead of Next.js App Router).

## GET /auth/signin

**Ported from**: `cxs2/src/app/api/v1/auth/signin/route.ts`

Initiates WorkOS sign-in flow. Redirects browser to WorkOS hosted UI.

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| provider | string | no | OAuth provider: `GoogleOAuth`, `GitHubOAuth`, `LinkedInOAuth` (cxs2 line ~85: `workos.userManagement.getAuthorizationUrl({ provider })`) |
| email | string | no | Pre-fill email, auto-discover organization (cxs2 line ~45: org discovery by domain) |
| return_to | string | no | URL to redirect after auth (validated against allowlist, cxs2 line ~30) |

**Response**: HTTP 302 redirect to WorkOS authorization URL.

**Core SDK call** (same as cxs2):
```javascript
workos.userManagement.getAuthorizationUrl({
  clientId: process.env.WORKOS_CLIENT_ID,
  redirectUri: process.env.WORKOS_REDIRECT_URI,
  provider,         // optional: direct OAuth
  loginHint: email, // optional: pre-fill
  state: JSON.stringify({ returnTo }),
})
```

---

## GET /auth/callback

**Ported from**: `cxs2/src/app/auth/callback/route.ts`

Handles WorkOS OAuth callback. Not called by frontend directly.

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| code | string | yes | Authorization code from WorkOS |
| state | string | no | JSON-encoded state (contains `returnTo`) |

**Success Flow** (mirrors cxs2 callback `onSuccess` handler):
1. Exchange `code` via `workos.userManagement.authenticateWithCode()` → returns `{ user, organizationId, accessToken, refreshToken }`
2. JIT provision user if not exists (adapted from cxs2's `performJITSync()` in `src/lib/services/sync.ts` → targets PostgreSQL instead of Convex)
3. Mint Hasura-compatible JWT via existing `generateUserAccessToken(userId)` (adaptation: cxs2 returns WorkOS accessToken for Convex; we mint a Hasura JWT instead)
4. Extract session ID from WorkOS accessToken JWT `sid` claim (same as cxs2: `jose.decodeJwt(accessToken).sid`)
5. Create Redis session: `redis.setex('session:${sid}', 86400, JSON.stringify(sessionData))` (same as cxs2)
6. Set HTTP-only `session` cookie (same as cxs2)
7. HTTP 302 redirect to `return_to` or frontend default page

**Error**: HTTP 302 redirect to `/signin?error=callback_failed` (same error codes as cxs2 `src/lib/auth/errors.ts`).

---

## GET /auth/token

**Ported from**: `cxs2/src/app/api/v1/auth/token/route.ts`

Returns a fresh Hasura-compatible JWT for the current session.

**Adaptation**: cxs2 returns the WorkOS `accessToken` for Convex auth. Synmetrix returns a Hasura-compatible JWT minted from session data, since Hasura requires its own claim format.

**Headers**:
| Header | Required | Description |
|--------|----------|-------------|
| Cookie: session={id} | yes | Session cookie set during callback |

**Success Response** (200):
```json
{
  "accessToken": "eyJ... (Hasura-compatible JWT)",
  "userId": "uuid (public.users.id)",
  "role": "user"
}
```

**Headers**: `Cache-Control: no-store` (same as cxs2)

**Error Response** (401):
```json
{
  "error": true,
  "code": "unauthorized",
  "message": "No valid session"
}
```

**Refresh behavior** (ported from cxs2): If the WorkOS access token in the session has expired (< 60s remaining), calls `workos.userManagement.authenticateWithRefreshToken()` to get a new one, updates Redis, then mints a fresh Hasura JWT.

**Sliding TTL**: Each successful call to this endpoint extends the Redis session TTL to 86400 seconds via `redis.expire()`. This is the ONLY endpoint that extends the session — GraphQL requests go directly to Hasura and bypass the Actions service. The frontend's URQL `authExchange` calls this endpoint before JWT expiry (~15 min), which implicitly keeps the session alive during active use.

---

## POST /auth/signout

**Ported from**: `cxs2/src/app/api/v1/auth/signout/route.ts`

Terminates the user's session. Logic is a direct port.

**Headers**:
| Header | Required | Description |
|--------|----------|-------------|
| Cookie: session={id} | yes | Session cookie |

**Query Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| revoke_all | boolean | no | If `true`, revoke all user sessions in WorkOS (same as cxs2) |

**Success Response** (200):
```json
{
  "success": true,
  "redirectTo": "/signin"
}
```

**Side Effects** (same as cxs2):
1. Delete Redis session: `redis.del('session:${sessionId}')`
2. Revoke WorkOS session: `workos.userManagement.revokeSession({ sessionId })` or all via `revokeAllUserSessions(userId)`
3. Fetch WorkOS logout URL: `workos.userManagement.getLogoutUrl({ sessionId })`
4. Clear `session` cookie

---

## Cookie Specification (same as cxs2)

| Cookie | Value | HttpOnly | Secure | SameSite | MaxAge |
|--------|-------|----------|--------|----------|--------|
| session | session ID string | yes | yes (prod) | lax | 86400 |

---

## JWT Claims Structure (Synmetrix-specific, not in cxs2)

This is the one piece that does NOT come from cxs2. Synmetrix mints its own Hasura-compatible JWT:

```json
{
  "iat": 1709836800,
  "exp": 1709837700,
  "hasura": {
    "x-hasura-user-id": "uuid (public.users.id)",
    "x-hasura-allowed-roles": ["user"],
    "x-hasura-default-role": "user"
  }
}
```

**TTL**: ~15 minutes (`exp - iat = 900 seconds`). This is deliberately short because JWTs are not revocable at the Hasura/CubeJS layer — after sign-out, a leaked JWT can still be used until it expires. The frontend's URQL `authExchange` calls `GET /auth/token` before expiry to get a fresh JWT.

**IMPORTANT — JWT_EXPIRES_IN bug fix**: The existing `jwt.js` uses `JWT_EXPIRES_IN` env var with jose's `.setExpirationTime(`${JWT_EXPIRES_IN}m`)`. The current `.env.example` sets `JWT_EXPIRES_IN=10800`, which means 10800 **minutes** (7.5 days!). This MUST be changed to `JWT_EXPIRES_IN=15` (15 minutes).

Signed with `JWT_KEY` using `JWT_ALGORITHM` (HS256). Generated by existing `services/actions/src/utils/jwt.js:generateUserAccessToken()`.
