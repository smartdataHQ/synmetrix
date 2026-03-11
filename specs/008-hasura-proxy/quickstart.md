# Quickstart: Hasura Auth Proxy

**Branch**: `008-hasura-proxy` | **Date**: 2026-03-11

## What This Feature Does

Adds a transparent auth proxy to the CubeJS service that allows WorkOS RS256 tokens to be used for Hasura GraphQL queries and mutations. Previously, only HS256 Hasura JWTs worked for GraphQL. Now both token types work — WorkOS tokens are verified and swapped for HS256 tokens before reaching Hasura.

## Files to Modify

### CubeJS Service (`services/cubejs/`)

| File | Change |
|------|--------|
| `src/utils/mintHasuraToken.js` | **NEW** — Mint HS256 Hasura JWTs from userId (ported from Actions jwt.js) |
| `src/utils/mintedTokenCache.js` | **NEW** — Per-userId cache for minted tokens |
| `src/routes/hasuraProxy.js` | **NEW** — Express route handler for `/v1/graphql` proxy (HTTP + WebSocket) |
| `src/routes/index.js` | **MODIFY** — Register proxy routes |
| `index.js` | **MODIFY** — Wire up WebSocket proxy on server upgrade event |

### Nginx (`services/client/`)

| File | Change |
|------|--------|
| `nginx/default.conf.template` | **MODIFY** — Add `location = /v1/graphql` routing to CubeJS |

### Tests

| File | Change |
|------|--------|
| `services/cubejs/test/hasuraProxy.test.js` | **NEW** — Unit tests for proxy middleware |
| `tests/` | **MODIFY** — StepCI integration tests for GraphQL via WorkOS token |

## Key Dependencies (all already available)

- `jose` v6.2.1 — JWKS verification + JWT minting (already in CubeJS)
- `http-proxy-middleware` v3.0.0 — HTTP/WebSocket proxy (available via `@cubejs-backend/api-gateway`)
- `workosAuth.js` — Token detection + JWKS verification (existing)
- `dataSourceHelpers.js` — JIT provisioning + identity caching (existing)

## Environment Variables (all already configured)

```
WORKOS_CLIENT_ID          # WorkOS app ID (JWKS URL construction)
WORKOS_API_KEY            # WorkOS API (user profile fetch)
JWT_KEY                   # HS256 signing key (shared with Hasura)
JWT_ALGORITHM             # HS256
JWT_CLAIMS_NAMESPACE      # "hasura"
JWT_EXPIRES_IN            # 15 (minutes)
HASURA_ENDPOINT           # http://hasura:8080 (proxy target)
```

## Testing

```bash
# With WorkOS token
curl -X POST http://localhost:4000/v1/graphql \
  -H "Authorization: Bearer <workos-rs256-token>" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ users { id display_name } }"}'

# With legacy Hasura token (should still work)
curl -X POST http://localhost:4000/v1/graphql \
  -H "Authorization: Bearer <hasura-hs256-token>" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ users { id display_name } }"}'

# Through Nginx (production path)
curl -X POST http://localhost/v1/graphql \
  -H "Authorization: Bearer <either-token>" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ users { id display_name } }"}'
```
