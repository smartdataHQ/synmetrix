# Tasks: Query with WorkOS JWT

**Input**: Design documents from `/specs/007-workos-jwt-query/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cubejs-auth.md
**Dependency**: T010 assumes `session.workosAccessToken` is populated by the 002-workos-auth feature (WorkOS login flow stores the access token in the Actions session). Verify this exists before starting Phase 3.

**Organization**: Tasks are grouped by user story. US4 (JIT Provisioning) and US5 (Caching) are prerequisites for US1 (Query with WorkOS JWT), so they are in the Foundational phase. Per Constitution §III, test stubs are written before implementation within each phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: Add dependencies, environment configuration, and verify prerequisites.

- [x] T001 Add `jose` dependency to `services/cubejs/package.json` and run `npm install`
- [x] T002 [P] Add `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` environment variables to `docker-compose.dev.yml` for the cubejs service (reference existing values from `.env`)
- [x] T003 [P] Add `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` to `.env.example` with placeholder values
- [ ] T003a [P] [FR-016] Verify required database indexes exist by querying `pg_indexes` for: (1) unique index on `auth_accounts.workos_user_id`, (2) composite index on `members(user_id, team_id)`, (3) unique index on `teams.name`. If any are missing, create a Hasura migration to add them.
- [ ] T003b [P] Verify deployment prerequisites: (1) Confirm WorkOS JWT template is configured to include `partition` claim (check a sample token or WorkOS dashboard). Document the required JWT template configuration in `quickstart.md`. (2) Confirm `WORKOS_ISSUER` is documented as optional env var for custom domain deployments. (3) Verify `session.workosAccessToken` is populated by 002-workos-auth: run `curl /auth/token` with a valid session cookie and confirm `workosAccessToken` is present in the response — if not, the Phase 3 frontend tasks are blocked.

**Checkpoint**: CubeJS service has jose available, WorkOS env vars configured, required indexes verified, and deployment prerequisites documented.

---

## Phase 2: Foundational — Token Verification & Identity Resolution (US4 + US5)

**Purpose**: Core dual-token verification, identity mapping cache, JIT provisioning, and user scope caching. These are blocking prerequisites — US1 and US3 cannot work without them.

**CRITICAL**: No user story work can begin until this phase is complete.

**TDD Approach (Constitution §III)**: For each module, write a StepCI test stub first (expected to fail), then implement until the test passes.

### Step 1: Tests First — Write Failing Test Stubs

- [ ] T004a [P] Create StepCI test for WorkOS JWT verification in `tests/stepci/workos-auth.yml`: send a valid WorkOS JWT to `/api/v1/load` and assert 200 response. Send an expired token and assert 403 with `TokenExpiredError`. Send a token with invalid signature and assert 403. **Expected: FAIL (no WorkOS verification path exists yet).**
- [ ] T004b [P] Create StepCI test for HS256 backward compatibility in `tests/stepci/hasura-jwt-compat.yml`: mint an HS256 JWT inside the actions container and query `/api/v1/load`, assert 200 response with valid data. **Expected: PASS (existing path unchanged).**
- [ ] T004c [P] Create StepCI test for JIT provisioning in `tests/stepci/jit-provision.yml`: send a WorkOS JWT for a user with no `auth_accounts` record, assert 200 response, then query Postgres to verify user, account, team, and membership were created. **Expected: FAIL (no provisioning path exists yet).**
- [ ] T004d [P] Create StepCI test for identity cache behavior in `tests/stepci/workos-cache.yml`: send two identical WorkOS JWT queries in quick succession, assert both return 200, and verify (via logs or timing) that the second query skipped DB lookup. **Expected: FAIL.**

### Step 2: WorkOS Token Verification (make T004a pass)

- [x] T005 Create WorkOS JWKS verifier module in `services/cubejs/src/utils/workosAuth.js`: export a `verifyWorkOSToken(token)` function that uses `jose.createRemoteJWKSet()` with the JWKS URL derived from `WORKOS_CLIENT_ID` (support custom issuer via optional `WORKOS_ISSUER` env var for custom domain deployments), verifies with `algorithms: ["RS256"]`, issuer validation, and `audience: WORKOS_CLIENT_ID` (prevents tokens issued for a different WorkOS application from being accepted), and returns the decoded payload. Also export a `detectTokenType(token)` function that decodes the JWT header (without verification) and returns `"workos"` for RS256 or `"hasura"` for HS256. Include structured error handling: throw errors with a `status` property (403 for expired/invalid signature, 503 for JWKS fetch failure) so the Express error handler returns the correct HTTP status — errors MUST NOT bubble up as generic 500s (FR-018). Log provisioning errors but don't expose internal details to the client.

### Step 3: Identity Mapping Cache (US5) + JIT Provisioning Helpers (US4)

These three tasks modify different functions and can run in parallel:

- [x] T006 [P] [US5] Add identity mapping cache to `services/cubejs/src/utils/dataSourceHelpers.js`: create a new `workosSubCache` Map with 5-minute TTL and 1000 max entries, following the same pattern as the existing `userCache`. Export `getWorkosSubCacheEntry(sub)`, `setWorkosSubCacheEntry(sub, userId)`, and `invalidateWorkosSubCache(sub)` functions.

- [x] T007 [P] [US4] Add identity resolution functions to `services/cubejs/src/utils/dataSourceHelpers.js`: (1) `findAccountByWorkosId(workosUserId)` — GraphQL query to `auth_accounts(where: {workos_user_id: {_eq: $workosUserId}})` returning `{id, user_id, email, workos_user_id}`. (2) `findAccountByEmail(email)` — GraphQL query to `auth_accounts(where: {email: {_eq: $email}})` returning `{id, user_id, email, workos_user_id}`. (3) `backfillWorkosId(accountId, workosUserId)` — GraphQL mutation to set `workos_user_id` on an existing account. **Why all three**: Pre-existing users who logged in before 002-workos-auth may have accounts without `workos_user_id` set. The resolution chain must be: workos_user_id lookup → email lookup → backfill workos_user_id (matching the Actions provisioning pattern in `services/actions/src/auth/provision.js:184-196`). Uses admin-secret auth via the existing `fetchGraphQL` utility.

- [x] T008 [P] [US4] Add `fetchWorkOSUserProfile(workosUserId)` function to `services/cubejs/src/utils/workosAuth.js`: direct HTTP fetch to `https://api.workos.com/user_management/users/${workosUserId}` with `Authorization: Bearer ${WORKOS_API_KEY}`. Returns `{email, firstName, lastName, profilePictureUrl}`. Use email as display name if firstName and lastName are both null. Handle API errors: timeout (5s), 404 (user not found → throw with `status: 404`), 5xx (service unavailable → throw with `status: 503`) per FR-018. All thrown errors must include a `status` property for the error mapper.

