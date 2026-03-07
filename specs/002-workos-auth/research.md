# Research: WorkOS Authentication (Port from cxs2)

This feature ports cxs2/FraiOS authentication to Synmetrix. The cxs2 implementation is the source of truth — this document records only the **adaptations** needed because Synmetrix uses Express + Vite SPA instead of Next.js.

## cxs2 Source Files (Port From)

| cxs2 Source | Purpose | Synmetrix Target |
|-------------|---------|------------------|
| `src/app/api/v1/auth/signin/route.ts` | Sign-in initiation | `services/actions/src/auth/signin.js` |
| `src/app/auth/callback/route.ts` | OAuth callback + session creation | `services/actions/src/auth/callback.js` |
| `src/app/api/v1/auth/token/route.ts` | Token endpoint for frontend | `services/actions/src/auth/token.js` |
| `src/app/api/v1/auth/signout/route.ts` | Sign-out + session destruction | `services/actions/src/auth/signout.js` |
| `src/lib/auth/session.ts` | Redis session CRUD + sliding TTL | `services/actions/src/utils/session.js` |
| `src/lib/services/workos.ts` | WorkOS SDK singleton + helpers | `services/actions/src/utils/workos.js` |
| `src/lib/services/redis.ts` | Redis client | `services/actions/src/utils/redis.js` (existing) |
| `src/lib/services/sync.ts` | JIT sync (user/org provisioning) | `services/actions/src/auth/provision.js` |
| `src/components/auth/LoginForm.tsx` | Login UI (providers + email) | `client-v2/src/components/SignInForm/index.tsx` |
| `src/components/providers/ConvexProvider.tsx` | Token fetching for data layer | `client-v2/src/URQLClient.ts` (authExchange) |
| `.env` | WorkOS secrets | `.env` + `client-v2/.env` |

## Adaptation Decisions

These are the only places where we diverge from cxs2's implementation. Everything else is a direct port.

### Adaptation 1: Next.js Route Handlers → Express Routes

**cxs2**: Uses Next.js App Router `route.ts` files with `NextRequest`/`NextResponse`.
**Synmetrix**: Port to Express route handlers with `req`/`res`. The WorkOS SDK calls (`@workos-inc/node`) are identical — only the HTTP framework wrapper changes.

**Where**: Actions service (`services/actions/index.js`), which is already Express on port 3000 — the port registered with WorkOS.

### Adaptation 2: authkit-nextjs → Direct SDK Calls

**cxs2**: Uses `@workos-inc/authkit-nextjs` for `handleAuth()`, `getSignInUrl()`, `refreshSession()`, `withAuth()`. These wrap `@workos-inc/node` with Next.js middleware coupling.
**Synmetrix**: Use `@workos-inc/node` directly. The underlying SDK calls are:
- `workos.userManagement.getAuthorizationUrl()` (replaces `getSignInUrl()`)
- `workos.userManagement.authenticateWithCode()` (replaces `handleAuth({ onSuccess })`)
- `workos.userManagement.authenticateWithRefreshToken()` (replaces `refreshSession()`)
- `workos.userManagement.revokeSession()` / `getLogoutUrl()` (same as cxs2)

### Adaptation 3: Convex JIT Sync → PostgreSQL/Hasura JIT Provisioning

**cxs2**: `performJITSync()` in `src/lib/services/sync.ts` creates/updates users and organizations in Convex.
**Synmetrix**: Port the same logic but target PostgreSQL via Hasura admin GraphQL (`fetchGraphQL()` with admin secret). Creates records in `public.users`, `auth.accounts`, `public.teams` (by email domain), `public.members`, `public.member_roles`.

### Adaptation 4: Convex Token → Hasura JWT (with TTL fix)

**cxs2**: `/api/v1/auth/token` returns the WorkOS `accessToken` for Convex auth.
**Synmetrix**: `/auth/token` mints a Hasura-compatible JWT using the existing `generateUserAccessToken(userId)` utility in `services/actions/src/utils/jwt.js`. This preserves the JWT claim structure (`hasura` namespace with `x-hasura-user-id`) so Hasura RLS, CubeJS `checkAuth.js`, and the URQL authExchange all continue working unchanged.

