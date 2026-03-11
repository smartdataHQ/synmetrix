# Research: Query with WorkOS JWT

**Branch**: `007-workos-jwt-query` | **Date**: 2026-03-10

## Decision 1: Token Verification Method

**Decision**: Use `jose.createRemoteJWKSet()` for WorkOS RS256 token verification, with dual-path auth supporting both WorkOS and existing HS256 tokens.

**Rationale**:
- WorkOS JWTs are RS256-signed; the JWKS endpoint is `https://api.workos.com/sso/jwks/{WORKOS_CLIENT_ID}`
- `jose` already exists in the Actions service (`^4.11.2`) but NOT in CubeJS — needs adding
- `createRemoteJWKSet()` handles key caching, rotation, and cooldown automatically (30s cooldown, configurable cache max age)
- Token type detection: WorkOS tokens use RS256 (header `alg: "RS256"`), existing tokens use HS256. Can distinguish by decoding the header without verifying first.

**Alternatives considered**:
- Shared symmetric key (WorkOS doesn't support this — tokens are always RS256)
- Proxy all CubeJS requests through Actions (unnecessary latency, Actions already has WorkOS SDK but CubeJS is the auth point)

## Decision 2: User Resolution from WorkOS JWT

**Decision**: Extract `sub` claim from verified WorkOS JWT → look up `auth_accounts.workos_user_id` → get `user_id` (Postgres UUID). Cache the `sub → user_id` mapping separately from the existing user scope cache.

**Rationale**:
- `accounts_workos_user_id_unique` index already exists — O(1) lookup
- The existing `findUser()` already caches by `userId` (30s TTL, 500 max). Adding a `sub → userId` mapping cache avoids the DB lookup entirely on the happy path
- WorkOS JWT claims available: `sub` (user ID), `partition` (team name), `org_id`, `role`, `roles`, `permissions`, `sid`, `exp`, `iat`
- No `email` in the JWT — email must be fetched from WorkOS API for new user provisioning

**Alternatives considered**:
- Store WorkOS sub in a separate column on `users` table (unnecessary — `auth_accounts.workos_user_id` already exists)
- Use `org_id` for team lookup (partition is more specific and already used in provisioning)

## Decision 3: JIT Provisioning at CubeJS Layer

**Decision**: When `workos_user_id` lookup returns no result, call `workos.userManagement.getUser(sub)` to get email/name, then run the same provisioning logic as `callback.js` (create user → account → team → membership).

**Rationale**:
- `partition` claim is always present in the JWT — team derivation is guaranteed without email
- Email is needed for `createAccount` (DB constraint: `proper_email` CHECK, and email is used as display name fallback)
- WorkOS API call: `GET /user_management/users/{user_id}` — returns `{ email, firstName, lastName, profilePictureUrl }`
- This call happens once per user lifetime (then cached). Requires `WORKOS_API_KEY` env var in CubeJS service
- The `@workos-inc/node` SDK is in Actions but NOT in CubeJS. For simplicity, use direct HTTP fetch rather than adding the full SDK

**Alternatives considered**:
- Add `@workos-inc/node` SDK to CubeJS (heavier dependency for a single API call)
- Require users to log in via web UI first (breaks the "first query works" requirement)
- Store email in a new JWT claim (requires WorkOS config change, makes token larger)

## Decision 4: Caching Architecture

**Decision**: Three-layer in-memory caching with consistent TTL and size limits.

| Cache Layer | Key | Value | TTL | Max Size |
|---|---|---|---|---|
| JWKS keys | kid | Public key | Auto-managed by jose | N/A |
| Identity mapping | WorkOS `sub` | Postgres `user_id` | 5 min | 1000 |
| User scope | Postgres `user_id` | `{ dataSources, members }` | 30s (existing) | 500 (existing) |

**Rationale**:
- Layer 1 (JWKS): Handled by `jose.createRemoteJWKSet()` — no custom code needed
- Layer 2 (Identity mapping): Longer TTL (5 min) because `sub → user_id` mapping is immutable after provisioning. Higher max size because it's lightweight (two strings)
- Layer 3 (User scope): Keep existing 30s TTL — permission changes need to propagate reasonably fast
- Happy path (all cached): JWKS verify (in-memory key) → identity cache hit → user scope cache hit → zero DB queries, zero API calls

**Alternatives considered**:
- Redis for identity mapping (overkill for string → string mapping; adds network hop)
- Single unified cache (different TTL needs make this awkward)
- Longer user scope TTL (30s is already a reasonable balance between performance and freshness)

## Decision 5: Frontend Token Flow

**Decision**: Return `workosAccessToken` alongside `accessToken` from `/auth/token` endpoint. Frontend stores both in `AuthTokensStore`. Use WorkOS token for CubeJS REST calls, keep Hasura JWT for GraphQL.

**Rationale**:
- Currently WorkOS token stays in Redis, never reaches the browser
- `/auth/token` handler already has access to `session.workosAccessToken` and handles refresh
- Only 3 frontend files need changes: `AuthTokensStore.ts`, `RestAPI/index.tsx`, `SmartGeneration/index.tsx`
- `URQLClient.ts` continues using Hasura JWT for GraphQL (Hasura doesn't need to change)

**Alternatives considered**:
- Send WorkOS token in a separate cookie (more complex, CORS implications)
- Have CubeJS accept the Hasura JWT and look up WorkOS user internally (defeats the purpose — still need the minted JWT)

## Decision 6: Database Indexes

**Decision**: No new indexes needed. All required indexes exist.

**Verified indexes**:
- `accounts_workos_user_id_unique` — primary lookup for identity resolution
- `accounts_email_key` — email uniqueness during provisioning
- `members_user_id_team_id_key` — composite index, leading column `user_id` used by `findUser()`
- `teams_name_unique` — team lookup by name during provisioning
- `member_roles_member_id_team_role_key` — role lookup

## Decision 7: WorkOS API Key in CubeJS

**Decision**: Add `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` environment variables to the CubeJS service. Use direct `fetch()` for the single WorkOS API call rather than adding the full SDK.

**Rationale**:
- Only one API call needed: `GET /user_management/users/{sub}`
- Full `@workos-inc/node` SDK adds ~2MB of dependencies for one HTTP request
- Direct fetch with `Authorization: Bearer ${WORKOS_API_KEY}` is simpler and lighter
- `WORKOS_CLIENT_ID` needed for JWKS URL construction

**Alternatives considered**:
- Import WorkOS SDK (heavier, more maintenance)
- Call Actions service to fetch user profile (adds latency and coupling)
