# Implementation Plan: Query with WorkOS JWT

**Branch**: `007-workos-jwt-query` | **Date**: 2026-03-10 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/007-workos-jwt-query/spec.md`

## Summary

Enable the CubeJS analytics service to accept WorkOS JWT tokens directly for query authentication, eliminating the intermediary token-minting step. The system detects the token type (RS256 = WorkOS, HS256 = existing Hasura JWT), verifies accordingly, resolves the user (with JIT provisioning for new users), and caches aggressively so the happy path has zero DB queries and zero external API calls.

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 22
**Primary Dependencies**: `jose` ^6.x (new for CubeJS), `@workos-inc/node` (existing in Actions, NOT added to CubeJS — use direct fetch), `jsonwebtoken` (existing in CubeJS, kept for HS256 path)
**Storage**: PostgreSQL via Hasura GraphQL (existing), In-memory Map caches (existing + new)
**Testing**: StepCI workflow tests (`tests/`), manual curl verification
**Target Platform**: Docker containers (Linux amd64)
**Project Type**: Multi-service web platform (CubeJS service + Actions service + client-v2 frontend)
**Performance Goals**: Happy path (cached user) adds <5ms overhead (SC-003).
**Constraints**: Zero downtime deployment. Both token types must work simultaneously. No breaking changes to existing flows.
**Scale/Scope**: ~15 files changed across 3 projects (including test files and docker-compose variants). No new database migrations (indexes verified to exist from 002-workos-auth).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Service Isolation
- **PASS**: CubeJS learns to verify a new token type independently. No simultaneous deployment required — existing HS256 path continues working. New env vars (`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`) added to CubeJS service only.
- **Contract change**: `/auth/token` response adds `workosAccessToken` field (additive, non-breaking). CubeJS auth contract adds WorkOS JWT as accepted token type (additive).

### II. Multi-Tenancy First
- **PASS**: All queries still flow through `defineUserScope.js` → `buildSecurityContext.js`. The only change is HOW the `userId` is obtained (from WorkOS `sub` instead of Hasura `x-hasura-user-id`). Once resolved, the entire security context pipeline is identical.
- JIT provisioning uses the `partition` claim for team assignment, preserving tenant isolation.

### III. Test-Driven Development
- **PASS**: StepCI tests will cover both token paths. Integration tests for: WorkOS token verification, HS256 backward compatibility, JIT provisioning, cache behavior.

### IV. Security by Default
- **PASS**: JWT validation occurs at every entry point. WorkOS JWKS verification is stricter than shared-key HS256 (asymmetric > symmetric). Algorithm pinning prevents downgrade attacks. `issuer` validation ensures tokens come from the correct WorkOS environment.
- During dual-stack: both paths enforce identical security guarantees through the same `defineUserScope` → `buildSecurityContext` pipeline.

### V. Simplicity / YAGNI
- **PASS**: Direct fetch for WorkOS API (1 call) instead of adding full SDK. Three-layer cache uses same Map pattern as existing code. No new abstractions — just extending `checkAuth.js` with a second verification path.

## Project Structure

### Documentation (this feature)

```text
specs/007-workos-jwt-query/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 research decisions
├── data-model.md        # Entity model and cache architecture
├── quickstart.md        # Testing guide
├── contracts/
│   └── cubejs-auth.md   # Updated auth contract
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
services/cubejs/
├── package.json                          # Add jose dependency
└── src/utils/
    ├── checkAuth.js                      # Dual-path verification + error mapping
    ├── checkSqlAuth.js                   # WorkOS JWT as SQL password (username=datasource, fail-closed)
    ├── workosAuth.js                     # NEW: JWKS verifier, token detection, WorkOS API client
    └── dataSourceHelpers.js              # Identity mapping cache + provisioning helpers

services/actions/
└── src/auth/
    └── token.js                          # Return workosAccessToken in response

../client-v2/
├── src/stores/AuthTokensStore.ts         # Store workosAccessToken
├── src/hooks/useAuth.ts                  # Pass through workosAccessToken
└── src/components/
    ├── RestAPI/index.tsx                  # Use WorkOS token for CubeJS
    └── SmartGeneration/index.tsx          # Use WorkOS token for CubeJS

docker-compose.dev.yml                    # Add WORKOS env vars to cubejs service
```

**Structure Decision**: This feature modifies existing files across three services (CubeJS, Actions, client-v2). No new directories or modules — all changes fit within the existing architecture.

## Complexity Tracking

| Decision | Chosen | Rejected Alternative | Justification |
|----------|--------|---------------------|---------------|
| RS256 verification library | `jose` ^6.x (new dep) | Extend `jsonwebtoken` (existing) | `jsonwebtoken` lacks native JWKS support and `createRemoteJWKSet`. `jose` provides built-in JWKS fetching with automatic key rotation handling — eliminates custom cache/refresh logic. |
| WorkOS API client | Direct `fetch()` | `@workos-inc/node` SDK | SDK adds ~50 dependencies for one API call (`GET /user_management/users/:id`). Direct fetch is simpler and avoids dependency bloat per Constitution §V. |
| SQL API datasource selection | Username = datasource ID | "Pick first datasource" | Multi-datasource users need deterministic datasource selection. Username field is the natural place for this hint, matching the existing pattern where `sql_credentials.username` pins a specific datasource. |
| SQL API JWT fail behavior | Fail-closed on JWT verification failure | Fall through to legacy credentials | Once a JWT is detected, falling through on failure would let an expired/invalid JWT accidentally match a stored credential. Fail-closed is the only secure option per Constitution §IV. |
| CubeJS provisioning logic | Duplicate `deriveTeamName()` from Actions | Shared npm package | Constitution §I requires independent deployability. Duplication is ~50 lines, changes rarely. Cross-reference comments link the two implementations. |
| Identity resolution chain | workos_user_id → email → backfill → provision | workos_user_id → provision (skip email) | Pre-existing users from before 002-workos-auth may have accounts without `workos_user_id`. Skipping email lookup would create duplicate identities. Must match the Actions provisioning chain (`provision.js:184-196`). |
| Team name lookup operator | `_eq` with pre-normalized input | `_ilike` (case-insensitive) | `_ilike` cannot use the `teams_name_unique` index efficiently. Since `deriveTeamName()` already normalizes (lowercase + trim), `_eq` is correct and performant. Note: Actions provisioning uses `_ilike` — this is an intentional improvement. |
| Audience validation | Validate `aud: WORKOS_CLIENT_ID` | No audience check | Without audience validation, a WorkOS token issued for a different application in the same environment would pass verification. One-line addition to `jose.jwtVerify()` options. |
