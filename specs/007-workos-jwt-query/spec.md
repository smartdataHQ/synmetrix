# Feature Specification: Query with WorkOS JWT

**Feature Branch**: `007-workos-jwt-query`
**Created**: 2026-03-10
**Status**: Draft
**Input**: User description: "Query with WorkOS JWT"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Query Analytics Using WorkOS Session Token (Priority: P1)

A signed-in user navigates to the Explore page, selects a datasource, builds a query (choosing dimensions, measures, filters), and runs it. The analytics service accepts the user's existing WorkOS session token to authenticate and authorize the query, without requiring a separate intermediary token to be minted.

**Why this priority**: This is the core feature. Today the system mints an intermediary token for every session refresh, adding latency and a point of failure. Accepting the WorkOS token directly simplifies the auth chain and removes token-minting as a bottleneck.

**Independent Test**: Can be tested by signing in via WorkOS, navigating to Explore, running a query, and confirming data returns successfully using only the WorkOS-issued credential.

**Acceptance Scenarios**:

1. **Given** a user is signed in via WorkOS and has a valid session, **When** they run a query on the Explore page, **Then** the analytics service authenticates the request using the WorkOS token and returns query results.
2. **Given** a user is signed in via WorkOS and has a valid session, **When** they view the REST API panel in the Explore page, **Then** the displayed bearer token is the WorkOS token and it can be used to query the analytics endpoint directly (e.g., via curl).
3. **Given** a user's WorkOS token has expired, **When** they run a query, **Then** the system refreshes the token transparently and the query succeeds without user intervention.

---

### User Story 2 - Backward Compatibility with Existing Token (Priority: P1)

The analytics service continues to accept the existing intermediary tokens so that internal service-to-service calls (e.g., Hasura Actions calling the analytics service) and any external integrations that use the current token format continue to work without disruption.

**Why this priority**: Breaking internal service communication would cause a system-wide outage. Both token types must be accepted simultaneously.

**Independent Test**: Can be tested by issuing a query through the existing Hasura Action path (e.g., `fetch_dataset` via GraphQL) and confirming it still works after the change.

**Acceptance Scenarios**:

1. **Given** a Hasura Action forwards a request with the existing intermediary token, **When** the analytics service receives it, **Then** it authenticates successfully and returns results.
2. **Given** a user or system sends a request with either token type, **When** the analytics service receives it, **Then** it correctly identifies the token type and validates it accordingly.

---

### User Story 3 - Query via SQL API Using WorkOS Token (Priority: P2)

A user connects to the SQL API (MySQL or PostgreSQL wire protocol) and authenticates using their WorkOS token as the password and a datasource identifier as the username. The system verifies the token, resolves the specified datasource, and grants access if the user has permission.

**Why this priority**: The SQL API is a secondary access method used by advanced users and BI tools. It should support the same authentication but is not on the critical path for most users.

**Independent Test**: Can be tested by connecting via a MySQL or PostgreSQL client using a datasource ID as the username and the WorkOS token as the password, then running a SQL query.

**Acceptance Scenarios**:

1. **Given** a user has a valid WorkOS token, **When** they connect to the SQL API using a datasource ID as the username and the WorkOS token as the password, **Then** they are authenticated and can run queries against that specific datasource.
2. **Given** a user has an expired WorkOS token, **When** they attempt to connect to the SQL API, **Then** they receive a clear authentication error.
3. **Given** a user provides a JWT-shaped password that fails verification, **When** the SQL API detects it as a JWT, **Then** it rejects the connection with an authentication error (fail-closed) — it does NOT fall through to legacy credential lookup.
4. **Given** a user provides a datasource ID they do not have access to, **When** they connect to the SQL API, **Then** they receive an authorization error.

---

---

### User Story 4 - First Query Automatically Provisions User (Priority: P1)