### Step 4: JIT Provisioning Orchestrator (US4) — make T004c pass

- [x] T009 [US4] Add `provisionUserFromWorkOS(workosPayload)` function to `services/cubejs/src/utils/dataSourceHelpers.js`: accepts the verified WorkOS JWT payload. **Identity resolution chain** (must match `services/actions/src/auth/provision.js:184-196`): (1) check identity cache for `payload.sub`, (2) call `findAccountByWorkosId(payload.sub)`, (3) if not found, call `fetchWorkOSUserProfile(payload.sub)` to get email, then `findAccountByEmail(email)`, (4) if email match found but `workos_user_id` is null, call `backfillWorkosId(accountId, payload.sub)` and use the existing user, (5) if no account found at all, create user, account, team, membership, and member role. **Team derivation**: reuse the same `deriveTeamName(email, partition)` logic from `services/actions/src/auth/provision.js` (partition takes priority, email-domain is fallback). Add a cross-reference comment in both files: `// NOTE: team derivation logic duplicated in services/{actions,cubejs} — keep in sync`. Replicate the same helper functions (`findTeamByName`, `createTeam`, `createMember`, `createMemberRole`). **Idempotency (FR-009)**: ALL mutations MUST use upsert/on-conflict semantics — `createAccount` with `on_conflict: {constraint: accounts_email_key}`, `createTeam` with `on_conflict: {constraint: teams_name_unique}`, `createMember` with `on_conflict: {constraint: members_user_id_team_id_key}`, `createMemberRole` with `on_conflict: {constraint: member_roles_member_id_team_role_key}`. Note: the Actions provisioning currently only uses `on_conflict` for `createMember` — CubeJS must be more thorough because it handles concurrent first-queries without session serialization. Also: `findTeamByName` MUST use `_eq` (not `_ilike`) with pre-normalized (lowered, trimmed) input so the `teams_name_unique` index is used efficiently. Handle the "account exists but membership missing" case for retry-safety after partial failures. On ANY provisioning failure, do NOT cache the `sub → userId` mapping — throw with appropriate `status` property and let the next request retry the full chain (FR-013). Caches the `sub → userId` mapping ONLY on full success. Returns `userId`. **Rollback**: These functions are inert until imported by `checkAuth.js` (T010). If provisioning creates bad data, clean up via Hasura console; FR-013 prevents caching of partial state so the next request retries.

