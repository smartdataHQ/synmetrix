# Implementation Plan: Hasura Auth Proxy

**Branch**: `008-hasura-proxy` | **Date**: 2026-03-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-hasura-proxy/spec.md`

## Summary

Add a transparent GraphQL auth proxy to the CubeJS service that enables WorkOS RS256 tokens for Hasura GraphQL queries and mutations. The proxy detects token type, verifies WorkOS tokens via JWKS, mints cached HS256 Hasura JWTs, and forwards requests to Hasura. HS256 tokens pass through unchanged. WebSocket upgrade requests are proxied as HS256 passthrough — all users (including WorkOS) have HS256 tokens from `/auth/token`, so no WS token swapping is needed. Nginx routing is updated to route `/v1/graphql` through CubeJS instead of directly to Hasura.

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 22
**Primary Dependencies**: `jose` v6.2.1 (JWKS + JWT signing), `http-proxy-middleware` v3.0.0 (must be added as direct dependency — currently only transitive via api-gateway), Express 4.18.2
**Storage**: In-memory Map caches only (no DB changes)
**Testing**: StepCI (integration), unit tests (new test harness — `services/cubejs/test/` does not exist yet), manual curl (dev verification)
**Target Platform**: Docker container (CubeJS service)
**Project Type**: Web service middleware
**Performance Goals**: <50ms added latency for cached WorkOS path; <1ms for HS256 passthrough
**Constraints**: Single CubeJS container (note: test env uses `replicas: 3` — in-memory caches are per-instance, bounded by TTL); no new services; Hasura JWT config unchanged
**Scale/Scope**: ~300-400 lines of new code across 4 new files + 4 file modifications + test files. Includes: proxy route handler, JWT minting, token cache, raw body middleware, upgrade handler refactor, header stripping, JSON error wrapper, and test harness setup.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Service Isolation | PASS | Proxy lives within CubeJS (no new service). Nginx routing change is the only cross-service contract change. Hasura config unchanged. |
| II. Multi-Tenancy First | PASS | Proxy does not touch datasource resolution, branch selection, or schema loading. It only resolves user identity — the existing `defineUserScope` flow remains for CubeJS REST API. GraphQL queries use Hasura's own RLS. |
| III. Test-Driven Development | PASS | Plan includes tests before implementation (StepCI integration tests, unit tests for mint/cache). |
| IV. Security by Default | PASS | Every request is authenticated (401 for missing tokens). WorkOS tokens verified via JWKS. Minted HS256 tokens are short-lived (15min) with cache. Untrusted `x-hasura-*` headers stripped before forwarding. Malformed tokens detected early and rejected as 401 (not routed to HS256 verifier). No secrets in logs or responses. Dual-stack period enforces identical security. |
| V. Simplicity / YAGNI | PASS | Reuses existing auth code (workosAuth.js, dataSourceHelpers.js). New code is ~300-400 lines including raw body handling, header stripping, and error formatting. No new abstractions beyond route handler + utilities. |

**Post-Phase 1 re-check**: All gates still pass. No new complexity introduced by design artifacts.

## Project Structure

### Documentation (this feature)

```text
specs/008-hasura-proxy/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 research decisions
├── data-model.md        # In-memory cache structures
├── quickstart.md        # Dev testing guide
├── contracts/
│   └── proxy-endpoints.md  # Proxy endpoint contract + Nginx routing
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
services/cubejs/
├── index.js                          # MODIFY: mount proxy BEFORE body parsers, store server handle, wire WebSocket upgrade
├── package.json                      # MODIFY: add http-proxy-middleware as direct dependency
├── src/
│   ├── routes/
│   │   ├── index.js                  # MODIFY: wire minted token cache invalidation (proxy is NOT mounted here — it's mounted in index.js before body parsers)
│   │   └── hasuraProxy.js            # NEW: proxy route handler (HTTP + HS256 WS passthrough). Mounted in index.js before body parsers, NOT via routes/index.js
│   └── utils/
│       ├── mintHasuraToken.js        # NEW: HS256 JWT minting (ported from Actions)
│       ├── mintedTokenCache.js       # NEW: per-userId minted token cache
│       ├── workosAuth.js             # REUSE: detectTokenType, verifyWorkOSToken
│       ├── dataSourceHelpers.js      # REUSE: provisionUserFromWorkOS
│       └── checkAuth.js              # REUSE: reference pattern for dual-path auth
├── test/
│   ├── mintHasuraToken.test.js       # NEW: unit tests for JWT minting
│   ├── mintedTokenCache.test.js      # NEW: unit tests for token cache
│   └── hasuraProxy.test.js           # NEW: integration tests for proxy

services/client/
└── nginx/
    └── default.conf.template         # MODIFY: route /v1/graphql to CubeJS

tests/
└── (StepCI workflows)               # NEW: GraphQL proxy integration tests
```

**Structure Decision**: All new code lives within the existing CubeJS service directory. The proxy is 4 new source files (~300-400 lines total) + 4 modifications to existing files + 3 test files. `services/cubejs/test/` is a new directory (no test harness exists yet).

## Complexity Tracking

No complexity violations. All decisions favor simplicity:

| Decision | Simpler Alternative | Why This Is Already Simple |
|----------|---------------------|---------------------------|
| Token cache (Map) | No cache (mint per request) | User requested caching; Map is simplest cache possible |
| http-proxy-middleware | Manual fetch forwarding | Library handles WebSocket + headers automatically |
| Raw body middleware | Let Express parse then re-serialize | Re-serialization can alter body; raw passthrough is correct |
| Header stripping | Trust client headers | Security boundary requires proxy to be authoritative for `x-hasura-*` |
| Store server handle | Patch Express internals | One-line change: `const server = app.listen(port)` |
| WS passthrough (HS256) | Protocol-aware WS interception for WorkOS | All users have HS256 tokens from `/auth/token` — no WS token swapping needed. Passthrough is simplest and prevents regression from Nginx change. |

## Rollback Procedure

If the proxy causes issues after deployment:

1. **Nginx**: Revert `services/client/nginx/default.conf.template` to remove the `location = /v1/graphql` block — traffic routes directly to Hasura again, restoring pre-proxy behavior
2. **CubeJS**: The proxy routes can remain in code (unused when Nginx doesn't route to them) or be removed. They mount on `/v1/graphql`, which does not conflict with existing `/api/v1/*` routes
3. **No database changes** to roll back — feature is purely routing + in-memory caches
4. **Deployment**: Only the Client (Nginx) and CubeJS containers need redeployment. Hasura and Actions are unaffected.