A user who has authenticated via the identity provider but has never queried the analytics service before sends their first query. The system recognizes the token is valid, finds no matching platform user, and automatically provisions the user, their team (derived from the token's organization/partition claim), and their team membership — then executes the query. This happens transparently; the user simply sees their query results.

**Why this priority**: Without JIT provisioning at the analytics layer, new users would get "user not found" errors on their first query, breaking the experience entirely. This is a prerequisite for User Story 1 to work for any user who hasn't previously logged in through the web UI.

**Independent Test**: Can be tested by creating a new user in the identity provider, obtaining a token, and sending a query directly to the analytics REST API without first visiting the web UI. The query should succeed and the user/team/membership should exist in the database afterward.

**Acceptance Scenarios**:

1. **Given** a valid identity-provider token for a user with no platform account, **When** they send a query to the analytics service, **Then** the system fetches the user's email from the identity provider API, creates the user, account, team (derived from the token's partition claim), and membership, then returns query results.
2. **Given** a valid identity-provider token for a user who has a platform account but no membership in the organization's team, **When** they send a query, **Then** the system creates the missing membership and returns query results.
3. **Given** a valid identity-provider token for a user who already has full provisioning, **When** they send a query, **Then** the system resolves the user from cache (no database lookups on the happy path) and returns query results with no additional overhead.
4. **Given** two users from the same organization query for the first time in quick succession, **When** the second user's provisioning attempts to create the same team, **Then** the system handles the duplicate gracefully (finds the existing team) and creates only the membership.

---

### User Story 5 - Cached User Resolution for Subsequent Queries (Priority: P1)

After a user's first query triggers provisioning (or after their identity is resolved on any query), subsequent queries from the same user skip all provisioning lookups and resolve the user from an in-memory cache. The cache has a reasonable time-to-live so that permission changes eventually take effect without requiring a service restart.

**Why this priority**: Without caching, every query would require multiple database roundtrips to resolve the user, their team memberships, and their datasource permissions — adding unacceptable latency to the happy path. The existing system already caches user lookups with a 30-second TTL; this must extend to cover the identity-provider-to-platform-user mapping as well.

**Independent Test**: Can be tested by sending two identical queries in quick succession and verifying (via logs or timing) that the second query does not perform provisioning or identity resolution database lookups.

**Acceptance Scenarios**:

1. **Given** a user has already been resolved (via provisioning or lookup), **When** they send another query within the cache TTL, **Then** the system resolves the user from cache with no database calls for identity mapping.
2. **Given** a user's permissions change (e.g., added to a new team or granted access to a new datasource), **When** the cache TTL expires, **Then** the next query reflects the updated permissions.
3. **Given** the cache reaches its maximum size, **When** a new user queries, **Then** the oldest cache entry is evicted and the new user is resolved and cached.

---

### Edge Cases

- What happens when the identity provider's user management API is temporarily unreachable during new user provisioning? The system returns a clear error and the user can retry; the query is not executed with a partially provisioned user.
- What happens when the identity provider rotates its signing keys? The system fetches the latest keys dynamically rather than caching them indefinitely.
- What happens when the identity provider's key endpoint is temporarily unreachable? The system fails closed (denies access) with a clear error message; it does not fall back to accepting unverified tokens.
- What happens when a token is structurally valid but was issued by a different environment (e.g., staging key used against production)? The system rejects it.
- What happens when provisioning partially fails (e.g., user created but team creation fails)? The system returns a clear error and does not cache the partial state; the next query retries the full provisioning.
- What happens when two concurrent requests for the same unprovisioned user arrive simultaneously? The system handles race conditions gracefully using idempotent operations (e.g., upserts with on-conflict handling) so both requests succeed.
- What happens when a SQL API connection provides a JWT-shaped password that fails verification? The system fails closed and rejects the connection — it does not fall through to legacy credential lookup, preventing an expired/invalid JWT from accidentally matching a stored credential.

## Requirements *(mandatory)*

### Functional Requirements

**Token Verification**