### Step 5: Dual-Path checkAuth (US1 + US2) — make T004a + T004d pass

- [x] T010 Update `services/cubejs/src/utils/checkAuth.js` to support dual-token verification: import `detectTokenType` and `verifyWorkOSToken` from `workosAuth.js`, import `getWorkosSubCacheEntry`, `setWorkosSubCacheEntry`, `findAccountByWorkosId`, `findAccountByEmail`, `backfillWorkosId`, and `provisionUserFromWorkOS` from `dataSourceHelpers.js`. In the `checkAuth` function, after extracting `authToken`, call `detectTokenType(authToken)`. If `"workos"`: verify with `verifyWorkOSToken()`, resolve `userId` via cache → DB (workos_user_id → email fallback → backfill) → provision chain, then continue to `findUser(userId)` and `defineUserScope()` as before. If `"hasura"`: keep the existing `jwt.verify()` path unchanged. Both paths set `req.securityContext` with the same shape. Update `checkAuthMiddleware` error handler: if `err.status` is set, use it as the HTTP status code; otherwise default to 500. **Also update the global error handler** in `services/cubejs/index.js:104`: change `res.status(500).send(err.message)` to `res.status(err.status || 500).send(err.message)` — the current handler always returns 500 regardless of the error's `status` property, which would defeat all the structured error handling in `workosAuth.js` and `dataSourceHelpers.js` (FR-018). **Rollback**: This is the critical integration point. If issues arise, revert to the pre-change `checkAuth.js` — the HS256-only path is the safe fallback. The `workosAuth.js` and `dataSourceHelpers.js` additions are inert without `checkAuth.js` importing them.

### Step 6: Verify All Phase 2 Tests Pass

- [ ] T010a Run all StepCI tests from Step 1 (T004a-T004d) and confirm they pass. Fix any failures before proceeding.

**Checkpoint**: CubeJS accepts both WorkOS RS256 and Hasura HS256 tokens. New users are provisioned on first query. Cached users resolve with zero DB lookups. All tests green.

---

## Phase 3: User Story 1 — Query Analytics Using WorkOS Session Token (Priority: P1) MVP

**Goal**: Users query the analytics service directly with their WorkOS JWT from the frontend.

**Independent Test**: Sign in via WorkOS, navigate to Explore, run a query — data returns using the WorkOS token.

**Prerequisite**: Verify that `session.workosAccessToken` is populated by the 002-workos-auth feature before starting this phase.

### Backend: Token Endpoint

- [x] T011 [US1] Update `services/actions/src/auth/token.js`: add `workosAccessToken: session.workosAccessToken` to the JSON response object in both the refresh path (line 75) and the default path (line 99). **Note**: The refresh path currently refreshes the WorkOS token and stores it in the session but never returns it to the client — this is a functional gap, not just a new field. **Rollback**: Remove the `workosAccessToken` field from the response — frontend falls back to existing `accessToken`.

### Frontend: Store & Use WorkOS Token

- [x] T012 [US1] Update `../client-v2/src/hooks/useAuth.ts`: extend the `TokenResponse` type to include `workosAccessToken?: string`. Pass it through in `fetchToken()` return value.

- [x] T013 [US1] (depends on T012) Update `../client-v2/src/stores/AuthTokensStore.ts`: add `workosAccessToken: string | null` to the store state, initialize to `null`, set it from `authData.workosAccessToken` in `setAuthData()`, and clear it in `cleanTokens()`.

- [x] T014 [P] [US1] Update `../client-v2/src/components/RestAPI/index.tsx`: import `workosAccessToken` from `AuthTokensStore()` (line 63). Change the `token` default value from `Bearer ${accessToken}` to `Bearer ${workosAccessToken || accessToken}` (line 77). This sends the WorkOS JWT to CubeJS when available, falling back to the Hasura JWT.

- [x] T015 [P] [US1] Update `../client-v2/src/components/SmartGeneration/index.tsx`: wherever `AuthTokensStore.getState().accessToken` is used for CubeJS `/api/v1/*` fetch calls, change to prefer `workosAccessToken` with fallback: `const token = AuthTokensStore.getState().workosAccessToken || AuthTokensStore.getState().accessToken`.

