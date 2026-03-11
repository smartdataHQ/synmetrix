# Feature Specification: Hasura Auth Proxy

**Feature Branch**: `008-hasura-proxy`
**Created**: 2026-03-11
**Status**: Draft
**Input**: User description: "Hasura Proxy"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - GraphQL Queries with WorkOS Token (Priority: P1)

A user who is authenticated via WorkOS sends a GraphQL query (or mutation) to the Hasura endpoint using their WorkOS RS256 token in the `Authorization` header. The proxy transparently verifies the WorkOS token, resolves the user's identity, and forwards the request to Hasura with a valid HS256 JWT containing the correct Hasura claims (namespace and claim names driven by `JWT_CLAIMS_NAMESPACE` configuration). The user receives their query result without knowing a token swap occurred.

**Why this priority**: This is the core purpose of the feature. Without it, WorkOS-authenticated users cannot use the GraphQL API at all.

**Independent Test**: Can be tested by sending a GraphQL query with a WorkOS RS256 Bearer token and verifying the response contains valid data and correct row-level security filtering.

**Acceptance Scenarios**:

1. **Given** a user with a valid WorkOS RS256 token, **When** they send a GraphQL query to the proxy endpoint, **Then** the proxy verifies the token, mints an HS256 Hasura JWT, forwards the request to Hasura, and returns the query result.
2. **Given** a user with a valid WorkOS RS256 token who does not yet exist in the database, **When** they send their first GraphQL query, **Then** the proxy provisions the user (creates user, account, team membership) before forwarding the request.
3. **Given** a user with a valid WorkOS RS256 token, **When** they send a GraphQL mutation, **Then** the mutation executes with correct row-level security based on the resolved `x-hasura-user-id`.

---

### User Story 2 - Legacy Hasura JWT Passthrough (Priority: P1)

A user authenticated via the existing login flow (HS256 Hasura JWT from the Actions service) sends a GraphQL request. The proxy detects the HS256 token and passes it through to Hasura unchanged. The existing authentication flow continues to work without disruption.

**Why this priority**: Equal to P1 because breaking existing auth would be a regression. Both paths must work simultaneously.

**Independent Test**: Can be tested by sending a GraphQL query with an existing HS256 Hasura JWT and verifying the response is identical to what Hasura returns without the proxy.

**Acceptance Scenarios**:

1. **Given** a user with a valid HS256 Hasura JWT, **When** they send a GraphQL query through the proxy, **Then** the request is forwarded to Hasura unchanged and the response is returned as-is.
2. **Given** a user with an expired HS256 JWT, **When** they send a request, **Then** Hasura returns its standard authentication error (the proxy does not interfere).

---

### User Story 3 - CubeJS REST API with Unified Auth (Priority: P2)

The CubeJS service already supports dual-path authentication (WorkOS RS256 and Hasura HS256). This story ensures the proxy approach is consistent across both the GraphQL and REST API layers, using shared verification logic rather than duplicated implementations.

**Why this priority**: CubeJS dual-path auth already works. This story is about consolidating the shared logic so both services use the same verification and provisioning code, reducing maintenance burden.

**Independent Test**: Can be tested by verifying that after refactoring, CubeJS REST API calls with both token types continue to return correct results.

**Acceptance Scenarios**:

1. **Given** shared token verification logic extracted from CubeJS, **When** the proxy and CubeJS both use it, **Then** both services accept WorkOS and Hasura tokens identically.
2. **Given** a WorkOS token, **When** used against both the GraphQL proxy and CubeJS REST API, **Then** the same user identity is resolved in both cases.

---

### User Story 4 - WebSocket Subscriptions (Priority: P3)

The Nginx routing change (`/v1/graphql` → CubeJS) intercepts WebSocket upgrade requests that previously went directly to Hasura. The proxy MUST handle WebSocket upgrades as HS256 passthrough to avoid breaking existing subscriptions.

**WorkOS users and WebSocket**: WorkOS-authenticated users already receive an HS256 Hasura JWT from the `/auth/token` endpoint (see `services/actions/src/auth/token.js`). The frontend stores both `workosAccessToken` and `accessToken` (HS256) in `AuthTokensStore`. For WebSocket subscriptions, the frontend sends the HS256 `accessToken` via `connectionParams` — this works through the proxy as a standard HS256 passthrough. No token swapping is needed on WebSocket because WorkOS users already have valid HS256 tokens.

**Why this priority**: HS256 WebSocket passthrough is required to prevent a regression from the Nginx routing change. No proxy-level token swapping is needed for WebSocket because all authenticated users (both legacy and WorkOS) have HS256 tokens available.

**Independent Test**: Establish a WebSocket subscription with an HS256 token (from either auth path) and verify live data updates are received through the proxy.

**Acceptance Scenarios**:

1. **Given** a user with a valid HS256 Hasura JWT (from legacy login or WorkOS `/auth/token`), **When** they initiate a WebSocket subscription through the proxy, **Then** the upgrade request is forwarded to Hasura and subscriptions work normally.
2. **Given** a WebSocket upgrade request with `x-hasura-*` headers, **When** the proxy handles the upgrade, **Then** those headers are stripped before forwarding (security consistency with HTTP path).