- **FR-001**: The analytics service MUST accept identity-provider-issued tokens as bearer tokens for query authentication on all REST API endpoints.
- **FR-002**: The analytics service MUST continue to accept the existing intermediary tokens for backward compatibility.
- **FR-003**: The system MUST determine which token type was provided and apply the correct verification method for each.
- **FR-004**: The system MUST dynamically fetch and cache the identity provider's signing keys, refreshing them when key rotation occurs. ~~Token verification MUST validate the audience claim matches the expected client ID~~ **NOTE**: WorkOS access tokens do not include an `aud` claim — audience validation is omitted. Issuer validation (`iss: https://api.workos.com/user_management/{CLIENT_ID}`) provides equivalent app-scoping since the issuer contains the client ID.

**JIT User Provisioning**

- **FR-005**: When an identity-provider token is provided and no corresponding platform user exists, the system MUST first attempt to match by subject identifier, then fall back to matching by email (fetched from the identity provider's user management API). If an email match is found with a missing subject identifier, the system MUST backfill the subject identifier on the existing account. If no match is found at all, the system MUST provision the user (account, profile, team, and team membership) before executing the query. This three-step resolution (subject → email → provision) ensures pre-existing users who registered before the identity provider migration are not duplicated.
- **FR-006**: If the identity provider returns no display name (first/last name both absent), the system MUST use the user's email address as the display name.
- **FR-007**: The identity provider API call MUST only occur when provisioning a new user (no existing account match). For all subsequent queries, the cached subject-to-user mapping eliminates any external API calls.
- **FR-008**: Team assignment during provisioning MUST use the token's partition claim to derive the team name. The partition claim is expected to always be present (via JWT template configuration), but the implementation SHOULD include an email-domain fallback for defensive resilience, consistent with the existing `deriveTeamName()` logic in the Actions service.
- **FR-009**: Provisioning MUST use idempotent operations (upserts, on-conflict handling) so that concurrent requests for the same user or team do not cause errors or duplicate records.
- **FR-010**: When an identity-provider token is provided and the platform user already exists, the system MUST resolve the token's subject identifier to the corresponding platform user to enforce datasource permissions and access controls.

**Caching**

- **FR-011**: The system MUST cache the mapping from identity-provider subject identifier to platform user ID, so that subsequent queries from the same user skip both the database lookup and any identity provider API calls.
- **FR-012**: The system MUST cache the resolved user scope (team memberships, datasource access, permissions) with a bounded time-to-live, consistent with the existing user cache behavior.
- **FR-013**: The cache MUST NOT store partial provisioning results; only fully provisioned users are cached.
- **FR-014**: The cache MUST have a maximum size with eviction of oldest entries to prevent unbounded memory growth.
- **FR-015**: On the happy path (cached user), resolving an identity-provider token to a fully authorized user MUST require zero database queries and zero external API calls — only in-memory cache lookups.

**Database Performance**

- **FR-016**: The database MUST have indexes on all columns used in the identity resolution and provisioning lookup paths to ensure identity resolution queries complete in under 10ms at 100K+ accounts. At minimum: unique index on the identity-provider user ID column in the accounts table, composite index on user-team membership, and unique index on team name.

**SQL API & Frontend**

- **FR-017**: The SQL API MUST accept identity-provider tokens as passwords for authentication, using the username field as the datasource identifier, in addition to the existing credential method. When a JWT-shaped password is detected (contains two dots and decodes as RS256), verification failure MUST fail closed — the system MUST NOT fall through to legacy credential lookup.
- **FR-018**: The system MUST return clear, distinguishable error messages for: expired token, invalid signature, provisioning failure, and service unavailable scenarios. HTTP status codes MUST match the error type (400 for bad request, 403 for auth failures, 404 for not found, 503 for upstream service unavailable) — errors MUST NOT bubble up as generic 500s.
- **FR-019**: The frontend MUST send the identity-provider token directly to the analytics service for REST API queries, eliminating the need to mint an intermediary token for this path.

### Key Entities

- **User Session**: Represents an authenticated user's session; contains the identity-provider token, the platform user identifier, and associated team/datasource permissions.
- **Access Token**: A credential used to authenticate analytics queries; can be either an identity-provider-issued token (asymmetric signature, contains subject claim) or an existing intermediary token (symmetric signature, contains platform-specific claims).
- **Signing Key Set**: The set of public keys published by the identity provider used to verify tokens; must be fetched dynamically and cached with appropriate refresh logic.
- **Identity Mapping**: The association between an identity-provider subject identifier and a platform user ID; established during provisioning and cached for fast resolution on the query hot path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can run analytics queries using their session token with no additional authentication steps, and queries return results within the same time as the current flow (no measurable latency increase on cached/happy path).
- **SC-002**: 100% of existing query paths (internal service-to-service calls, GraphQL action forwarding) continue to work without modification after the change is deployed.
- **SC-003**: On the happy path (cached user), token verification and user resolution add less than 5ms of overhead compared to the current verification method (JWKS key is cached in-memory, identity and scope caches hit).
- **SC-004**: A brand-new user's first query completes successfully (including automatic provisioning) without the user needing to visit the web UI first or take any additional steps.
- **SC-005**: A user's second and subsequent queries (within the cache window) resolve with zero database lookups for identity mapping or provisioning checks.
- **SC-006**: The system correctly rejects expired, invalid, or wrong-environment tokens in 100% of cases, with user-friendly error messages.

**Implementation Note**: In this implementation, the identity provider is **WorkOS**. References to "identity-provider" throughout this spec map to WorkOS AuthKit (JWT issuance), WorkOS JWKS (key verification), and WorkOS User Management API (profile fetching).

## Assumptions

- The identity-provider token contains a `sub` claim (unique user identifier). Email is not present in the token. The `partition` claim (team identifier) is included via a **JWT template** configured in the identity provider — this is a deployment prerequisite, not a default token claim.
- The identity provider publishes a standard key-set endpoint for token verification and a user management API for fetching user profiles (email, display name) by subject identifier.
- The identity provider API is only called once per user lifetime *in the CubeJS query path*: when a brand-new user (no matching account) sends their first query. The login flow (Actions service) independently reconciles user data on every login. After CubeJS provisioning, the subject-to-user mapping is cached and no further CubeJS-initiated API calls are needed.
- The existing intermediary token format and signing key will remain unchanged and continue to be used for service-to-service calls.
- The backend session (Redis) already stores the identity-provider token from the login flow. The `/auth/token` endpoint must be updated to return it to the frontend (see FR-019 and the corresponding tasks). No new login flow changes are needed.
- **Security tradeoff**: The identity-provider token is returned to the frontend and stored in JavaScript application state (Zustand store). The identity provider's documentation recommends httpOnly cookie storage. This is an accepted tradeoff: the existing intermediary token already uses the same client-side storage pattern, so this does not expand the attack surface. The token grants no more access than the existing intermediary token it replaces for CubeJS calls.
- Key caching with automatic refresh on verification failure is sufficient; proactive key polling is not required.
- Team derivation uses the token's partition claim as the primary source. The same `deriveTeamName()` logic from the login-time provisioning is reused: partition (when present) takes priority, email-domain is the fallback for tokens without partition. Both provisioning paths (Actions login-time and CubeJS query-time) use this same function to ensure consistency.
- Idempotent database operations (upserts, on-conflict) are available and reliable for handling concurrent provisioning of the same user or team.
- If the identity provider's issuer changes (e.g., due to custom domain configuration), the JWKS URL and issuer validation must be updated as deployment configuration — not hardcoded.

## Scope Boundaries

### In Scope
- Analytics service (REST API and SQL API) accepting identity-provider tokens
- Dual-token verification (identity-provider + existing intermediary)
- JIT user/team/membership provisioning at the analytics layer for new users
- Two-layer caching: identity-provider subject → platform user ID mapping, and platform user → scope/permissions (existing cache)
- User resolution from identity-provider token claims
- Frontend sending identity-provider token directly to analytics endpoints
- Signing key caching and refresh

### Out of Scope
- Changes to the GraphQL API authentication (continues using existing tokens via Hasura)
- Changes to the login/signup flow
- Changes to the existing login-time provisioning logic (it remains as-is; the analytics-layer provisioning is additive)
- Migration away from the intermediary token entirely (it remains for service-to-service use)