- [x] T015a [US1] [FR-019] Audit all CubeJS API call sites in client-v2: run `grep -rn '/api/v1/\|cubejsApi\|cubejs.*fetch\|cubeApi' ../client-v2/src/` to produce a complete list of call sites. Update any components beyond RestAPI and SmartGeneration to prefer `workosAccessToken` with `accessToken` fallback. **Done when**: every `/api/v1/*` fetch in client-v2 uses `workosAccessToken || accessToken`, and the grep results are documented in the PR description.

**Checkpoint**: User Story 1 complete. Users can query CubeJS with WorkOS JWT from the Explore page. Existing Hasura JWT flow still works as fallback.

---

## Phase 4: User Story 2 — Backward Compatibility (Priority: P1)

**Goal**: Existing intermediary tokens continue to work for Hasura Actions and service-to-service calls.

**Independent Test**: Run a query via GraphQL (`fetch_dataset` mutation) — the Hasura Action path still works.

- [ ] T016 [US2] Verify backward compatibility: no code changes needed (the dual-path in T010 preserves the HS256 path). Create a manual test script or curl command in `tests/test-backward-compat.sh` that mints a Hasura JWT inside the actions container and queries CubeJS to confirm it still works.

**Checkpoint**: Both token paths verified working.

---

## Phase 5: User Story 3 — Query via SQL API Using WorkOS Token (Priority: P2)

**Goal**: SQL API (MySQL/PG wire protocol) accepts WorkOS JWT as password, with datasource specified via username.

**Independent Test**: Connect via `psql` or `mysql` CLI using a datasource ID as username and WorkOS JWT as password, run a SQL query.

### Test First (Constitution §III)

- [ ] T016a [US3] Create StepCI test for SQL API WorkOS auth in `tests/stepci/sql-api-workos.yml`: **Note**: StepCI tests are HTTP-based and cannot directly test MySQL/PG wire protocol authentication. This test covers the `/api/v1/cubesql` HTTP endpoint. Wire protocol auth must be verified manually via `psql`/`mysql` CLI (see quickstart.md). connect to the SQL API (MySQL or PG wire protocol) using a datasource ID as the username and a valid WorkOS JWT as the password, run a simple query, and assert success. Also test: expired JWT as password (assert auth error), valid JWT but unauthorized datasource ID (assert auth error), invalid JWT that looks like a JWT (assert fail-closed — NOT legacy credential fallback). **Expected: FAIL (no SQL API WorkOS path exists yet).**

### Implementation

- [x] T017 [US3] Update `services/cubejs/src/utils/checkSqlAuth.js`: add a WorkOS JWT detection path. The `checkSqlAuth(_, user)` function receives `user` as an object with `username` and `password` properties (or a string depending on the Cube.js SQL API interface — verify the actual signature first). Detect if the password looks like a JWT (contains two dots and header decodes as RS256 via `detectTokenType()`). If JWT detected: verify with `verifyWorkOSToken(password)`. **On verification failure: fail closed** — throw an auth error, do NOT fall through to `findSqlCredentials`. On success: resolve `userId` via the cache → DB → provision chain from `dataSourceHelpers.js`, call `findUser(userId)` to get datasources and members, use `username` as the `datasourceId` to select the specific datasource from the user's accessible datasources, verify the user has access to that datasource (member of the owning team), build the security context via `defineUserScope(dataSources, members, datasourceId)`, and return `{ password, securityContext }`. If the username doesn't match any accessible datasource, throw with `status: 403`. If password is NOT a JWT, fall through to the existing `findSqlCredentials(username)` path unchanged.

**Checkpoint**: SQL API accepts WorkOS tokens as passwords with datasource selection via username. Fail-closed on JWT verification failure. All T016a tests pass.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Error mapping, cache invalidation integration, environment config, performance verification.

- [ ] T017a [FR-018] Verify error mapping end-to-end: confirm that all auth/provisioning errors from `workosAuth.js` and `dataSourceHelpers.js` include a `status` property, and that `checkAuthMiddleware`, `checkSqlAuth`, and the global error handler (updated in T010) propagate it as the HTTP status code. Extend the StepCI test in `tests/stepci/workos-auth.yml` (from T004a) to assert: expired token → 403 (not 500), JWKS unreachable → 503 (not 500), missing datasource header → 400 (not 500). Also add a `status` property to existing error throws in `checkAuth.js` (e.g., "Provide Hasura Authorization token" → `status: 403`, "No x-hasura-datasource-id" → `status: 400`, user not found → `status: 404`). Fix any errors that bubble as 500.