#### Why No WorkOS Token Swapping on WebSocket

The browser `WebSocket` API cannot send custom HTTP headers on the upgrade request, so the proxy cannot intercept and swap WorkOS tokens at the HTTP layer. However, this is a non-issue because WorkOS users already have HS256 tokens from `/auth/token`. The frontend uses: WorkOS RS256 token for HTTP GraphQL (where the proxy adds value), and HS256 token for WebSocket (where it already works via passthrough).

---

### Edge Cases

- What happens when the WorkOS JWKS endpoint is unreachable? The proxy should return an appropriate error (service unavailable) without falling back to HS256 verification for RS256 tokens.
- What happens when a WorkOS token has valid signature but the user's WorkOS account has been deactivated? If the user already has a `workos_user_id` linked in `auth_accounts`, resolution succeeds without calling WorkOS (cache or DB lookup). If no link exists yet, `fetchWorkOSUserProfile(sub)` is called and will fail with a 404 error from the WorkOS API, causing a 503 from the proxy. This is a pre-existing limitation of the provisioning code — it cannot provision a user whose WorkOS profile is no longer accessible.
- What happens when multiple concurrent requests arrive for the same never-before-seen WorkOS user? Within a single CubeJS instance, singleflight deduplication (`inflightProvisions` Map) ensures only one provisioning operation executes. **Across replicas**, concurrent requests hitting different instances can each trigger independent provisioning, potentially creating duplicate user rows (see SC-005). This is a pre-existing limitation of the in-memory singleflight pattern.
- What happens when a malformed token is sent (not a valid JWT at all)? The proxy MUST detect this before routing to any verification path (not rely on `detectTokenType()` which defaults to "hasura" for unparseable tokens). Return 401 with a JSON error body.
- What happens when the Hasura backend is unavailable? The proxy should return a 502 JSON error rather than hanging.
- What happens when the client sends spoofed `x-hasura-user-id` or `x-hasura-role` headers? The proxy MUST strip all `x-hasura-*` headers from the incoming request before forwarding. Only the minted token's claims are authoritative.
- What happens when CubeJS runs as multiple replicas (e.g., `replicas: 3` in test/staging)? In-memory caches (minted tokens, identity mappings) are per-instance. Invalidation via the internal endpoint only reaches one instance. This is a known limitation — TTL-based expiry (5min identity, 15min token) bounds staleness. This matches the existing behavior of all CubeJS in-memory caches.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST detect token type (RS256 vs HS256) by inspecting the JWT header algorithm field without verifying the token.
- **FR-002**: System MUST verify WorkOS RS256 tokens using the WorkOS JWKS endpoint with automatic key caching and rotation.
- **FR-003**: System MUST mint a short-lived HS256 Hasura JWT containing correct claims (`x-hasura-user-id`, `x-hasura-default-role`, `x-hasura-allowed-roles`) when a valid WorkOS token is presented. Minted tokens MUST be cached per userId and reused until near expiry, then re-minted.
- **FR-004**: System MUST pass through HS256 tokens to Hasura without modification.
- **FR-005**: System MUST provision new users on first WorkOS token encounter (create user, account, team membership) by calling the existing `provisionUserFromWorkOS()` in `dataSourceHelpers.js`. This inherits the CubeJS provisioning behavior, including: case-sensitive team name lookup (`_eq`), first-team-creator gets "owner" role, subsequent members get "member" role. Note: This differs from the Actions service login-time provisioning which uses case-insensitive lookup (`_ilike`). This divergence is pre-existing and out of scope for this feature (see research.md R7).
- **FR-006**: System MUST cache WorkOS identity mappings (sub to userId) to avoid redundant provisioning and database lookups on every request.
- **FR-007**: System MUST use singleflight deduplication to prevent concurrent provisioning of the same WorkOS user within a single CubeJS instance. This is an in-memory Map (`inflightProvisions`) and provides no cross-replica protection. The proxy inherits this pre-existing limitation from `provisionUserFromWorkOS()`.
- **FR-008**: System MUST forward the request body and query parameters unchanged to Hasura. The proxy MUST strip or overwrite untrusted `x-hasura-*` headers from the client before forwarding — only proxy-generated `x-hasura-*` headers (from the minted token) are authoritative. Hop-by-hop headers MUST be handled per HTTP spec. The request body MUST be forwarded as a raw stream (not re-serialized from parsed JSON) to preserve content integrity and avoid body-parser interference.
- **FR-009**: System MUST return Hasura's response to the client unchanged (status codes, headers, body).
- **FR-010**: System MUST proxy WebSocket upgrade requests on `/v1/graphql` to Hasura to prevent breaking subscriptions after the Nginx routing change. The CubeJS HTTP server handle MUST be stored (not discarded) so that an `upgrade` event listener can be attached. The proxy MUST strip `x-hasura-*` headers from upgrade requests for security consistency. All WebSocket connections use HS256 tokens (passthrough) — WorkOS-authenticated users already receive HS256 tokens from `/auth/token`, so no token swapping is needed on WebSocket.
- **FR-011**: System MUST reject all unauthenticated requests (no Authorization header) with 401, return 403 for invalid/expired tokens, and 503 for JWKS endpoint failures. Anonymous/unauthenticated Hasura access is not supported through the proxy. All proxy-originated error responses MUST be JSON (`Content-Type: application/json`), not plain text. Malformed tokens (not valid JWT structure) MUST be detected and rejected with 401 before being routed to any verification path.
- **FR-012**: System MUST expose a cache invalidation mechanism for the minted token cache (keyed by userId) via the existing `/internal/invalidate-cache` endpoint. The identity cache (keyed by WorkOS `sub`) cannot be selectively invalidated per-user because no reverse userId→sub mapping exists; it relies on TTL-based expiry (5 minutes). This is a known limitation shared with the existing CubeJS auth caches.
- **FR-013**: System MUST produce JWT claims using the `JWT_CLAIMS_NAMESPACE` environment variable (not hardcoded). The minted token structure MUST match the active Hasura JWT configuration exactly.

