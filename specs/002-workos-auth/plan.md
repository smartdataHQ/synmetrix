# Implementation Plan: WorkOS Authentication (Port from cxs2)

**Branch**: `002-workos-auth` | **Date**: 2026-03-07 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-workos-auth/spec.md`

## Summary

Port cxs2/FraiOS WorkOS authentication to Synmetrix. The cxs2 auth implementation is the source code to port from — this plan documents only the adaptations required because Synmetrix uses Express + Vite SPA instead of Next.js + Convex. Auth routes are ported from cxs2's Next.js API routes to Express handlers in the Actions service (port 3000). Redis session management is ported verbatim. The non-trivial adaptations are: (1) Synmetrix mints short-lived Hasura-compatible JWTs (~15 min) instead of passing WorkOS tokens to Convex, (2) JIT provisioning targets PostgreSQL/Hasura instead of Convex, (3) consumer email domains get personal workspaces instead of shared teams, and (4) a `workos_user_id` column is added for stable identity linkage.

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 18
**Primary Dependencies**: `@workos-inc/node` ^8.4.0 (same as cxs2), `ioredis` (existing), `express` ^4.17.1 (existing), `jsonwebtoken` (existing), `jose` (existing)
**Storage**: PostgreSQL (existing, via Hasura), Redis (new, for sessions — ported from cxs2)
**Testing**: StepCI (API contract tests), Playwright (browser-based E2E auth flows), Vitest (client-v2 unit tests)
**Target Platform**: Docker (Linux containers), browser SPA
**Project Type**: Web application (microservices backend + SPA frontend)
**Performance Goals**: Sign-in flow < 10 seconds end-to-end, token refresh < 200ms
**Constraints**: Must preserve Hasura JWT claim format, must not break existing GraphQL queries
**Scale/Scope**: Changes to 2 services (Actions, Client) + 1 Hasura migration + ~12 frontend files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Research Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Service Isolation | PASS | Auth routes added to Actions service; JWT claim contract preserved; no changes to Hasura or CubeJS services |
| II. Multi-Tenancy First | PASS | JWT claims include `x-hasura-user-id`; team assignment via email domain preserves tenant model; consumer domains get personal workspaces; `defineUserScope.js` and `buildSecurityContext.js` untouched |
| III. Test-Driven Development | PASS | StepCI tests for auth API contracts; Playwright for browser-based auth flows; Vitest for frontend unit tests; tests written before implementation |
| IV. Security by Default | PASS | JWT validation preserved at all entry points; short JWT TTL (~15 min) limits exposure window; HTTP-only session cookies; redirect URL validation; WorkOS handles credential storage; `workos_user_id` prevents identity breakage |
| V. Simplicity / YAGNI | PASS | Reuses existing Actions service, existing JWT utilities, existing Redis dependency; no new microservices |

### Migration Strategy Alignment

| Target | Status | Notes |
|--------|--------|-------|
| WorkOS AuthKit replacing hasura-backend-plus | THIS FEATURE | Priority 1 in migration strategy. Ported from cxs2 (the master blueprint). |
| Incremental migration | PASS | hasura-backend-plus remains in Docker Compose during transition; can be removed once verified. Note: `inviteTeamMember.js` still uses hasura-backend-plus magic links — that is out of scope for this feature. |
| System remains deployable | PASS | Each change leaves system functional; JWT format unchanged |
| cxs2 pattern referenced | PASS | Every file maps to a specific cxs2 source file (see Source Code Porting Map below) |

### Post-Design Re-Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Service Isolation | PASS | New `/auth/*` routes are self-contained in Actions service; shared contract (JWT claims) unchanged |
| II. Multi-Tenancy First | PASS | Email domain → team mapping creates proper tenant isolation; consumer domain blocklist prevents tenant collision; team name uniqueness enforced via migration |
| III. Test-Driven Development | PASS | Auth API contract tests (StepCI), browser auth flow tests (Playwright), frontend unit tests (Vitest) |
| IV. Security by Default | PASS | Session cookies are HTTP-only; redirect URLs validated; WorkOS handles PKCE/CSRF; secrets in env vars only; JWT TTL ~15 min; workos_user_id for stable identity |
| V. Simplicity / YAGNI | PASS | No new abstractions; direct Express routes; existing utilities reused |

## Project Structure

### Documentation (this feature)

```text
specs/002-workos-auth/
├── plan.md              # This file
├── research.md          # Adaptation decisions (cxs2 → Synmetrix)
├── data-model.md        # Session model ported from cxs2 + existing Synmetrix DB schema
├── quickstart.md        # Setup and verification guide
├── contracts/
│   └── auth-api.md      # Auth endpoints (mapped to cxs2 source routes)
└── tasks.md             # Implementation tasks (via /speckit.tasks)
```

### Source Code Porting Map

Each new Synmetrix file maps to a specific cxs2 source. The "Adaptation" column describes what changes from a direct port.

#### Backend (services/actions/)

| Synmetrix Target | cxs2 Source | Adaptation |
|------------------|-------------|------------|
| `src/auth/signin.js` | `src/app/api/v1/auth/signin/route.ts` | NextRequest/NextResponse → Express req/res. SDK calls identical. |
| `src/auth/callback.js` | `src/app/auth/callback/route.ts` | Replace `handleAuth({ onSuccess })` with direct `authenticateWithCode()`. Replace Convex JIT sync with PostgreSQL provisioning. Mint Hasura JWT instead of passing WorkOS token. |
| `src/auth/token.js` | `src/app/api/v1/auth/token/route.ts` | Return Hasura JWT (~15 min TTL) instead of WorkOS accessToken. Refresh logic same. Extends Redis session TTL on each call. |
| `src/auth/signout.js` | `src/app/api/v1/auth/signout/route.ts` | Direct port. NextResponse → Express res. |
| `src/auth/provision.js` | `src/lib/services/sync.ts` (`performJITSync()`) | Target PostgreSQL via `fetchGraphQL()` instead of Convex mutations. Create users/accounts/teams/members/member_roles. Lookup by `workos_user_id` first (email fallback). Consumer domain blocklist for personal workspaces. |
| `src/utils/workos.js` | `src/lib/services/workos.ts` | Direct port. Lazy WorkOS singleton + helper functions. |
| `src/utils/session.js` | `src/lib/auth/session.ts` | Direct port of Redis session CRUD. Remove Next.js `cache()` wrapper. Session shape adapted (see data-model.md). |
| `src/utils/redis.js` | `src/lib/services/redis.ts` | Already exists in Actions service. May need `REDIS_URL` env var update. |
| `src/utils/jwt.js` | N/A (already exists) | Fix `JWT_EXPIRES_IN` from 10800 to 15 (minutes). Existing `generateUserAccessToken(userId)` mints Hasura JWTs. |
| `index.js` | N/A | Add `GET /auth/signin`, `GET /auth/callback`, `GET /auth/token`, `POST /auth/signout` routes before the RPC catch-all. Add `cookie-parser` middleware. |
| `package.json` | N/A | Add `@workos-inc/node` ^8.4.0, `cookie-parser`. |

#### Database (services/hasura/migrations/)

| Synmetrix Target | cxs2 Source | Adaptation |
|------------------|-------------|------------|
| New migration: add `workos_user_id` to `auth.accounts` | N/A (Synmetrix-specific) | `ALTER TABLE auth.accounts ADD COLUMN workos_user_id text UNIQUE`. JIT provisioning looks up by this column first. |
| New migration: team name uniqueness | N/A (Synmetrix-specific) | `ALTER TABLE public.teams ADD CONSTRAINT teams_name_unique UNIQUE (name)`. Prevents duplicate domain-based teams. |

#### Frontend (client-v2/)

| Synmetrix Target | cxs2 Source | Adaptation |
|------------------|-------------|------------|
| `src/components/SignInForm/index.tsx` | `src/components/auth/LoginForm.tsx` | Port provider buttons (Google, GitHub, LinkedIn) + email input. Replace Next.js `useRouter` with React Router navigation. Links point to `/auth/signin?provider=X`. |
| `src/pages/SignIn/index.tsx` | `src/app/login/page.tsx` | Port layout. Replace Next.js page with React Router page. |
| `src/pages/SignUp/index.tsx` | N/A | Simplify to redirect: `window.location.href = '/auth/signin'` (WorkOS handles signup). |
| `src/pages/Logout/index.tsx` | N/A | Call `POST /auth/signout`, clear local state, redirect to `/signin`. |
| `src/pages/Callback/index.tsx` | N/A | Remove or simplify — callback handled server-side by Actions service. May keep as landing page that reads session cookie and fetches token. |
| `src/hooks/useAuth.ts` | N/A | Rewrite: `signIn()` redirects to `/auth/signin`. `signOut()` calls `POST /auth/signout`. `fetchToken()` calls `GET /auth/token`. No more login/register/changePass/magicLink. |
| `src/stores/AuthTokensStore.ts` | N/A | Simplify: store `accessToken` (from `/auth/token`) and decoded `JWTpayload` in memory. Remove `refreshToken` and localStorage persistence. |
| `src/URQLClient.ts` | `src/components/providers/ConvexProvider.tsx` (token fetching pattern) | Port token-fetching pattern: `authExchange.getAuth` calls `GET /auth/token`. On 401, redirect to `/signin`. Same concept as ConvexProvider's `fetchAccessToken`. |
| `vite.config.ts` | N/A | Change `/auth` proxy from `http://localhost:8081` to `http://localhost:3000`. |
| `.env` | N/A | Remove `VITE_GRAPHQL_PLUS_SERVER_URL`. |

#### Infrastructure

| Synmetrix Target | cxs2 Source | Adaptation |
|------------------|-------------|------------|
| `docker-compose.dev.yml` | N/A | Add Redis service. Expose Actions port 3000 to host. |
| `.env.example` | `cxs2/.env` | Copy `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`. Set `WORKOS_REDIRECT_URI=http://localhost:3000/auth/callback`. Add `REDIS_URL`. Change `JWT_EXPIRES_IN` to 15. |
| `.dev.env.example` | N/A | Add `REDIS_URL=redis://redis:6379`. |

**Structure Decision**: This is a porting operation into the existing monorepo. No new services or projects created. Auth routes added to the existing Actions service. Frontend changes isolated to auth-related files in client-v2.

## Compatibility Notes

### hasura-backend-plus Coexistence

hasura-backend-plus is NOT removed in this feature. It remains in Docker Compose because:
- `inviteTeamMember.js` (in `services/actions/src/rpc/`) uses hasura-backend-plus magic links for team invitations
- Removing that dependency is a separate follow-up task
- SC-006 scope is narrowed to: "no longer required for login/logout authentication"

### JWT Revocation Gap

JWTs minted by `generateUserAccessToken()` are not revocable at the Hasura/CubeJS layer. After sign-out:
- The Redis session is destroyed (no new JWTs can be minted)
- Any previously-issued JWT remains valid until its ~15 min TTL expires
- This is an acceptable trade-off given the short TTL
- CubeJS `checkAuth.js` only verifies JWT signature — it does NOT check Redis session state

### Sliding TTL Behavior

Only `GET /auth/token` extends the Redis session TTL. GraphQL requests go directly to Hasura (port 8080) and bypass the Actions service entirely. The session stays alive because:
- The URQL `authExchange` calls `GET /auth/token` every ~15 minutes (before JWT expiry)
- Each token fetch extends the session TTL to 24 hours
- If the user closes all tabs and doesn't return for 24 hours, the session expires

## Complexity Tracking

No constitution violations to justify. All changes use existing services, existing patterns, and existing dependencies. The porting approach minimizes design risk by following a proven implementation. Schema migrations are minimal (one new column, one new constraint).
