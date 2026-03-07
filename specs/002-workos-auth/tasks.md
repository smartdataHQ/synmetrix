# Tasks: WorkOS Authentication (Port from cxs2)

**Input**: Design documents from `/specs/002-workos-auth/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/auth-api.md

**Tests**: Constitution Principle III (TDD) requires tests before implementation. Playwright for browser-based auth flows (OAuth redirects, session cookies). StepCI for API contract tests on `/auth/*` endpoints. Vitest for client-v2 unit tests.

**Organization**: Tasks grouped by user story. Each cxs2 source file is referenced in the task description so the implementer knows exactly what to port.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths and cxs2 source references in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Environment configuration, dependencies, Docker infrastructure, and schema migrations needed before any auth code can be written.

- [X] T001 Add WorkOS env vars to `.env.example` with placeholder values: `WORKOS_API_KEY=<your-workos-api-key>`, `WORKOS_CLIENT_ID=<your-workos-client-id>`, `WORKOS_REDIRECT_URI=http://localhost:3000/auth/callback`. Change `JWT_EXPIRES_IN` from `10800` to `15` in `.env.example` (fixes 7.5-day JWT TTL bug — see contracts/auth-api.md). Add `REDIS_URL` to `.dev.env.example` with value `redis://redis:6379`. Then copy real secrets from `../cxs2/.env` into `.env` and `.dev.env` (gitignored, never committed). Add `ALLOWED_RETURN_TO_HOSTS=localhost` to `.env.example` for redirect URL validation
- [X] T002 Add Redis service to `docker-compose.dev.yml`. Expose Actions service port 3000 to host (add `ports: ["3000:3000"]`). Ensure Redis is on the `synmetrix_default` network
- [X] T003 [P] Add `@workos-inc/node` ^8.4.0 and `cookie-parser` to `services/actions/package.json`. Run `yarn install`
- [X] T004 [P] Update Vite proxy in `../client-v2/vite.config.ts`: change `/auth` proxy target from `http://localhost:8081` to `http://localhost:3000`. Remove `VITE_GRAPHQL_PLUS_SERVER_URL` from `../client-v2/.env`
- [X] T005 [P] Create Hasura migration to add `workos_user_id` column and fix team uniqueness. Migration up: `ALTER TABLE auth.accounts ADD COLUMN workos_user_id text; ALTER TABLE auth.accounts ADD CONSTRAINT accounts_workos_user_id_unique UNIQUE (workos_user_id);` and `ALTER TABLE public.teams DROP CONSTRAINT IF EXISTS teams_user_id_name_key; ALTER TABLE public.teams ADD CONSTRAINT teams_name_unique UNIQUE (name);`. Migration down: reverse both. Place in `services/hasura/migrations/default/` with next sequential directory number

**Checkpoint**: Docker services start with Redis, Actions exposed on port 3000, WorkOS env vars available, Vite proxies to Actions, schema migrations applied.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core utilities ported from cxs2 that ALL auth routes depend on. MUST complete before any user story.

**CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 Port WorkOS SDK singleton to `services/actions/src/utils/workos.js`. Source: `cxs2/src/lib/services/workos.ts`. Adapt: use `import { WorkOS } from '@workos-inc/node'`, lazy-init with `WORKOS_API_KEY`. Port helper functions: `listUserSessions()`, `revokeSessionsById()`, `revokeAllUserSessions()`, `fetchOrganizationById()`
- [X] T007 [P] Port Redis session CRUD to `services/actions/src/utils/session.js`. Source: `cxs2/src/lib/auth/session.ts`. Port: `createSession(sessionId, data)` -> `redis.setex('session:${id}', 86400, JSON.stringify(data))`, `getSession(sessionId)` -> `redis.get()` + `JSON.parse()`, `deleteSession(sessionId)` -> `redis.del()`, `extendSession(sessionId)` -> `redis.expire(id, 86400)`. Adapt session shape per `data-model.md` (use Synmetrix fields: `userId` as PostgreSQL UUID, `teamId`, `accessToken` as Hasura JWT, `workosAccessToken`)
- [X] T008 [P] Verify existing `services/actions/src/utils/redis.js` connects using `REDIS_URL` env var. If it uses `REDIS_ADDR`, update to support `REDIS_URL` (matching cxs2's `redis://host:port` format). Ensure connection is exported for use by session.js
- [X] T009 Add `cookie-parser` middleware to `services/actions/index.js`. Create `services/actions/src/auth/` directory (new, deliberately separate from `src/rpc/` which handles Hasura action RPC). Add auth route imports and register `GET /auth/signin`, `GET /auth/callback`, `GET /auth/token`, `POST /auth/signout` BEFORE the existing `POST /rpc/:method` catch-all

**Checkpoint**: Foundation ready -- WorkOS client, Redis sessions, cookie parsing, and route registration all in place. Auth handlers can now be implemented.

---

## Phase 3: User Story 1 -- Sign In via WorkOS (Priority: P1) MVP

**Goal**: A user can sign in via WorkOS (Google, GitHub, LinkedIn, email/SSO) and land in the application with a valid session that allows GraphQL requests.

**Independent Test**: Navigate to `/signin`, click a provider, complete WorkOS auth, verify redirect back to app. Check that `/auth/token` returns a valid JWT and GraphQL queries succeed.

### Tests for User Story 1

> **Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T010 [P] [US1] Create StepCI API contract tests for auth endpoints in `tests/auth-api.stepci.yml`. Test: `GET /auth/signin` returns 302 redirect to WorkOS URL. Test: `GET /auth/token` without session cookie returns 401 `{"error": true, "code": "unauthorized"}`. Test: `POST /auth/signout` without session cookie returns 401. Test: `GET /auth/callback` without `code` param returns 302 redirect to `/signin?error=callback_failed`. Reference contract: `specs/002-workos-auth/contracts/auth-api.md`
- [ ] T011 [P] [US1] Create Playwright test file for sign-in flow at `../client-v2/tests/e2e/auth-signin.spec.ts`. Tests: (1) unauthenticated user visiting `/` is redirected to sign-in page, (2) clicking a provider button navigates to WorkOS URL, (3) after successful auth callback, user lands on the app with a valid session. Note: the full OAuth flow through WorkOS requires a real browser -- the user will help with interactive Playwright testing

### Implementation for User Story 1

- [X] T012 [US1] Port sign-in route to `services/actions/src/auth/signin.js`. Source: `cxs2/src/app/api/v1/auth/signin/route.ts`. Adapt: `NextRequest` -> Express `req`, `NextResponse.redirect` -> `res.redirect()`. Core logic: read `provider`, `email`, `return_to` from `req.query`, call `workos.userManagement.getAuthorizationUrl({ clientId, redirectUri, provider, loginHint, state })`, redirect to returned URL. Port redirect URL validation from cxs2: read `ALLOWED_RETURN_TO_HOSTS` env var, validate `return_to` hostname against allowlist before including in state
- [X] T013 [US1] Create JIT provisioning module at `services/actions/src/auth/provision.js`. Source: `cxs2/src/lib/services/sync.ts` (`performJITSync()`). Adapt for PostgreSQL: use `fetchGraphQL()` with admin secret. **Lookup order**: (1) query `auth.accounts` by `workos_user_id` (primary), (2) fallback to query by `email` (for pre-existing accounts without `workos_user_id` -- backfill `workos_user_id` on match). **Existing user path**: look up `users.id` via `accounts.user_id`, query `members` to find their team, return `{ userId, teamId }`. **New user path**: (1) insert `public.users` with `display_name` from WorkOS `user.firstName + lastName` and `avatar_url` from `user.profilePictureUrl`, (2) insert `auth.accounts` with `email`, `workos_user_id`, `active=true`, `default_role='user'`, (3) extract email domain, (4) check consumer domain blocklist (gmail.com, outlook.com, hotmail.com, yahoo.com, icloud.com, aol.com, protonmail.com) -- if consumer: use full email as team name (personal workspace), else use domain, (5) query `public.teams` by name, (6) if no team: insert team with `name`, `user_id=new_user_id`, (7) insert `public.members`, (8) insert `public.member_roles` with `team_role='owner'` (if created team) or `'member'`. **Edge case**: if user exists but has no team membership (orphan), assign to team by email domain. Return `{ userId, teamId }`
- [X] T014 [US1] Port callback route to `services/actions/src/auth/callback.js`. Source: `cxs2/src/app/auth/callback/route.ts`. Adapt: replace `handleAuth({ onSuccess })` with direct `workos.userManagement.authenticateWithCode({ clientId, code: req.query.code })`. On success: call `provision.js` for JIT provisioning, mint Hasura JWT via existing `generateUserAccessToken(userId)`, extract session ID via `jose.decodeJwt(accessToken).sid`, create Redis session via `createSession()`, set HTTP-only `session` cookie (`res.cookie('session', sid, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 86400000 })`), redirect to `returnTo` from state or default URL (`/explore` based on client-v2 routing). On error: redirect to `/signin?error=callback_failed`
- [X] T015 [US1] Port token route to `services/actions/src/auth/token.js`. Source: `cxs2/src/app/api/v1/auth/token/route.ts`. Read `session` cookie from `req.cookies`, call `getSession(sid)`, if no session return 401. If WorkOS access token expired (< 60s): call `workos.userManagement.authenticateWithRefreshToken({ clientId, refreshToken })`, update session in Redis, mint fresh Hasura JWT via `generateUserAccessToken(userId)`. Call `extendSession(sid)` fire-and-forget on every successful request (sliding window TTL -- this is the ONLY place session TTL is extended). Return `{ accessToken, userId, role: 'user' }`. Set `Cache-Control: no-store`
- [X] T016 [US1] Rewrite `../client-v2/src/hooks/useAuth.ts`. Remove `login()`, `register()`, `changePass()`, `sendMagicLink()`, `fetchRefreshToken()`. Add: `signIn(provider?)` -> `window.location.href = '/auth/signin' + (provider ? '?provider=' + provider : '')`, `signOut()` -> `POST /auth/signout` then clear store and redirect to `/signin`, `fetchToken()` -> `GET /auth/token` returns `{ accessToken, userId, role }`
- [X] T017 [US1] Simplify `../client-v2/src/stores/AuthTokensStore.ts`. Remove `refreshToken`, remove `localStorage` persistence. Store only `accessToken` and `JWTpayload` (decoded from accessToken) in memory. Keep `setAuthData()` (now takes just `accessToken`) and `cleanTokens()`. JWT decoding logic stays the same (extract `hasura` claims)
- [X] T018 [US1] Update `../client-v2/src/URQLClient.ts` authExchange. Source pattern: `cxs2/src/components/providers/ConvexProvider.tsx` (token fetching). Change `getAuth`: call `GET /auth/token`, store result in `AuthTokensStore`, return token. Change `willAuthError`: check `JWTpayload.exp` same as before. Change `didAuthError`: check for 401/FORBIDDEN same as before. Change `refreshAuth`: call `GET /auth/token` again (server handles WorkOS refresh). On failure: redirect to `/signin` instead of looping. **IMPORTANT**: Preserve the existing `addAuthToOperation` logic that attaches `Authorization: Bearer {token}`, `x-hasura-role`, and spreads JWT claims as individual headers -- this is how Hasura receives auth context (FR-009)
- [X] T019 [US1] Rewrite `../client-v2/src/components/SignInForm/index.tsx`. Source: `cxs2/src/components/auth/LoginForm.tsx`. Port provider buttons: "Continue with Google" -> `onClick={() => signIn('GoogleOAuth')}`, "Continue with GitHub" -> `signIn('GitHubOAuth')`, "Continue with LinkedIn" -> `signIn('LinkedInOAuth')`. Add email input + "Continue with SSO" button -> `signIn()` with email param. Add "Create Account" link to signup. Use Ant Design components (Button, Input, Space) matching existing client-v2 styling. Include error message display: read `?error=` query param and show user-friendly messages (port error codes from `cxs2/src/lib/auth/errors.ts`: `session_expired`, `access_denied`, `callback_failed`, `unauthorized`)
- [X] T020 [US1] Update `../client-v2/src/pages/SignIn/index.tsx`. Replace email/password form with new `SignInForm` component. Remove magic link toggle. Pass `?error=` and `?returnTo=` query params down to `SignInForm`
- [X] T021 [US1] Add route protection to `../client-v2/src/hooks/useUserData.ts` (or `../client-v2/src/components/UserDataWrapper/index.tsx`). On mount, call `fetchToken()` from `useAuth`. If it returns 401 (no valid session), redirect to `/signin` before rendering any protected content. This ensures unauthenticated users are caught on initial page load, not just after a failed GraphQL request (FR-008)

**Checkpoint**: Full sign-in flow works. User clicks provider -> WorkOS -> callback -> session -> redirect -> token -> GraphQL works. Unauthenticated users are redirected to sign-in. This is the MVP.

---

## Phase 4: User Story 2 -- Sign Out (Priority: P1)

**Goal**: Signed-in user can sign out, terminating their session. Optional "sign out everywhere" revokes all sessions.

**Independent Test**: Sign in, then sign out. Verify `/auth/token` returns 401, protected pages redirect to sign-in. Test `?revoke_all=true` parameter.

**Dependencies**: Requires Phase 3 (US1) sign-in to work first.

### Tests for User Story 2

- [ ] T022 [P] [US2] Add StepCI sign-out contract test to `tests/auth-api.stepci.yml`. Test: `POST /auth/signout` with valid session cookie returns `{"success": true, "redirectTo": "/signin"}`. Test: subsequent `GET /auth/token` with same cookie returns 401
- [ ] T023 [P] [US2] Create Playwright test for sign-out flow at `../client-v2/tests/e2e/auth-signout.spec.ts`. Test: signed-in user clicks "Sign Out", is redirected to sign-in page, and cannot access protected pages

### Implementation for User Story 2

- [X] T024 [US2] Port sign-out route to `services/actions/src/auth/signout.js`. Source: `cxs2/src/app/api/v1/auth/signout/route.ts`. Direct port: read session cookie, get session from Redis, delete Redis session, revoke WorkOS session (`workos.userManagement.revokeSession({ sessionId: session.workosSessionId })`). If `req.query.revoke_all === 'true'`: call `revokeAllUserSessions(session.user.workosId)` instead. Fetch and call `workos.userManagement.getLogoutUrl({ sessionId })`. Clear `session` cookie (`res.clearCookie('session')`). Return `{ success: true, redirectTo: '/signin' }`
- [X] T025 [US2] Update `../client-v2/src/pages/Logout/index.tsx`. Call `useAuth().signOut()` which POSTs to `/auth/signout`, clears `AuthTokensStore`, and redirects to `/signin`. Remove old `logout()` call and `cleanTokens()` logic

**Checkpoint**: Sign-out terminates session. No stale tokens allow continued access (within ~15 min JWT TTL window).

---

## Phase 5: User Story 3 -- Session Persistence and Token Refresh (Priority: P1)

**Goal**: Sessions persist across page refreshes and tabs. Token refresh is automatic. 24-hour sliding window TTL (extended on each token fetch).

**Independent Test**: Sign in, refresh page, verify still authenticated. Wait for JWT to expire, make a request, verify it auto-refreshes. Check that session extends on activity.

**Dependencies**: Requires Phase 3 (US1) for sign-in and Phase 2 for session infrastructure.

### Tests for User Story 3

- [ ] T026 [P] [US3] Create Playwright test for session persistence at `../client-v2/tests/e2e/auth-session.spec.ts`. Test: (1) sign in, (2) reload page, (3) verify user is still authenticated (no redirect to sign-in, GraphQL queries succeed). Test: (1) sign in, (2) clear session cookie manually, (3) verify redirect to sign-in on next navigation

### Implementation for User Story 3

- [X] T027 [US3] Sliding window TTL is already implemented in T015 (`extendSession(sid)` call in token route). Verify it works: after a token request, check Redis TTL has been reset to 86400. No additional backend code needed -- this task is a verification step
- [X] T028 [US3] Update `../client-v2/src/hooks/useUserData.ts`. Ensure token fetch on mount (implemented in T021) also re-validates on window focus (optional, matching cxs2 pattern). If 401: redirect to `/signin`. This ensures session expiry is detected promptly

**Checkpoint**: Sessions survive page refresh. Tokens auto-refresh. Inactive sessions expire after 24 hours without a token fetch.

---

## Phase 6: User Story 4 -- Sign Up and Team Assignment (Priority: P2)

**Goal**: New users can sign up via WorkOS, get JIT-provisioned with a local user record, and auto-assigned to a team by email domain (or personal workspace for consumer emails).

**Independent Test**: Use a new email to sign up via WorkOS. Verify user record created in PostgreSQL, team created/found by email domain, member and member_role records created. Verify consumer email gets personal workspace.

**Dependencies**: Requires Phase 3 (US1) -- sign-up uses the same callback flow, just initiated via WorkOS sign-up URL.

### Tests for User Story 4

- [ ] T029 [P] [US4] Create Playwright test for sign-up flow at `../client-v2/tests/e2e/auth-signup.spec.ts`. Test: clicking "Create Account" on sign-in page navigates to WorkOS sign-up URL. Note: full sign-up + JIT provisioning verified manually with user assistance (requires creating a new WorkOS user)
- [ ] T030 [P] [US4] Create Vitest unit tests for consumer domain blocklist in `../client-v2/tests/unit/` or `services/actions/tests/`. Test: gmail.com/outlook.com/yahoo.com returns personal workspace name (full email). Test: example.com/company.org returns domain as team name

### Implementation for User Story 4

- [X] T031 [US4] Update sign-in route `services/actions/src/auth/signin.js` to support sign-up. Add `signup` query parameter. When `req.query.signup === 'true'`, pass `screenHint: 'sign-up'` to `workos.userManagement.getAuthorizationUrl()` to show WorkOS registration UI instead of login
- [X] T032 [US4] Update `../client-v2/src/pages/SignUp/index.tsx`. Simplify to redirect: `window.location.href = '/auth/signin?signup=true'`. WorkOS handles the registration form. Remove password fields, magic link toggle, privacy checkbox
- [X] T033 [US4] Update `../client-v2/src/components/SignUpForm/index.tsx`. Simplify to a redirect button or remove entirely if SignUp page handles the redirect directly
- [X] T034 [US4] Verify JIT provisioning in `services/actions/src/auth/provision.js` handles team creation correctly: query teams by name (email domain or full email for consumer domains), create if not exists with `user_id` set to the new user, assign `team_role='owner'` for team creators and `'member'` for joiners. Verify consumer domain blocklist works. Add error handling for edge cases (invalid email domain, database constraint violations)

**Checkpoint**: New users can register, are provisioned in PostgreSQL, and assigned to the correct team. Consumer email users get personal workspaces. Existing team members see the new user.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, edge cases, and removal of deprecated auth code.

- [X] T035 Remove or simplify `../client-v2/src/pages/Callback/index.tsx`. The callback is now handled server-side by the Actions service. This page can either be removed from routes or converted to a simple "Authenticating..." loading screen (in case the server redirects through it)
- [X] T036 [P] Update `../client-v2/src/utils/constants/paths.ts`. Remove `/userauth/signin`, `/userauth/signup`, `/userauth/logout` paths. Add `/signin`, `/signup`, `/logout`. Update route references throughout the app to use new path constants
- [X] T037 [P] Update route configuration in `../client-v2/config/routes.ts` (or equivalent router config). Update auth route paths to match new pages. Ensure `/signin` and `/signup` are public routes (no auth guard). Remove old `/callback` route if Callback page was removed
- [X] T038 [P] Update `services/client/nginx/default.conf.template`. Change `/auth` proxy target from `http://synmetrix-hasura:8080` to the Actions service (e.g., `http://synmetrix-actions:3000`). This fixes a pre-existing bug where `/auth` was incorrectly proxying to Hasura instead of hasura-backend-plus
- [ ] T039 Run quickstart.md verification checklist end-to-end: sign in, GraphQL queries work, page refresh preserves session, sign out clears session, new user sign-up creates user + team, consumer email gets personal workspace. Run all Playwright tests. Run StepCI tests

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies -- can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion -- BLOCKS all user stories
- **US1 Sign In (Phase 3)**: Depends on Phase 2 -- this is the MVP. Tests first (T010-T011), then implementation (T012-T021)
- **US2 Sign Out (Phase 4)**: Depends on Phase 3 (needs sign-in to test sign-out)
- **US3 Session Persistence (Phase 5)**: Depends on Phase 3 (needs sign-in for session to exist)
- **US4 Sign Up (Phase 6)**: Depends on Phase 3 (uses same callback flow)
- **Polish (Phase 7)**: Depends on Phases 3-6

### User Story Dependencies

- **US1 (Sign In)**: Standalone after Foundational. MVP milestone.
- **US2 (Sign Out)**: Requires US1 (must be signed in to test sign out). Can run in parallel with US3/US4.
- **US3 (Session Persistence)**: Requires US1 (must be signed in to test persistence). Can run in parallel with US2/US4.
- **US4 (Sign Up)**: Requires US1 callback route (sign-up uses same flow). Can run in parallel with US2/US3.

### Within Each User Story

- **Tests FIRST** -- write StepCI/Playwright tests, ensure they FAIL
- Backend routes before frontend pages (frontend needs endpoints to call)
- Provisioning module before callback route (callback calls provisioning)
- Auth store changes before URQL client changes (URQL reads from store)
- **Then verify tests PASS** after implementation

### Parallel Opportunities

**Phase 1** (all independent files):
- T003 (Actions package.json) || T004 (Vite config) || T005 (Hasura migration)

**Phase 2** (independent utility modules):
- T006 (workos.js) || T007 (session.js) || T008 (redis.js)

**Phase 3 tests** (independent test files):
- T010 (StepCI contract tests) || T011 (Playwright sign-in tests)

**Phase 3 backend** (partially parallel):
- T012 (signin.js) || T013 (provision.js) -- different files, no deps
- Then T014 (callback.js) depends on both

**Phase 3 frontend** (partially parallel):
- T016 (useAuth.ts) || T017 (AuthTokensStore.ts) -- different files

**Phase 4-6** stories can proceed in parallel once US1 (Phase 3) is done.

**Phase 7** cleanup tasks are mostly independent:
- T036 (paths.ts) || T037 (routes.ts) || T038 (nginx.conf)

---

## Parallel Example: Phase 3 Tests (Write First, Must Fail)

```bash
# Launch test scaffolds in parallel:
Task T010: "StepCI contract tests for auth endpoints in tests/auth-api.stepci.yml"
Task T011: "Playwright sign-in flow test in ../client-v2/tests/e2e/auth-signin.spec.ts"
# These tests MUST fail (no implementation yet) -- Red phase of TDD
```

## Parallel Example: Phase 3 Backend Implementation

```bash
# Launch signin + provisioning in parallel (different files, no deps):
Task T012: "Port sign-in route to services/actions/src/auth/signin.js"
Task T013: "Create JIT provisioning module at services/actions/src/auth/provision.js"

# Then callback depends on both:
Task T014: "Port callback route to services/actions/src/auth/callback.js" (depends on T012, T013)

# Then token route:
Task T015: "Port token route to services/actions/src/auth/token.js"
# After backend routes are up: StepCI tests from T010 should now PASS -- Green phase
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T005)
2. Complete Phase 2: Foundational (T006-T009)
3. Write US1 tests (T010-T011) -- must FAIL
4. Complete Phase 3: User Story 1 implementation (T012-T021) -- tests should PASS
5. **STOP and VALIDATE**: Run StepCI + Playwright tests, verify full sign-in flow
6. If sign-in works: MVP is done. Ship it.

### Incremental Delivery

1. Setup + Foundational -> Infrastructure ready
2. US1 tests (FAIL) -> US1 implementation -> Tests PASS -> **MVP shipped**
3. US2 tests (FAIL) -> US2 implementation -> Tests PASS -> Sign-in + sign-out complete
4. US3 tests (FAIL) -> US3 implementation -> Tests PASS -> Production-ready auth
5. US4 tests (FAIL) -> US4 implementation -> Tests PASS -> Full feature complete
6. Polish -> Cleanup deprecated code, fix nginx, run full verification

---

## Notes

- Every backend task references its cxs2 source file. When implementing, READ the cxs2 source first, then adapt.
- The existing `services/actions/src/utils/jwt.js` already has `generateUserAccessToken(userId)` -- do NOT rewrite this, but DO fix `JWT_EXPIRES_IN` from 10800 to 15 in `.env.example` (T001).
- The existing `services/actions/src/utils/graphql.js` already has `fetchGraphQL()` with admin secret support -- use this for JIT provisioning.
- The existing `services/actions/src/utils/redis.js` already has an ioredis connection -- verify it works with `REDIS_URL` and reuse it.
- The `src/auth/` directory is new and deliberately separate from `src/rpc/` (Hasura action RPC handlers). Auth routes are standard Express GET/POST handlers, not Hasura action proxies.
- hasura-backend-plus is NOT removed in this feature. It remains in Docker Compose because `inviteTeamMember.js` still uses its magic links. Removal is a separate follow-up task.
- Playwright tests for OAuth flows require a real browser and may need interactive user assistance for the WorkOS login step. Consider using Playwright's `page.pause()` for manual intervention during WorkOS authentication.
- `WORKOS_COOKIE_PASSWORD` from cxs2 is NOT needed -- Synmetrix uses plain session ID cookies with server-side Redis storage, not `authkit-nextjs` sealed cookies.