### Key Entities

- **Proxy Request**: An incoming HTTP request with an Authorization header containing either a WorkOS RS256 or Hasura HS256 JWT.
- **Minted Token**: A short-lived HS256 JWT generated by the proxy, containing Hasura claims derived from the verified WorkOS identity.
- **Identity Cache**: A mapping from WorkOS subject identifier to internal user ID, with time-based expiration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users authenticated via WorkOS can execute GraphQL queries and mutations with correct data access, with no difference in result compared to users using legacy authentication.
- **SC-002**: Existing users with HS256 tokens experience zero change in behavior or performance after the proxy is introduced.
- **SC-003**: The proxy adds less than 50ms of latency to requests using cached WorkOS identities (token detection + verification + cache lookup).
- **SC-004**: First-time WorkOS users are provisioned and receive their query response within a single request (no separate registration step required).
- **SC-005**: Within a single CubeJS instance, the system handles 100 concurrent requests from the same new WorkOS user without creating duplicate user records (via in-memory singleflight deduplication). **Known limitation**: Across multiple CubeJS replicas (`replicas: 3` in test/staging), concurrent first-time requests for the same user hitting different instances can create duplicate user rows because the singleflight is per-instance and `insert_users_one` has no `on_conflict` clause. This is a pre-existing limitation of the provisioning code in `dataSourceHelpers.js`, not introduced by this feature. Mitigation: add a unique constraint on `auth_accounts(workos_user_id)` (separate task).
- **SC-006**: WebSocket subscriptions work for all authenticated users through the proxy. WorkOS-authenticated users use their HS256 token (from `/auth/token`) for WebSocket connections. Legacy users use their existing HS256 token. Both paths work via HS256 passthrough.

## Clarifications

### Session 2026-03-11

- Q: Where does the proxy live — standalone service, Actions middleware, or CubeJS middleware? → A: Middleware in the CubeJS service, co-located with existing REST API routes. Nginx routes `/v1/graphql` through CubeJS instead of directly to Hasura. No new service.
- Q: Should requests with no Authorization header pass through to Hasura or be blocked? → A: Block — all requests require a token. The proxy returns 401 for missing tokens.
- Q: Should minted HS256 tokens be cached per-user or minted fresh per request? → A: Always cache per userId. Reuse cached token until near expiry, then mint a new one.

## Assumptions

- The proxy will be deployed as middleware within the CubeJS service, co-located with the existing REST API routes and dual-path auth code. Nginx will route GraphQL traffic (`/v1/graphql`) through CubeJS, which proxies to Hasura after token verification/swap.
- WorkOS tokens contain a `sub` claim that uniquely identifies the user, and optionally a `partition` claim for team derivation.
- The existing JIT provisioning logic in `dataSourceHelpers.js` and `workosAuth.js` can be shared between CubeJS and the proxy.
- Hasura's internal JWT validation remains unchanged (single HS256 secret). The proxy handles all WorkOS token complexity before Hasura sees the request.
- **Frontend dependency (HTTP only)**: The frontend (`client-v2`) currently sends the HS256 `accessToken` for GraphQL HTTP requests via `URQLClient.ts`. For users to benefit from this proxy's WorkOS support on HTTP requests, the frontend MUST be updated to send the `workosAccessToken` when available in the `Authorization` header for HTTP requests. This frontend change is out of scope for this spec but is a **blocking dependency** for end-user value on the HTTP path.
- **WebSocket uses HS256 for all users**: The browser `WebSocket` API cannot send custom HTTP headers on the upgrade request. However, this is a non-issue because WorkOS-authenticated users already receive an HS256 Hasura JWT from the `/auth/token` endpoint (`services/actions/src/auth/token.js` lines 70-75). The frontend stores both tokens and sends the HS256 `accessToken` via `connectionParams` for WebSocket connections. No proxy-level token swapping is needed for WebSocket — all users use HS256 passthrough.
- The minted HS256 tokens are short-lived (matching the existing 15-minute expiry) and are cached per userId. A cached token is reused until near expiry, then a fresh one is minted. Cache invalidation aligns with the existing identity cache invalidation mechanism (FR-012).
