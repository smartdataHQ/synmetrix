# Research: Hasura Auth Proxy

**Branch**: `008-hasura-proxy` | **Date**: 2026-03-11

## R1: Proxy Deployment in CubeJS

**Decision**: Add GraphQL proxy routes to the existing CubeJS Express app (`services/cubejs/src/routes/index.js`), co-located with the REST API routes.

**Rationale**: CubeJS already has all the auth infrastructure — `workosAuth.js` (JWKS verification, token detection), `dataSourceHelpers.js` (JIT provisioning, caching), and `checkAuth.js` (dual-path middleware). Adding proxy routes here avoids duplicating any auth code. The Express app already handles the `/api/v1/*` path.

**Alternatives considered**:
- Actions service middleware: Would require duplicating all WorkOS auth code or creating a shared package. Actions is an RPC service, not a proxy.
- Standalone reverse proxy: New container adds operational complexity for minimal benefit.
- Nginx auth subrequest: Adds an extra hop per request and Nginx `auth_request` doesn't support body forwarding natively.

## R2: Nginx Routing Change

**Decision**: Update `services/client/nginx/default.conf.template` to route `/v1/graphql` through CubeJS (`$upstream_cubejs`) instead of directly to Hasura (`$upstream_hasura`). Hasura uses a single `/v1/graphql` endpoint for both HTTP and WebSocket upgrades — there is no separate `/v1/ws` endpoint.

**Rationale**: Currently, the Nginx config routes all `/v1` traffic to Hasura (lines 32-38). The proxy needs to intercept GraphQL requests before they reach Hasura. The simplest change is to add specific `/v1/graphql` location blocks that route to CubeJS, while keeping remaining `/v1/*` paths (like `/v1/metadata`) routing to Hasura.

**Current routing**:
```
/v1/*      → hasura:8080   (includes graphql, ws, metadata)
/api/v1/*  → cubejs:4000   (REST API)
/auth/*    → actions:3000   (OAuth flow)
```

**New routing**:
```
/v1/graphql → cubejs:4000   (proxy intercepts HTTP + WebSocket upgrade, forwards to hasura)
/v1/*       → hasura:8080   (remaining Hasura endpoints unchanged)
/api/v1/*   → cubejs:4000   (REST API unchanged)
/auth/*     → actions:3000   (OAuth unchanged)
```

**Alternatives considered**:
- Changing the frontend to use `/api/v1/graphql`: Would require frontend changes and break the clean separation between CubeJS REST and Hasura GraphQL paths.
- Using a different port: Adds complexity without benefit; Nginx already handles path-based routing.

## R3: JWT Minting in CubeJS

**Decision**: Port the `generateUserAccessToken()` logic from `services/actions/src/utils/jwt.js` into a new utility in CubeJS. Use `jose.SignJWT` (already a CubeJS dependency) to mint HS256 Hasura JWTs.

**Rationale**: The minting logic is 15 lines. CubeJS already has `jose` v6.2.1 and all required env vars (`JWT_KEY`, `JWT_ALGORITHM`, `JWT_CLAIMS_NAMESPACE`, `JWT_EXPIRES_IN`). Extracting to a shared package would be overengineering for a 15-line function.

**Token structure** (must match exactly):
```json
{
  "hasura": {
    "x-hasura-user-id": "<userId>",
    "x-hasura-allowed-roles": ["user"],
    "x-hasura-default-role": "user"
  },
  "iss": "services:cubejs",
  "aud": "services:hasura",
  "sub": "<userId>",
  "iat": <now>,
  "exp": <now + 15m>
}
```

Note: Issuer will be `services:cubejs` (not `services:actions`) to distinguish token origin. This creates two "token dialects" but is safe because Hasura's `HASURA_GRAPHQL_JWT_SECRET` config only validates `type` (algorithm), `key`, and `claims_namespace` — it does **not** validate `iss`, `aud`, or `sub` claims. If Hasura adds issuer validation in the future, both services must be updated to use the same issuer or Hasura must be configured with multiple accepted issuers.