**JWT TTL bug fix**: The existing `jwt.js` uses `.setExpirationTime(`${JWT_EXPIRES_IN}m`)` where `JWT_EXPIRES_IN=10800` from `.env.example`. The `m` suffix in jose means **minutes**, so 10800m = 7.5 days. This MUST be changed to `JWT_EXPIRES_IN=15` (15 minutes). Short JWT TTL is critical because JWTs are not revocable at the Hasura/CubeJS layer — after sign-out, a leaked JWT remains valid until expiry.

### Adaptation 5: ConvexProvider Token Fetch → URQL authExchange

**cxs2**: `ConvexProvider.tsx` fetches tokens via `GET /api/v1/auth/token` and passes them to `ConvexProviderWithAuth`.
**Synmetrix**: The URQL `authExchange` in `URQLClient.ts` fetches tokens via `GET /auth/token` and attaches them as `Authorization: Bearer {jwt}` headers. Same pattern, different data layer client.

### Adaptation 6: WorkOS Middleware → Express Cookie Parsing

**cxs2**: `authkitMiddleware` in `src/proxy.ts` handles sealed WorkOS cookies and route protection.
**Synmetrix**: Express `cookie-parser` middleware reads the `session` cookie. Route protection is handled by the frontend (redirect to `/signin` when `/auth/token` returns 401).

### Adaptation 7: Consumer Domain Tenant Isolation

**cxs2**: Not applicable (cxs2 uses WorkOS Organizations, not email-domain-based teams).
**Synmetrix**: Email domain is used to auto-assign teams. Consumer domains (gmail.com, outlook.com, hotmail.com, yahoo.com, icloud.com, aol.com, protonmail.com) must NOT create shared teams — all gmail.com users would end up in the same tenant, violating multi-tenancy isolation. Instead, users with consumer emails get a personal workspace (team named after their full email address).

### Adaptation 8: WorkOS User ID Persistence

**cxs2**: Stores WorkOS user ID in Convex `users` table for identity linkage.
**Synmetrix**: Add `workos_user_id` column to `auth.accounts`. JIT provisioning looks up by `workos_user_id` first, falling back to email. This prevents identity breakage if a user changes their email in WorkOS.

### Adaptation 9: Schema Migration for Team Uniqueness

**cxs2**: Not applicable (cxs2 uses Convex with different schema).
**Synmetrix**: The existing `public.teams` table has `UNIQUE (user_id, name)` but NOT `UNIQUE (name)`. This means multiple teams named "example.com" can exist (created by different users). Add a `UNIQUE (name)` constraint via Hasura migration to prevent duplicate domain-based teams.

## No Adaptation Needed (Direct Port)

These cxs2 patterns port directly with no changes beyond syntax:

- **Redis session storage**: Key format `session:{sessionId}`, TTL 86400s, sliding window via `redis.expire()` — port from `src/lib/auth/session.ts`
- **Session data shape**: Same fields (sessionId, workosSessionId, userId, accessToken, refreshToken, user object) — port from `src/lib/auth/session.ts`
- **Sign-out flow**: Revoke WorkOS session, delete Redis key, clear cookie, optional `revoke_all` — port from `src/app/api/v1/auth/signout/route.ts`
- **Redirect URL validation**: Allowlist check before redirecting after auth — port from `src/app/api/v1/auth/signin/route.ts`
- **Error codes**: `session_expired`, `access_denied`, `callback_failed`, `unauthorized` — port from `src/lib/auth/errors.ts`
- **LoginForm UI**: Provider buttons (Google, GitHub, LinkedIn) + email/SSO input — port from `src/components/auth/LoginForm.tsx`
- **WorkOS SDK singleton**: Lazy-initialized `WorkOS` instance — port from `src/lib/services/workos.ts`

## Environment Variables (Moved from cxs2)

These values are copied directly from `cxs2/.env` to Synmetrix `.env`:

| Variable | Source | Notes |
|----------|--------|-------|
| `WORKOS_API_KEY` | cxs2 `.env` | Same WorkOS account |
| `WORKOS_CLIENT_ID` | cxs2 `.env` | Same WorkOS account |
| `WORKOS_REDIRECT_URI` | Set to `http://localhost:3000/auth/callback` | Updated for Synmetrix Actions service |
| `REDIS_URL` | New | `redis://redis:6379` in Docker |

Note: `WORKOS_COOKIE_PASSWORD` from cxs2 is NOT needed. cxs2 uses it for `authkit-nextjs` sealed cookies. Synmetrix uses plain session ID cookies with server-side Redis storage — the session ID is opaque and the actual session data lives in Redis.
