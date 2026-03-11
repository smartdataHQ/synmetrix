# Contract: Hasura Auth Proxy Endpoints

**Branch**: `008-hasura-proxy` | **Date**: 2026-03-11

## Overview

The proxy intercepts GraphQL requests at `/v1/graphql` (both HTTP and WebSocket upgrade) that previously went directly to Hasura. Hasura uses a single `/v1/graphql` endpoint for both HTTP and WebSocket — there is no separate `/v1/ws` endpoint. From the client's perspective, the endpoint is unchanged — only the auth token requirements are expanded for HTTP requests.

## Endpoint: GraphQL HTTP Proxy

**Path**: `/v1/graphql`
**Methods**: POST (queries, mutations), GET (queries via query params)
**Upstream**: `http://hasura:8080/v1/graphql`

### Request

```
POST /v1/graphql HTTP/1.1
Authorization: Bearer <WorkOS-RS256-token | Hasura-HS256-token>
Content-Type: application/json

{
  "query": "...",
  "variables": { ... },
  "operationName": "..."
}
```

### Behavior by Token Type

| Token Algorithm | Proxy Action | Authorization Header Forwarded to Hasura |
|-----------------|--------------|------------------------------------------|
| RS256 (WorkOS)  | Verify via JWKS → resolve userId → mint or use cached HS256 token | `Bearer <minted-HS256-token>` |
| HS256 (Hasura)  | Pass through unchanged | `Bearer <original-HS256-token>` |
| Missing         | Reject with 401 | N/A |
| Malformed (not valid JWT structure) | Reject with 401 | N/A |

### Header Stripping (Security Boundary)

Before forwarding to Hasura, the proxy MUST:
- **Strip** all incoming `x-hasura-*` headers from the client request (these could be spoofed)
- **Preserve** the `Authorization` header (original or swapped)
- **Preserve** all other application headers (`Content-Type`, etc.)
- **Handle** hop-by-hop headers per HTTP spec

Only the minted token's embedded claims are authoritative for Hasura's row-level security.

### Request Body Handling

The proxy MUST forward the request body as a **raw stream**, not re-serialized from parsed JSON. The proxy route must bypass Express's `express.json()` body parser to avoid parsing and re-serializing the request body (which can alter content).

### Response

Hasura's response is returned **unchanged** — same status code, headers, and body.

### Error Responses (proxy-originated)

| Status | Condition | Body |
|--------|-----------|------|
| 401 | No Authorization header | `{ "error": "Authorization header required" }` |
| 401 | Malformed token (not a valid JWT) | `{ "error": "Invalid token format" }` |
| 403 | Expired token | `{ "error": "Token expired" }` |
| 403 | Invalid signature / JWKS key mismatch | `{ "error": "Token verification failed" }` |
| 503 | JWKS endpoint unreachable | `{ "error": "Authentication service unavailable" }` |
| 502 | Hasura backend unreachable | `{ "error": "GraphQL service unavailable" }` |

## Endpoint: GraphQL WebSocket Proxy (HS256 Passthrough)

**Path**: `/v1/graphql` (WebSocket upgrade)
**Protocol**: `graphql-ws` (WebSocket subprotocol: `graphql-transport-ws`)
**Upstream**: `ws://hasura:8080/v1/graphql`

### Why This Is Required

The Nginx routing change (`location = /v1/graphql` → CubeJS) intercepts ALL traffic to `/v1/graphql`, including WebSocket upgrade requests. Without WebSocket proxying, subscriptions would break. The proxy passes all upgrade requests through to Hasura.

### All Users Use HS256 for WebSocket

All authenticated users — both legacy and WorkOS — have HS256 Hasura JWTs available. WorkOS users receive theirs from the `/auth/token` endpoint (`services/actions/src/auth/token.js`), which returns both `workosAccessToken` (RS256) and `accessToken` (HS256). The frontend sends the HS256 `accessToken` via `connectionParams` for WebSocket connections.

**Dual-token strategy**:
- **HTTP GraphQL**: `workosAccessToken` (RS256) → proxy swaps to HS256
- **WebSocket GraphQL**: `accessToken` (HS256) → proxy passes through → Hasura validates directly

No proxy-level token swapping is needed for WebSocket. The browser `WebSocket` API cannot send custom HTTP headers on the upgrade request, but this is irrelevant since all users have HS256 tokens available.

### Connection Handshake

```
GET /v1/graphql HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Protocol: graphql-transport-ws
```

Auth token is sent via `connectionParams` in the `connection_init` message (after upgrade), not as an HTTP header. Hasura validates this directly.

### Behavior

1. Client sends HTTP upgrade request
2. Proxy intercepts the `upgrade` event on the stored HTTP server handle
3. Strips `x-hasura-*` headers from the upgrade request (security consistency with HTTP path)
4. Calls `proxy.upgrade(req, socket, head)` to forward upgrade to Hasura
5. Client sends `connection_init` with HS256 token in `connectionParams`
6. Hasura validates the HS256 token and begins the subscription
7. Bidirectionally pipes messages between client and Hasura

### Prerequisites

- `services/cubejs/index.js` must store the HTTP server handle: `const server = app.listen(port)` (currently discarded)
- The `upgrade` event listener is attached to `server`, not to the Express app

### Connection Lifecycle

- Hasura validates the HS256 token from `connection_init` payload
- After upgrade, messages flow through without re-authentication
- If the HS256 token expires during a long-lived subscription, Hasura will close the connection
- Client is responsible for reconnecting with a fresh token (via `/auth/token`)

## Nginx Routing Contract

### Before (current)

```nginx
location ~ ^/v1 {
  proxy_pass http://$upstream_hasura;    # All /v1/* → Hasura
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "Upgrade";
  proxy_set_header Host $host;
}
```

### After

```nginx
# GraphQL proxy (HTTP + WebSocket) → CubeJS
location = /v1/graphql {
  proxy_pass http://$upstream_cubejs;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "Upgrade";
  proxy_set_header Host $host;
}

# Remaining Hasura endpoints (metadata, etc.) → Hasura direct
location ~ ^/v1 {
  proxy_pass http://$upstream_hasura;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "Upgrade";
  proxy_set_header Host $host;
}
```

The `location = /v1/graphql` exact match takes priority over the `location ~ ^/v1` regex match in Nginx.

## Cache Invalidation Contract

The existing `/api/v1/internal/invalidate-cache` endpoint is extended to also clear the minted token cache:

```
POST /api/v1/internal/invalidate-cache
Content-Type: application/json

{ "type": "user", "userId": "<optional>" }    # Clears user cache + minted token for userId (or all)
{ "type": "all" }                               # Clears all caches including minted tokens
```

No new `type` values needed — minted token cache piggybacks on `type: "user"` invalidation.