**Alternatives considered**:
- Calling Actions `/auth/token` endpoint: Adds network hop, requires session cookie (proxy requests don't have one).
- Sharing a package between Actions and CubeJS: Overengineering for 15 lines; both services already have independent copies of provisioning logic.

## R4: Token Cache Strategy

**Decision**: Cache minted HS256 tokens per userId in a local Map with TTL-based expiry. Reuse cached token if it has >60s remaining before expiry. Invalidate on cache invalidation events (via existing `/internal/invalidate-cache` endpoint).

**Rationale**: HS256 signing is fast (~0.1ms) but caching avoids unnecessary work on high-frequency GraphQL polling. The 60s buffer ensures Hasura never receives a token that expires mid-request. The cache is small (one entry per active user).

**Cache specification**:
- Key: userId
- Value: `{ token, exp }` (minted JWT string + expiration timestamp)
- TTL: Matches token expiry (15min), evict when <60s remaining
- Max size: 1000 entries (matches workosSubCache sizing)
- Invalidation: Clear entry on `type: "user"` or `type: "all"` invalidation events

**Known limitations**:
- **Per-instance only**: `docker-compose.test.yml` runs CubeJS with `replicas: 3`. In-memory caches are not shared across instances. Invalidation via `/internal/invalidate-cache` only reaches one instance. TTL-based expiry (15min for minted tokens) bounds staleness. This matches the existing behavior of `userCache` and `workosSubCache`.
- **No reverse userId→sub mapping**: The identity cache is keyed by WorkOS `sub`, but invalidation events arrive with `userId`. There is no way to selectively clear the identity cache by userId. It relies on 5-minute TTL expiry. The minted token cache (keyed by userId) CAN be selectively invalidated.
- **Actions invalidation gap**: `cubeCache.js` in the Actions service sends `type: "user"` (not `type: "all"`), which does not clear the WorkOS identity cache. This is a pre-existing gap, not introduced by this feature.

**Alternatives considered**:
- No caching (mint per request): Simpler but redundant work on polling queries.
- Redis-backed cache: Would solve multi-instance sharing but adds operational dependency for a cache that has 15-minute TTL anyway. Deferred unless multi-instance coherence becomes a real problem.

## R5: WebSocket Proxy

**Decision**: Use `http-proxy-middleware` with `ws: true` to proxy WebSocket upgrade requests as HS256 passthrough. No WorkOS token swapping needed on WebSocket — WorkOS users already have HS256 tokens.

**Rationale**: The Nginx routing change (`location = /v1/graphql` → CubeJS) intercepts WebSocket upgrade requests that previously went directly to Hasura. Without WebSocket proxying, subscriptions would break. The proxy MUST handle upgrades as passthrough.

**Key insight — `/auth/token` already provides HS256 tokens to WorkOS users**: The `/auth/token` endpoint in the Actions service (`services/actions/src/auth/token.js` lines 70-75) mints an HS256 Hasura JWT for every authenticated user, including WorkOS users. The response includes both `accessToken` (HS256) and `workosAccessToken` (RS256). The frontend stores both in `AuthTokensStore` and sends the HS256 `accessToken` via `connectionParams` for WebSocket connections.

**This means**: The browser `WebSocket` API limitation (cannot send custom HTTP headers on upgrade) is irrelevant. All users — WorkOS and legacy — have HS256 tokens available. The proxy simply passes all WebSocket upgrades through to Hasura unchanged. No token swapping, no protocol-aware interception, no cookie changes.

**Dual-token frontend strategy**:
- **HTTP GraphQL**: Frontend sends `workosAccessToken` (RS256) → proxy verifies, swaps to HS256, forwards to Hasura
- **WebSocket GraphQL**: Frontend sends `accessToken` (HS256) via `connectionParams` → proxy passes through → Hasura validates directly

**Prerequisites**:
- `services/cubejs/index.js` currently discards the server handle: `app.listen(port)` (line 110). Must be changed to `const server = app.listen(port)` so the `upgrade` event can be attached.

**Why not swap WorkOS tokens on WebSocket too?**: The browser `WebSocket` API (`new WebSocket(url, protocols)`) does not allow setting custom HTTP headers on the upgrade request. The `graphql-ws` library sends auth only via `connectionParams` (`connection_init` message), which arrives after the upgrade completes. A plain upgrade proxy cannot read `connection_init` without becoming a protocol-aware WS server (~300-500 lines). Since HS256 tokens are already available to all users, this complexity is unnecessary.

## R6: Shared Auth Code Reuse

**Decision**: The proxy route handlers directly import existing functions from `workosAuth.js` and `dataSourceHelpers.js`. No code extraction or shared module needed — everything is already in the same service.

**Rationale**: Since the proxy lives in the CubeJS service, it can directly `import { detectTokenType, verifyWorkOSToken } from '../utils/workosAuth.js'` and `import { provisionUserFromWorkOS } from '../utils/dataSourceHelpers.js'`. The only new code needed is:
1. JWT minting utility (ported from Actions)
2. Proxy route handler (token swap + forward to Hasura)
3. WebSocket proxy configuration

**Functions reused directly**:
- `detectTokenType(token)` — Token type detection
- `verifyWorkOSToken(token)` — JWKS verification
- `provisionUserFromWorkOS(payload)` — JIT provisioning with caching + singleflight
- `invalidateUserCache()`, `invalidateWorkosSubCache()` — Cache management

**New code needed**:
- `mintHasuraToken(userId)` — ~15 lines, ported from Actions jwt.js
- `hasuraProxyMiddleware` — Token swap + http-proxy-middleware forwarding (HTTP + HS256 WebSocket passthrough)
- Minted token cache — ~30 lines, simple Map with TTL

## R7: Existing Inconsistency — Team Lookup

**Decision**: Document but do not fix in this feature. The team name lookup differs between CubeJS (`_eq`, case-sensitive) and Actions (`_ilike`, case-insensitive). The proxy reuses CubeJS's `_eq` since it's in the same service.

**Rationale**: This inconsistency predates this feature. Fixing it would change provisioning behavior for existing users and belongs in a separate cleanup task.

**Additional note**: A GraphQL request through the proxy can trigger JIT provisioning (team creation, member role assignment) with CubeJS semantics, while the same user logging in via the Actions OAuth flow would trigger provisioning with different team-lookup semantics. This means a read-path request could mutate org state differently than a login-time request. This is accepted as a pre-existing risk.

## R8: Raw Body Passthrough

**Decision**: The proxy route MUST bypass Express's `express.json()` and `express.urlencoded()` body parsers. The request body must be forwarded as a raw stream to Hasura.

**Rationale**: CubeJS runs `express.json({ limit: "50mb" })` and `express.urlencoded({ limit: "50mb" })` at `index.js:32-33` before all routes. If the proxy route is mounted on the same Express app, it receives `req.body` as a parsed JavaScript object, not the raw stream. `http-proxy-middleware` needs the raw body (or buffered raw bytes) to forward correctly — re-serializing from parsed JSON can alter whitespace, key ordering, and encoding.

**Implementation approach**: Mount the proxy route before the body parsers in `index.js`. The exact middleware order in `index.js` MUST be:

1. `app.use(hasuraProxy({ ... }))` — NEW, before body parsers (proxy receives raw stream)
2. `app.use(express.json({ limit: "50mb" }))` — existing line 32
3. `app.use(express.urlencoded({ ... }))` — existing line 33
4. `app.use(routes({ ... }))` — existing (REST API receives parsed bodies)

**Important**: The proxy is mounted directly in `index.js`, NOT via `routes/index.js`. The `routes/index.js` file is only modified to wire minted token cache invalidation into the existing `/internal/invalidate-cache` handler. This avoids ambiguity about middleware ordering.

**Alternatives considered**:
- Re-serialize `req.body` as JSON: Fragile — can alter content, breaks signatures, changes Content-Length.
- Use `express.raw()` for proxy routes: Works but requires careful middleware ordering.

## R9: Header Stripping at Security Boundary

**Decision**: The proxy MUST strip all `x-hasura-*` headers from incoming requests before forwarding to Hasura. Only the minted token's claims are authoritative.

**Rationale**: Hasura extracts `x-hasura-user-id`, `x-hasura-role`, etc. from the JWT. However, if a client sends these as HTTP headers alongside a valid token, Hasura might use them in certain configurations. The proxy is a trust boundary — it must not forward untrusted claim headers.

**Implementation**: In the `http-proxy-middleware` `onProxyReq` callback, iterate over request headers and delete any matching `/^x-hasura-/i`.

## R10: JSON Error Responses

**Decision**: All proxy-originated errors MUST return JSON bodies with `Content-Type: application/json`. The proxy must NOT let errors fall through to the global CubeJS error handler (which returns plain text).

**Rationale**: The global error handler at `index.js:104-108` calls `res.send(err.message)` which returns `Content-Type: text/plain`. GraphQL clients expect JSON responses. The proxy route handler must wrap all auth/proxy logic in try-catch and return structured JSON errors.

**Implementation**: Wrap the auth middleware in try-catch. Map error types to status codes and JSON bodies:
- `jose` errors: Map `ERR_JWT_EXPIRED` → 403, `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` → 403, `ERR_JWKS_NO_MATCHING_KEY` → 403, network errors → 503
- `jsonwebtoken` errors: `TokenExpiredError` → 403, `JsonWebTokenError` → 403
- Malformed tokens (not parseable as JWT): Detect before routing to verifiers → 401
- Hasura unreachable: `http-proxy-middleware` `onError` callback → 502

## R11: Malformed Token Detection

**Decision**: The proxy MUST detect malformed tokens (not valid JWT structure) before calling `detectTokenType()`, which silently defaults to "hasura" for unparseable tokens.

**Rationale**: `detectTokenType()` in `workosAuth.js` catches `jose.decodeProtectedHeader()` errors and returns `"hasura"`. This means a completely malformed token (e.g., "not-a-jwt") gets routed to `jsonwebtoken.verify()` which throws a `JsonWebTokenError`. While this eventually results in an error, the error path is confusing and the error message may leak implementation details.

**Implementation**: Before calling `detectTokenType()`, verify the token has the basic JWT structure (3 dot-separated segments). If not, immediately return 401 with `{ "error": "Invalid token format" }`.

## R12: `http-proxy-middleware` as Direct Dependency

**Decision**: Add `http-proxy-middleware` as a direct dependency in `services/cubejs/package.json`, not rely on it being transitively available.

**Rationale**: The package is currently only available via `@cubejs-backend/api-gateway`. Transitive dependencies can be removed or changed in minor version bumps. Depending on transitive availability is fragile for a core feature.

**Implementation**: `npm install http-proxy-middleware` in `services/cubejs/`.