- [x] T018 Extend the internal cache invalidation endpoint in `services/cubejs/src/routes/index.js`: add support for `type: "workos"` in the `/api/v1/internal/invalidate-cache` handler that calls `invalidateWorkosSubCache()` to clear the identity mapping cache. Also clear the workos sub cache when `type: "all"` is received.

- [x] T019 [P] Add `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` environment variables to `docker-compose.stage.yml` and `docker-compose.test.yml` for the cubejs service (`docker-compose.dev.yml` already handled in T002).

- [ ] T020 [P] [SC-003] Performance verification: run two queries with the same WorkOS JWT in quick succession. Measure that the second (cached) query's auth overhead is <5ms compared to the existing HS256 path (per SC-003). Document results.

- [ ] T021 Run quickstart.md validation: execute all test scenarios from `specs/007-workos-jwt-query/quickstart.md` and verify they pass.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (jose dependency). BLOCKS all user stories. Tests written first per §III.
- **US1 (Phase 3)**: Depends on Phase 2 (dual-path checkAuth must exist). Verify 002-workos-auth session prerequisite.
- **US2 (Phase 4)**: Depends on Phase 2 (can run in parallel with US1)
- **US3 (Phase 5)**: Depends on Phase 2 (can run in parallel with US1 and US2)
- **Polish (Phase 6)**: Depends on Phases 3-5

### User Story Dependencies

- **US4 + US5 (Provisioning + Caching)**: In Foundational phase — completed first
- **US1 (Query with WorkOS JWT)**: Depends on Foundational. Backend changes in Phase 2, frontend in Phase 3.
- **US2 (Backward Compatibility)**: Depends on Foundational. Verification only — no code changes.
- **US3 (SQL API)**: Depends on Foundational. Independent of US1 frontend changes.

### Within Phase 2 (Foundational)

```
Step 1: T004a-T004d (test stubs — all parallel, expected to fail)
Step 2: T005 (JWKS verifier — makes T004a partially pass)
Step 3: T006, T007, T008 (cache + helpers — all parallel)
Step 4: T009 (provisioning orchestrator — makes T004c pass)
Step 5: T010 (checkAuth dual-path — makes T004a + T004d fully pass)
Step 6: T010a (verify all tests green)
```

### Parallel Opportunities

```
Phase 1: T002, T003, T003a, T003b can run in parallel
Phase 2 Step 1: T004a, T004b, T004c, T004d can run in parallel
Phase 2 Step 3: T006, T007, T008 can run in parallel (different files/functions)
Phase 3: T014 and T015 can run in parallel (different frontend components)
Phase 5: T016a must complete before T017 (TDD)
Phases 3, 4, 5: US1 frontend, US2 verification, US3 SQL API can run in parallel
Phase 6: T017a, T018, T019, T020 can run in parallel
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (T001-T003a) — includes index verification
2. Complete Phase 2: Foundational (T004a-T010a) — tests first, then implementation, then verify
3. Complete Phase 3: US1 frontend (T011-T015a)
4. **STOP and VALIDATE**: Query CubeJS with WorkOS JWT from the Explore page
5. Deploy if ready — backward compat is inherent in the dual-path design

### Incremental Delivery

1. Setup + Foundational → CubeJS accepts WorkOS JWTs (backend MVP, tests green)
2. Add US1 frontend → Full end-to-end flow working
3. Add US2 verification → Confidence in backward compatibility
4. Add US3 SQL API → Advanced users can connect BI tools
5. Polish → Cache invalidation, environment config, performance verification

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US4 (JIT Provisioning) and US5 (Caching) are in Phase 2 because they are prerequisites for US1
- No new database migrations expected — indexes verified in T003a (create migration if missing)
- The `workosAuth.js` file is new; all other files are modifications to existing code
- WorkOS API is only called once per user lifetime *in the CubeJS query path* (during first-ever query provisioning). The Actions login flow independently reconciles user data on every login.
- CubeJS provisioning duplicates `deriveTeamName()` and helper functions from `services/actions/src/auth/provision.js`. Both implementations must stay in sync — cross-reference comments are required (T009).
- All errors from auth/provisioning must include a `status` property for correct HTTP status codes (FR-018, T017a).
- `partition` claim requires a WorkOS JWT template configuration — this is a deployment prerequisite verified in T003b, not an automatic token feature.
- Commit after each task or logical group
- Phase 3 depends on 002-workos-auth having populated `session.workosAccessToken` in the Actions service — verified in T003b
